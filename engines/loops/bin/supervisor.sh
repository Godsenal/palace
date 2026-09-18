#!/bin/zsh
# 프로세스 감독자(1 pass, 2 스코프). 기존 자가복구(watchdog·reaper·self-update)는 전부 dispatch.sh while-루프
# 안에 살아서, 디스패처 자신이 죽으면 플랫폼 전체가 조용히 정지하던 단일 장애점을 이 스크립트가 막는다.
#
# 스코프 (⚠️ cmux 렌더 제약이 스코프를 가른다 — 비 cmux 컨텍스트(launchd)의 직접 spawn은 앱이 렌더 가능할 때만
# materialize되므로, "확실한 spawn 컨텍스트"를 가진 쪽이 각자 맡는다):
#   • full(기본, launchd 60s) — **디스패처만** 감독. 재기동 경로: ① 대시보드가 살아있으면 /api/control start 프록시
#     (대시보드는 materialize된 패널 안이라 spawn이 항상 성공 — 매일 쓰이는 검증된 경로) ② 대시보드도 죽었으면
#     loopctl start 직접(spawn-panel — 앱 렌더 가능 시에만 성공, 실패 시 워크스페이스 폐기 후 다음 패스 재시도).
#   • panels(dispatch.sh housekeeping ≤60s) — **대시보드·봇** 감독. 디스패처의 PTY 컨텍스트에서 spawn하므로 항상
#     즉시 materialize. (디스패처가 의도적으로 꺼져 있으면 패널 힐링도 없음 — 플랫폼 off 상태로 간주, 문서화된 정책.)
#
# 판정 원칙:
#   • "죽음"과 "사용자의 의도적 정지"를 구분한다 — loopctl stop / 대시보드 stop은 state/STOPPED.<comp> 마커를 남기고,
#     마커가 있으면 그 컴포넌트는 감독 대상에서 제외(사용자 의도 존중). start 경로가 마커를 지운다.
#   • cmux 미응답(앱 꺼짐)이면 패널 재기동이 불가능 → 알림만 하고 종료(전 컴포넌트가 cmux 패널이므로).
#   • 대시보드가 "프로세스는 있는데 HTTP 미응답"이면 hung 가능성 — watchdog의 wedged 철학대로 kill 없이 표면화만.
#   • crash-loop 가드: 한 컴포넌트가 LOOPS_CRASHLOOP_WINDOW(600s) 안에 LOOPS_CRASHLOOP_N(3)회째 죽으면 —
#       디스패처 한정, 직전 self-update(LOOPS_ROLLBACK_WINDOW=3600s 내)가 원인으로 추정되고 HEAD가 그 커밋이면
#       `git reset --keep <직전sha>` 로컬 롤백(--keep = 미커밋 변경 보존, force-push 아님·origin 불변) 후
#       state/.update_hold에 bad sha 기록 → self-update.sh가 같은 커밋 재당김을 보류. origin에 수정이 올라오면 자동 해제.
#       롤백 불가(최근 업데이트 없음/HEAD 불일치/--keep 거부)면 재기동을 LOOPS_CRASHLOOP_COOLDOWN(1800s) 중단하고 escalate.
#   • 모든 액션은 state/supervisor-events.jsonl에 기록 — incident-bridge가 escalate/rollback을 Linear 이슈로 발제한다.
#   • 알림은 tg-notify.mjs 직송(봇 프로세스 비경유 — 봇이 감시 대상이므로), 같은 키는 LOOPS_NOTIFY_MIN_GAP(1800s) 간격 제한.
# 안전: 머지/배포/force-push 없음. 재기동은 loopctl·대시보드와 동일 경로(단일 원천). 롤백은 로컬 브랜치 포인터 이동뿐.
# usage: supervisor.sh [full|panels]   (full: launchd·`loopctl supervisor run` / panels: dispatch.sh가 호출)
set -u
source "${0:A:h}/_common.sh"
SCOPE="${1:-full}"
ROOT="$LOOPS_HOME"; STATE=$ROOT/state
SUP="$STATE/supervisor.json"; EVENTS="$STATE/supervisor-events.jsonl"
mkdir -p "$STATE"
PORT="${LOOPS_PORT:-8422}"
CRASH_N=${LOOPS_CRASHLOOP_N:-3}
CRASH_WIN=${LOOPS_CRASHLOOP_WINDOW:-600}
CRASH_COOL=${LOOPS_CRASHLOOP_COOLDOWN:-1800}
RB_WIN=${LOOPS_ROLLBACK_WINDOW:-3600}
NOTIFY_GAP=${LOOPS_NOTIFY_MIN_GAP:-1800}
now=$(date +%s)

# 동시 실행 방지(launchd는 겹치지 않지만 `loopctl supervisor run` 수동 실행과의 경합) — run-once와 같은 PID-aware lock.
LOCKDIR=/tmp/loops-supervisor.lockdir
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  owner="$(cat "$LOCKDIR/owner.pid" 2>/dev/null)"
  if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then exit 0; fi
  rm -rf "$LOCKDIR" 2>/dev/null; mkdir "$LOCKDIR" 2>/dev/null || exit 0
fi
echo $$ > "$LOCKDIR/owner.pid"
trap 'rm -rf "$LOCKDIR" 2>/dev/null' EXIT

# ── supervisor.json 헬퍼 (watchdog liveness.json과 동일 패턴: 원자적 read-modify-write, 파싱 실패는 빈 객체 복구) ──
sv_get(){ node -e 'const fs=require("fs"),[f,p]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}const v=p.split(".").reduce((a,k)=>a&&a[k],o);process.stdout.write(v==null?"":String(v))' "$SUP" "$1"; }
sv_merge(){ node -e 'const fs=require("fs"),[f,k,p]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}o[k]=Object.assign({},o[k]||{},JSON.parse(p));fs.writeFileSync(f,JSON.stringify(o))' "$SUP" "$1" "$2"; }
# 윈도 내 재기동 횟수 조회 / 재기동 기록(윈도 밖은 prune).
sv_restarts(){ node -e 'const fs=require("fs"),[f,c,now,win]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}process.stdout.write(String(((o[c]||{}).restarts||[]).filter(t=>+now-t<+win).length))' "$SUP" "$1" "$now" "$CRASH_WIN"; }
sv_record(){ node -e 'const fs=require("fs"),[f,c,now,win]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}const e=o[c]=o[c]||{};e.restarts=((e.restarts||[]).filter(t=>+now-t<+win*3)).concat(+now);fs.writeFileSync(f,JSON.stringify(o))' "$SUP" "$1" "$now" "$CRASH_WIN"; }

event(){ print -r -- "{\"ts\":$now,\"type\":\"$1\",\"comp\":\"$2\",\"note\":\"$3\"}" >> "$EVENTS"; }

# 패널 spawn은 전부 loopctl 경유(→ bin/spawn-panel.sh) — 비 cmux 컨텍스트(launchd)에서의 lazy-PTY 함정
# (커맨드가 허공에 사라지거나 지연 실행 → 이중 기동)은 spawn-panel이 materialize 검증·격상·폐기로 책임진다.
# 지연-실행 이중 기동은 dispatch.sh/notify-bot의 자체 이중기동 가드가 2차 방어.
# notify <key> <text> — 같은 key는 NOTIFY_GAP 간격 제한(억제 시 return 1 — 호출자가 event 기록 게이트로 쓸 수 있음).
# force 알림(롤백·escalate)은 notify_now 사용.
notify(){ local last; last="$(sv_get "notified.$1")"; [[ -n "$last" ]] && (( now - last < NOTIFY_GAP )) && return 1
  sv_merge notified "{\"$1\":$now}"; notify_now "$2"; }
notify_now(){ node "$ROOT/bin/tg-notify.mjs" "$1" 2>&1 | grep -v '미설정' || true; }

hold_active(){ local h; h="$(sv_get "$1.holdUntil")"; [[ -n "$h" ]] && (( now < h )); }

# 디스패처 재기동: ⓪ 의도된 큐 탭(⏳) 재사용 ① 대시보드 프록시 ② loopctl 직접(best-effort).
# ⓪가 필요한 이유: cmux 창이 화면에 없으면(백그라운드/최소화/다른 Space) 어떤 컨텍스트의 spawn도 렌더 전까지
#   발화하지 않는다(실측: activate/새 창 격상도 무력). ⏳ 마커 탭(spawn-panel QUEUE_OK가 남긴 것)만 "의도된 큐"로
#   인정한다 — 마커 없는 🔁 탭은 cmux 재시작이 복원한 껍데기 셸일 수 있는데, 그건 select해도 아무것도 실행되지
#   않아(명령이 큐에 없음) 재사용이 무의미하다(실사고: 복원 셸 재사용 → 가짜 성공 → crash-loop 오판).
#   ⏳ 탭이 materialize됐는데 마커가 남아있으면(발화 후 즉사·이중기동 탈락) 죽은 셸 → 닫고 새 spawn 경로로.
#   (여러 큐가 동시 발화해도 dispatch.sh 이중 기동 가드가 걸러낸다.)
try_start_dispatcher(){
  local r
  if [[ -n "$CMUX_OK" ]]; then   # 소켓 가용(수동 run 등) — 큐 대기 탭 재사용을 여기서도 시도(프록시 경로는 대시보드가 자체 dedupe)
    for r in $("$CMUX_BIN" list-workspaces 2>/dev/null | strip_selected | grep -F '🔁 loops dispatcher ⏳' | grep -oE 'workspace:[0-9]+'); do
      if "$CMUX_BIN" read-screen --workspace "$r" --lines 1 >/dev/null 2>&1; then
        "$CMUX_BIN" close-workspace --workspace "$r" >/dev/null 2>&1   # 발화했으나 죽은 ⏳ 셸 — 폐기
      else
        "$CMUX_BIN" select-workspace --workspace "$r" >/dev/null 2>&1
        echo "[$(date '+%F %T')]   (큐 대기 ⏳ 탭 $r 유지 — cmux 전면화 시 자동 발화)"
        return 0
      fi
    done
  fi
  if curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/" 2>/dev/null; then
    local resp; resp="$(curl -s --max-time 15 -X POST "http://localhost:$PORT/api/control" -H 'content-type: application/json' -d '{"action":"start"}' 2>/dev/null)"
    echo "[$(date '+%F %T')]   (대시보드 프록시로 start 요청: ${resp:-무응답})"
  elif [[ -n "$CMUX_OK" ]]; then
    "$ROOT/loopctl" start || echo "[$(date '+%F %T')]   (직접 spawn 실패/큐 대기 — 다음 패스 재확인)"
  else
    echo "[$(date '+%F %T')]   (재기동 경로 없음 — 대시보드 죽음 + cmux 소켓 접근 불가(launchd). 사람 개입 필요)"
    notify no-path "🚨 supervisor: 디스패처·대시보드가 모두 죽었고 launchd에선 cmux 소켓을 쓸 수 없습니다. cmux 터미널에서 'loopctl start'를 실행해 주세요." || true
  fi
}

# ── 0) cmux 생존 ──
# ⚠️ cmux 소켓은 "cmux 안에서 시작된 프로세스"만 접속 허용(Access denied) — launchd 컨텍스트에선 항상 거부된다.
# 그래서 ① 앱 생존은 소켓 없이 프로세스로 판정하고(pgrep — launchd에서도 가능) ② 소켓 가용 여부(CMUX_OK)는
# 별도로 기억해 소켓이 필요한 경로(큐 탭 dedupe·직접 spawn)만 게이트한다. 재기동의 1순위 경로는 어차피
# HTTP(대시보드 프록시)라 launchd에서도 동작한다. panels 스코프(디스패처 내부 호출)는 항상 소켓 가용.
# (pgrep -f는 macOS에서 GUI 앱 argv를 못 읽어 오탐 — ps 스캔으로 판정)
if ! ps ax -o command 2>/dev/null | grep -q '[c]mux\.app/Contents/MacOS'; then
  echo "[$(date '+%F %T')] 🚨 cmux 앱이 떠있지 않음 — 패널 재기동 불가. 알림만 하고 종료."
  event cmux-down cmux "cmux 앱 프로세스 없음"
  notify cmux "🚨 supervisor: cmux 앱이 꺼져 있어 디스패처/대시보드/봇 재기동이 불가합니다. cmux 앱을 실행해 주세요."
  exit 0
fi
CMUX_OK=""
[[ -n "$CMUX_BIN" ]] && "$CMUX_BIN" list-workspaces >/dev/null 2>&1 && CMUX_OK=1

# ── 1) dispatcher (full 스코프 전용 — panels 스코프는 dispatch.sh 자신이라 무의미) ──
# 죽음 판정 교정(실사고 7/11): 구버전은 "재기동 시도"를 crash로 세어, cmux 백그라운드로 spawn이 큐에 잠든 상황을
# 3패스 만에 가짜 crash-loop으로 오판 → 30분 hold가 오히려 복구를 막았다. 이제 두 신호로 '진짜 사망'만 센다:
#   · lastAlivePid — 직전 패스에서 살아있던 pid. 있었는데 지금 죽음 = 관찰된 사망(1회 소비).
#   · startsSeen  — dispatcher.log의 "start (pid" 라인 수. 우리가 마지막 본 뒤 늘었는데 지금 죽음 = 패스 사이 기동+즉사(fast crash).
# 둘 다 아니면 = 기동 자체가 안 된 것(spawn-blocked) → 카운트/hold 없이 재시도 + 레이트리밋 안내만.
disp_pid="$(cat "$STATE/dispatcher.pid" 2>/dev/null)"
if [[ "$SCOPE" == "full" && ! -f "$STATE/STOPPED.dispatcher" ]]; then
  starts_now="$(grep -c 'loops dispatcher start (pid' "$STATE/dispatcher.log" 2>/dev/null)"; [[ -z "$starts_now" ]] && starts_now=0
  if [[ -z "$disp_pid" ]] || ! kill -0 "$disp_pid" 2>/dev/null; then
    starts_seen="$(sv_get dispatcher.startsSeen)"; [[ -z "$starts_seen" ]] && starts_seen=0
    last_alive="$(sv_get dispatcher.lastAlivePid)"
    if hold_active dispatcher; then
      echo "[$(date '+%F %T')] ⏸ dispatcher 죽음 — crash-loop cooldown 중(재기동 보류, $(sv_get dispatcher.holdUntil)까지)"
    elif [[ -z "$last_alive" ]] && (( starts_now <= starts_seen )); then
      # spawn-blocked: 산 걸 본 적도, 새 기동 흔적도 없음 — 죽은 게 아니라 "안 떠진 것"(cmux 백그라운드 큐 대기 등).
      echo "[$(date '+%F %T')] 🕐 dispatcher 미기동(기동 흔적 없음) — spawn-blocked: crash 카운트 없이 재시도"
      try_start_dispatcher
      if notify spawn-blocked "🕐 supervisor: 디스패처 기동 대기 중 — cmux 창을 화면에 띄우면 자동 시작됩니다."; then
        event spawn-blocked dispatcher "기동 흔적 없음 — 큐 대기(cmux 전면화 필요 가능성)"
      fi
    else
      # 진짜 사망 — 신호 소비(같은 시신 중복 카운트 방지) 후 기존 카운트/crash-loop/rollback 분기 그대로.
      sv_merge dispatcher "{\"lastAlivePid\":\"\",\"startsSeen\":$starts_now}"
      n=$(sv_restarts dispatcher)
      if (( n + 1 >= CRASH_N )); then
        # ── crash-loop: 직전 self-update가 원인인지 확인 → 롤백 시도, 아니면 escalate+cooldown ──
        rolled=""
        hist_line="$(tail -1 "$STATE/.update_history" 2>/dev/null)"
        if [[ -n "$hist_line" ]]; then
          up_ts="${hist_line%% *}"; rest="${hist_line#* }"; old_sha="${rest%% *}"; new_sha="${rest##* }"
          head_sha="$(git -C "$ROOT" rev-parse @ 2>/dev/null)"
          if [[ -n "$up_ts" && -n "$old_sha" && -n "$new_sha" ]] && (( now - up_ts <= RB_WIN )) && [[ "$head_sha" == "$new_sha" ]]; then
            # --keep: 미커밋 로컬 변경은 보존, 충돌하면 git이 스스로 거부(무손실). force-push 아님 — 로컬 브랜치 포인터만 이동.
            if git -C "$ROOT" reset --keep "$old_sha" >/dev/null 2>&1; then
              echo "$new_sha" > "$STATE/.update_hold"
              rolled=1
              echo "[$(date '+%F %T')] ⏪ crash-loop → self-update 롤백 ${new_sha:0:7} → ${old_sha:0:7} (+hold: origin 수정 전까지 재당김 보류)"
              event rollback dispatcher "crash-loop ${new_sha:0:7}→${old_sha:0:7} 롤백, hold 설정"
              notify_now "⏪ supervisor: 디스패처 crash-loop → self-update 롤백 (${new_sha:0:7} → ${old_sha:0:7}). origin에 수정이 올라올 때까지 해당 커밋은 보류합니다."
            else
              echo "[$(date '+%F %T')] ⚠️ 롤백 불가 — reset --keep 거부(로컬 변경 충돌). escalate."
            fi
          fi
        fi
        if [[ -n "$rolled" ]]; then
          sv_record dispatcher; try_start_dispatcher
          sleep 3; p2="$(cat "$STATE/dispatcher.pid" 2>/dev/null)"
          if [[ -n "$p2" ]] && kill -0 "$p2" 2>/dev/null; then sv_merge dispatcher "{\"lastAlivePid\":\"$p2\"}"; echo "[$(date '+%F %T')] ✅ 롤백 후 dispatcher 재기동 확인 (pid $p2)"; else echo "[$(date '+%F %T')] ⚠️ 롤백 후 재기동 미확인 — 다음 패스 재시도"; fi
        else
          sv_merge dispatcher "{\"holdUntil\":$(( now + CRASH_COOL ))}"
          echo "[$(date '+%F %T')] 🚨 dispatcher crash-loop(윈도 ${CRASH_WIN}s 내 $(( n + 1 ))회) — 원인 불명 → 재기동 ${CRASH_COOL}s 중단 + escalate"
          event escalate dispatcher "crash-loop $(( n + 1 ))회/${CRASH_WIN}s — 재기동 중단(cooldown ${CRASH_COOL}s)"
          notify_now "🚨 supervisor: 디스패처가 ${CRASH_WIN}초 안에 $(( n + 1 ))회 죽음 — 자동 재기동을 ${CRASH_COOL}초 중단합니다. state/dispatcher.log 확인 필요."
        fi
      else
        echo "[$(date '+%F %T')] 🩹 dispatcher 죽음(pid ${disp_pid:-없음}) → 재기동 ($(( n + 1 ))회째/${CRASH_WIN}s)"
        sv_record dispatcher; try_start_dispatcher
        event restart dispatcher "재기동 $(( n + 1 ))회째/${CRASH_WIN}s"
        sleep 3; p2="$(cat "$STATE/dispatcher.pid" 2>/dev/null)"
        if [[ -n "$p2" && "$p2" != "$disp_pid" ]] && kill -0 "$p2" 2>/dev/null; then
          sv_merge dispatcher "{\"lastAlivePid\":\"$p2\"}"
          echo "[$(date '+%F %T')] ✅ dispatcher 재기동 확인 (pid $p2)"
          notify disp-restart "🩹 supervisor: 디스패처가 죽어 있어 재기동했습니다 (pid $p2, $(( n + 1 ))회째/최근 $(( CRASH_WIN / 60 ))분)" || true
        else
          echo "[$(date '+%F %T')] ⚠️ dispatcher 재기동 미확인 — 다음 패스(≤60s) 재확인 (기동 흔적 없으면 spawn-blocked로 전환, crash 카운트 없음)"
          notify disp-restart-fail "⚠️ supervisor: 디스패처 재기동을 시도했으나 확인 실패 — 계속 재시도합니다 (state/supervisor.log)" || true
        fi
      fi
    fi
  else
    # 살아있음 — 관찰 신호 동기화(다음 죽음 판정의 기준점): lastAlivePid + 기동 흔적 카운터.
    if [[ "$(sv_get dispatcher.lastAlivePid)" != "$disp_pid" || "$(sv_get dispatcher.startsSeen)" != "$starts_now" ]]; then
      sv_merge dispatcher "{\"lastAlivePid\":\"$disp_pid\",\"startsSeen\":$starts_now}"
    fi
  fi
fi

# ── 1.5) 인프라 패널 sweep (panels 스코프 전용 — dispatch.sh PTY에서 실행되므로 소켓 보장) ──
# cmux 앱 재시작은 모든 탭을 "타이틀만 남은 빈 셸"로 세션 복원한다(워커 쪽 실사고 GOD-28과 동일 기전). 워커 탭은
# watchdog(pidfile corpse-close)이 걷지만 인프라 타이틀(🔁/📊/🤖)은 어떤 리퍼에도 안 걸려 재기동마다 누적됐다(실사고
# 7/11: 16개 수동 정리). 여기서 "프로세스 생존 신호 + state/panel.*.ref(각 패널이 boot 시 identify로 기록한 자기 탭)"
# 로 진짜 1개만 남기고 회수한다. 판정 원칙 유지: list-workspaces 빈 응답 = 판정불가 skip / ref 파일 없음 = 해당
# 타이틀 skip / 🤖 loop builder 등 그 외 타이틀 = 사용자 세션, 불가침. Backlog 이동·머지·kill 없음 — 탭 close뿐.
sweep_panels(){
  [[ -z "$CMUX_BIN" ]] && return 0
  local ls_out; ls_out="$("$CMUX_BIN" list-workspaces 2>/dev/null)"
  [[ -z "$ls_out" ]] && { echo "[$(date '+%F %T')] 🧹 sweep: list-workspaces 빈 응답 — 판정불가 skip"; return 0; }
  # 별도 Palace/Loops 설치의 같은 이름 패널은 이 엔진의 소유가 아니다.
  local scoped_refs
  scoped_refs="$("$CMUX_BIN" workspace list --json 2>/dev/null | node -e '
    const fs = require("node:fs"); let input = "";
    process.stdin.on("data", data => input += data).on("end", () => {
      try {
        const root = fs.realpathSync(process.argv[1]), data = JSON.parse(input);
        if (!Array.isArray(data.workspaces)) throw Error("workspace metadata unavailable");
        const refs = data.workspaces.filter(w => {
          try { return fs.realpathSync(w.current_directory || w.cwd || "") === root; } catch { return false; }
        }).map(w => w.ref).filter(ref => /^workspace:\d+$/.test(ref));
        process.stdout.write(refs.join(" "));
      } catch { process.exitCode = 1; }
    });' "$ROOT")" || { echo "[$(date '+%F %T')] 🧹 sweep: 엔진 소유 경로 판정 실패 — skip"; return 0; }
  [[ -z "$scoped_refs" ]] && return 0
  local dash_ok="" bot_ok="" disp_alive="" disp_ref dash_ref bot_ref dp
  curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/" 2>/dev/null && dash_ok=1
  pgrep -f "$ROOT/bin/notify-bot.mjs" >/dev/null 2>&1 && bot_ok=1
  dp="$(cat "$STATE/dispatcher.pid" 2>/dev/null)"; [[ -n "$dp" ]] && kill -0 "$dp" 2>/dev/null && disp_alive=1
  disp_ref="$(cat "$STATE/panel.dispatcher.ref" 2>/dev/null)"
  dash_ref="$(cat "$STATE/panel.dashboard.ref" 2>/dev/null)"
  bot_ref="$(cat "$STATE/panel.bot.ref" 2>/dev/null)"
  local line ref title closed=0
  while IFS= read -r line; do
    ref="$(print -r -- "$line" | grep -oE 'workspace:[0-9]+' | head -1)"; [[ -z "$ref" ]] && continue
    [[ " $scoped_refs " == *" $ref "* ]] || continue
    title="$(print -r -- "$line" | strip_selected | sed -E 's/^\*?[[:space:]]*workspace:[0-9]+[[:space:]]+//; s/[[:space:]]+$//')"
    case "$title" in
      "⏹ loops dispatcher"|"⏹ loops dashboard"|"⏹ loops bot") ;;   # 종료 마킹된 인프라 탭 — 무조건 회수
      "🔁 loops dispatcher"|"🔁 loops dispatcher ⏳")
        # 디스패처가 살아있을 때만 판정(수동 `supervisor.sh panels` 실행 시 살아있는 큐 ⏳를 오폐기하지 않게).
        [[ -z "$disp_alive" || -z "$disp_ref" ]] && continue
        [[ "$ref" == "$disp_ref" ]] && continue
        ;;
      "📊 loops dashboard")
        if [[ -n "$dash_ok" ]]; then
          [[ -z "$dash_ref" || "$ref" == "$dash_ref" ]] && continue
        else
          # HTTP 죽음 + 프로세스 잔존 = hung 가능성(§2가 표면화) — wedged 철학대로 닫지 않음. 프로세스도 없으면 전부 회수.
          pgrep -f "$ROOT/dashboard-server.mjs" >/dev/null 2>&1 && continue
        fi
        ;;
      "🤖 loops bot")
        if [[ -n "$bot_ok" ]]; then
          [[ -z "$bot_ref" || "$ref" == "$bot_ref" ]] && continue
        fi
        ;;
      *) continue;;   # 그 외(🤖 loop builder·워커 🛠/↩·사용자 탭) — 여기선 불가침(워커는 watchdog/reaper 소관)
    esac
    if "$CMUX_BIN" close-workspace --workspace "$ref" >/dev/null 2>&1; then
      (( closed++ )); echo "[$(date '+%F %T')] 🧹 sweep: 죽은 인프라 탭 $ref ($title) 회수"
    fi
  done <<< "$ls_out"
  (( closed > 0 )) && event panel-swept panels "죽은 인프라 탭 ${closed}개 회수"
  return 0
}
[[ "$SCOPE" == "panels" ]] && sweep_panels

# ── 1.6) 유령 탭 sweep (panels 스코프 전용) ──
# 위 sweep_panels를 포함해 엔진의 모든 회수 경로는 타이틀 정규식(🛠|↩|🔎|🧪|🔁|📊|🤖)에 걸려 있다. 그런데 cmux가
# 부하를 받으면 create/rename RPC가 타임아웃해 **이름조차 못 받은 탭**이 남고(실측 2회: 93개·66개, spawn-failed와 1:1),
# 그런 탭은 어떤 리퍼에도 안 걸려 무한 적재된다 — 탭이 늘수록 cmux가 느려져 타임아웃이 더 잦아지는 폭주 루프.
# spawn-panel이 생성 실패 시 diff로 회수하도록 고쳤지만(11b5f40) 그 회수도 같은 RPC를 타므로 부하가 심하면 또 샌다.
# 여기서 "누가 흘렸든 주기적으로 걷는다" — 타이틀에 의존하지 않는 유일한 리퍼. 판정·안전장치는 phantom-sweep.mjs 헤더 참조
# (커스텀 타이틀 없음 + 루프 worktree cwd + 대화 없음 + PTY 없음 + 워커 pid 죽음 + 연속 2회 관찰). 탭 close 외 부작용 없음.
sweep_phantoms(){
  [[ -z "$CMUX_BIN" ]] && return 0
  local out n
  out="$(CMUX_BIN="$CMUX_BIN" LOOPS_HOME="$ROOT" node "$ROOT/bin/phantom-sweep.mjs" 2>&1)"
  [[ -z "$out" ]] && return 0
  print -r -- "$out" | while IFS= read -r l; do print -r -- "[$(date '+%F %T')] 🧹 $l"; done
  n="$(print -r -- "$out" | grep -c '유령 탭 .* 회수')"
  (( n > 0 )) && event phantom-swept panels "이름 없는 유령 탭 ${n}개 회수"
  return 0
}
[[ "$SCOPE" == "panels" ]] && sweep_phantoms

# ── 2) dashboard (panels 스코프 전용 — 디스패처의 PTY 컨텍스트에서만 spawn이 확실. opt-out: LOOPS_SUPERVISE_DASHBOARD=0) ──
if [[ "$SCOPE" == "panels" && "${LOOPS_SUPERVISE_DASHBOARD:-1}" != "0" && ! -f "$STATE/STOPPED.dashboard" ]]; then
  if ! curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/" 2>/dev/null; then
    if pgrep -f "$ROOT/dashboard-server.mjs" >/dev/null 2>&1; then
      # 프로세스는 있는데 HTTP 미응답 = hung 가능성 — wedged 철학: kill 없이 표면화만(멀쩡한 기동 중일 수도).
      echo "[$(date '+%F %T')] 🥶 dashboard 프로세스는 있으나 :$PORT 미응답 — kill 없이 표면화만"
      notify dash-hung "🥶 supervisor: 대시보드 프로세스는 살아있는데 :$PORT 응답이 없습니다 — 패널 확인 필요."
    elif hold_active dashboard; then
      echo "[$(date '+%F %T')] ⏸ dashboard 죽음 — cooldown 중(재기동 보류)"
    else
      n=$(sv_restarts dashboard)
      if (( n + 1 >= CRASH_N )); then
        sv_merge dashboard "{\"holdUntil\":$(( now + CRASH_COOL ))}"
        echo "[$(date '+%F %T')] 🚨 dashboard crash-loop($(( n + 1 ))회/${CRASH_WIN}s) → 재기동 ${CRASH_COOL}s 중단 + escalate"
        event escalate dashboard "crash-loop $(( n + 1 ))회/${CRASH_WIN}s"
        notify_now "🚨 supervisor: 대시보드가 반복해서 죽습니다($(( n + 1 ))회) — 자동 재기동 중단. node dashboard-server.mjs로 직접 에러를 확인하세요."
      else
        echo "[$(date '+%F %T')] 🩹 dashboard 죽음 → 재기동 ($(( n + 1 ))회째)"
        sv_record dashboard; "$ROOT/loopctl" dashboard
        event restart dashboard "재기동 $(( n + 1 ))회째"
        sleep 3
        if curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/" 2>/dev/null; then
          echo "[$(date '+%F %T')] ✅ dashboard 재기동 확인 (:$PORT 응답)"
          notify dash-restart "🩹 supervisor: 대시보드가 죽어 있어 재기동했습니다"
        else
          echo "[$(date '+%F %T')] ⚠️ dashboard 재기동 미확인 — 다음 패스 재시도"
        fi
      fi
    fi
  fi
fi

# ── 3) bot (panels 스코프 전용) — 토큰이 설정된 경우에만 감독 대상(미설정 = 채널 미개통, 정상) ──
if [[ "$SCOPE" == "panels" && -n "${TELEGRAM_BOT_TOKEN:-}" && ! -f "$STATE/STOPPED.bot" ]]; then
  if ! pgrep -f "$ROOT/bin/notify-bot.mjs" >/dev/null 2>&1; then
    if hold_active bot; then
      echo "[$(date '+%F %T')] ⏸ bot 죽음 — cooldown 중(재기동 보류)"
    else
      n=$(sv_restarts bot)
      if (( n + 1 >= CRASH_N )); then
        sv_merge bot "{\"holdUntil\":$(( now + CRASH_COOL ))}"
        echo "[$(date '+%F %T')] 🚨 bot crash-loop($(( n + 1 ))회/${CRASH_WIN}s) → 재기동 ${CRASH_COOL}s 중단 + escalate"
        event escalate bot "crash-loop $(( n + 1 ))회/${CRASH_WIN}s"
        notify_now "🚨 supervisor: Telegram 봇이 반복해서 죽습니다($(( n + 1 ))회) — 자동 재기동 중단. state/bot-log.jsonl 확인."
      else
        echo "[$(date '+%F %T')] 🩹 bot 죽음 → 재기동 ($(( n + 1 ))회째)"
        sv_record bot; "$ROOT/loopctl" bot
        event restart bot "재기동 $(( n + 1 ))회째"
        sleep 3
        if pgrep -f "$ROOT/bin/notify-bot.mjs" >/dev/null 2>&1; then
          echo "[$(date '+%F %T')] ✅ bot 재기동 확인"
          notify bot-restart "🩹 supervisor: Telegram 봇이 죽어 있어 재기동했습니다"
        else
          echo "[$(date '+%F %T')] ⚠️ bot 재기동 미확인 — 다음 패스 재시도"
        fi
      fi
    fi
  fi
fi

exit 0
