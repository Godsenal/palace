#!/bin/zsh
# 글로벌 디스패처: 모든 enabled 루프를 각자 스케줄대로 발사. ⚠️ cmux 패널 안에서 실행해야 함(child가 worker 탭 spawn).
set -u
source "${0:A:h}/_common.sh"
ROOT="$LOOPS_HOME"; STATE=$ROOT/state
PID=$STATE/dispatcher.pid; PAUSED=$STATE/PAUSED
mkdir -p "$STATE"
# 이중 기동 가드: 살아있는 디스패처가 이미 있으면 즉시 종료(pid 파일은 건드리지 않음 — trap 설치 전이라 안전).
# 이중 기동 경로: loopctl start 경합, cmux의 지연 materialize(비 cmux 컨텍스트 spawn이 렌더 시점에 뒤늦게 실행됨) 등.
prev="$(cat "$PID" 2>/dev/null)"
if [[ -n "$prev" && "$prev" != "$$" ]] && kill -0 "$prev" 2>/dev/null; then
  echo "[$(date '+%F %T')] 이미 실행 중(pid $prev) — 중복 인스턴스 종료" >> "$STATE/dispatcher.log"
  exit 0
fi
echo $$ > "$PID"
cleanup(){
  rm -f "$PID"
  # 자기 탭 ⏹ 리네임(워커 on_exit 미러) — 산 척하는 🔁 셸을 남기지 않는다. SIGHUP(PTY째 사망)엔 안 돌지만 sweep이 커버.
  [[ -n "${MY_WS:-}" && -n "${CMUX_BIN:-}" ]] && "$CMUX_BIN" rename-workspace --workspace "$MY_WS" "⏹ loops dispatcher" >/dev/null 2>&1
  rm -f "$STATE/panel.dispatcher.ref"
}
trap 'cleanup; exit 0' INT TERM EXIT
echo "[$(date '+%F %T')] loops dispatcher start (pid $$)" >> "$STATE/dispatcher.log"

# ── 자기 탭 인식: 어느 워크스페이스가 "진짜 디스패처"인지의 단일 원천(state/panel.dispatcher.ref).
#    supervisor panels sweep이 이 ref 외의 🔁 탭(cmux 재시작 복원 셸·스테일 큐 ⏳·이중기동 잔재)을 닫는다.
#    identify 실패(플레이크·비 cmux 컨텍스트) → ref 파일 제거 — sweep은 파일 없으면 🔁 정리를 skip(판정불가=skip 원칙).
MY_WS="$(own_workspace_ref)" || MY_WS=""
if [[ -n "$MY_WS" ]]; then
  echo "$MY_WS" > "$STATE/panel.dispatcher.ref"
  # 큐 탭(⏳)에서 지연 발화한 경우 마커 해제 — 내 탭이 디스패처 타이틀일 때만(수동 실행한 사용자 터미널 보호).
  mytitle="$("$CMUX_BIN" list-workspaces 2>/dev/null | strip_selected | grep -E "^\*?[[:space:]]*${MY_WS}[[:space:]]" | sed -E "s/^\*?[[:space:]]*${MY_WS}[[:space:]]+//" | head -1)"
  if [[ "$mytitle" == *"loops dispatcher"* && "$mytitle" == *"⏳"* ]]; then
    "$CMUX_BIN" rename-workspace --workspace "$MY_WS" "🔁 loops dispatcher" >/dev/null 2>&1
  fi
else
  rm -f "$STATE/panel.dispatcher.ref"
  echo "[$(date '+%F %T')] ⚠️ own_workspace_ref 실패 — panel.dispatcher.ref 미기록(sweep은 🔁 정리 skip)" >> "$STATE/dispatcher.log"
fi
# 기동 직후 1회 패널 정리 — cmux 재시작 후 첫 부활 시점에 죽은 인프라 탭(복원 셸·⏳ 잔재)을 즉시 수렴.
"$ROOT/bin/supervisor.sh" panels >> "$STATE/supervisor.log" 2>&1

field(){ cfgval "$@" 2>/dev/null; }   # _common.sh의 cfgval에 stderr 억제만 덧씌운 래퍼(기존 동작 보존)
# 루프 일일 예산(config budget.dailyUsd) 소프트 캡: 오늘 costs.jsonl 합계가 캡 이상이면 사유를 출력(비면 통과).
# "다음 사이클을 안 돌리는" 수준 — 진행 중 워커는 건드리지 않는다. 예산 미설정이면 항상 통과.
budget_check(){ node -e 'const fs=require("fs"),[cfgF,costF]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(cfgF));const cap=c.budget&&c.budget.dailyUsd;if(!cap)process.exit(0);let lines=[];try{lines=fs.readFileSync(costF,"utf8").trim().split("\n")}catch{process.exit(0)}const d=new Date();d.setHours(0,0,0,0);const t0=Math.floor(d.getTime()/1000);let s=0;for(const l of lines){try{const e=JSON.parse(l);if(e.ts>=t0&&e.usd)s+=e.usd}catch{}}if(s>=cap)process.stdout.write("일예산 초과 $"+s.toFixed(2)+"/$"+cap)' "$1" "$2" 2>/dev/null; }
next_calc(){ node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));const s=c.schedule||{};const iv=Math.max(60,s.intervalSec||3600);const now=Math.floor(Date.now()/1000);let f=now;if(s.startAt){const m=String(s.startAt).match(/(\d{1,2}):(\d{2})/);if(m){const d=new Date();d.setHours(+m[1],+m[2],0,0);f=Math.floor(d.getTime()/1000);while(f<=now)f+=iv;}}console.log(f)' "$1" 2>/dev/null; }
ivof(){ node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(Math.max(60,(c.schedule||{}).intervalSec||3600))' "$1" 2>/dev/null; }

# ── drain 모드 발사 게이트 (config drain: true | {discoverySec}) ──
# "쌓이면 계속 처리, 비면 조용" 모드. drain 루프는 스케줄 heartbeat마다 이걸 통과해야 실제 LLM 사이클(orchestrator)을 태운다:
#   ① discovery 주기(기본 600s) 도래 → 발사. backlog가 비어도 이걸로 발굴 소스(Sentry 등)를 주기적으로 폴링해 새 이슈를 채운다.
#   ② 드레인 가능 backlog(라벨 스코프 · run-log와 human-gate 이슈 제외 — 워커가 못 집어가는 상주 이슈가 게이트를
#      영구로 열지 않게, linear-drain-check.mjs) > 0 && in-flight<cap → 드레인할 일 있음 → 발사.
# 둘 다 아니면 이번 발사는 스킵(next_fire만 전진 · LLM 미기동 → idle 토큰비용 0). on.linearNew는 새 이슈 도착 시 즉시 발사(그대로).
# Linear 미가용(비0 종료)이면 보수적으로 발사 — 신호가 없을 때 루프를 멈추지 않는다. 반환 0=발사, 1=스킵.
drain_should_fire(){ # $1=cfg $2=lstate
  local cfg="$1" ls="$2" pid label cap disc last raw b s
  disc="$(field "$cfg" drain.discoverySec)"; [[ -z "$disc" ]] && disc=600
  last=$(cat "$ls/.last_discovery" 2>/dev/null || echo 0)
  if (( now - last >= disc )); then echo "$now" > "$ls/.last_discovery"; return 0; fi   # ① 발굴 주기 도래
  pid="$(field "$cfg" linearProjectId)"; label="$(field "$cfg" linearLabel)"
  cap="$(field "$cfg" maxWorkers)"; [[ -z "$cap" ]] && cap=2
  raw="$(LINEAR_API_KEY="${LINEAR_API_KEY:-}" node "$ROOT/bin/linear-drain-check.mjs" "$pid" "$label" 2>/dev/null)" || return 0   # Linear 미가용 → 보수적 발사
  b="${raw%%$'\t'*}"; s="${raw##*$'\t'}"
  [[ "$b" == <-> && "$s" == <-> ]] || return 0                             # 출력 이상 → 보수적 발사
  (( b > 0 && s < cap )) && return 0                                       # ② 드레인할 backlog 있고 여유 슬롯 있음
  return 1                                                                 # 아무 것도 없음 → 스킵
}

while true; do
  if [[ ! -f "$PAUSED" ]]; then
    for CFG in $ROOT/loops/*/config.json(N); do
      [[ -f "$CFG" ]] || continue
      lid="$(field "$CFG" id)"; [[ -z "$lid" ]] && continue
      [[ "$(field "$CFG" enabled)" == "false" ]] && continue
      lstate="$ROOT/loops/$lid/state"; mkdir -p "$lstate"
      nextf="$lstate/next_fire"
      [[ -f "$lstate/PAUSED" ]] && continue
      [[ -f "$nextf" ]] || next_calc "$CFG" > "$nextf"
      now=$(date +%s); nf=$(cat "$nextf" 2>/dev/null || echo 0)
      if (( now >= nf )); then
        bex="$(budget_check "$CFG" "$lstate/costs.jsonl")"
        if [[ -n "$bex" ]]; then
          # 예산 소프트 캡: 이번 발사만 건너뛰고 next_fire를 정상 전진 — 자정 지나 오늘 합계가 리셋되면 자동 재개.
          iv=$(ivof "$CFG"); while (( nf <= now )); do nf=$(( nf + iv )); done; echo "$nf" > "$nextf"
          echo "[$(date '+%F %T')] 💰 budget-skip $lid ($bex) → next $(date -r $nf '+%F %T')" >> "$STATE/dispatcher.log"
          print -r -- "{\"ts\":$now,\"type\":\"cycle\",\"event\":\"budget-skip\",\"note\":\"$bex\"}" >> "$lstate/runs.jsonl"
          continue
        fi
        # drain 모드: 발사할 값어치(드레인할 backlog 또는 발굴 주기 도래)가 있을 때만 LLM 사이클을 태운다. 없으면 스킵.
        draincfg="$(field "$CFG" drain)"
        if [[ -n "$draincfg" && "$draincfg" != "false" ]] && ! drain_should_fire "$CFG" "$lstate"; then
          iv=$(ivof "$CFG"); while (( nf <= now )); do nf=$(( nf + iv )); done; echo "$nf" > "$nextf"
          continue
        fi
        "$ROOT/bin/spawn-orchestrator.sh" "$lid" >> "$lstate/dispatcher.log" 2>&1 &
        iv=$(ivof "$CFG")
        while (( nf <= now )); do nf=$(( nf + iv )); done
        echo "$nf" > "$nextf"
        echo "[$(date '+%F %T')] fired $lid → next $(date -r $nf '+%F %T')" >> "$STATE/dispatcher.log"
      fi
    done

    # ── event-poll: config on:{} 이벤트 소스(CI 실패·새 PR 리뷰·Linear 신규 Backlog)를 ≤60s로 폴링해
    #    조건 충족 시 해당 루프의 next_fire를 now로 당긴다(발사는 위 본 루프의 기존 경로 그대로).
    #    PAUSED 가드 **안**에 두는 이유: 이건 housekeeping이 아니라 발사 스케줄링이라, 전역 정지 중엔 폴링도 무의미.
    now=$(date +%s); lastev=$(cat "$STATE/.last_eventpoll" 2>/dev/null || echo 0)
    if (( now - lastev >= 60 )); then
      echo "$now" > "$STATE/.last_eventpoll"
      for CFG in $ROOT/loops/*/config.json(N); do
        [[ -f "$CFG" ]] || continue
        lid="$(field "$CFG" id)"; [[ -z "$lid" ]] && continue
        "$ROOT/bin/event-poll.sh" "$lid" >> "$ROOT/loops/$lid/state/run.log" 2>&1
        # retry-backoff: 직전 사이클이 일시적 오류(529·connection closed·타임아웃)나 계정별 인증 문제로
        # 죽었으면 next_fire를 백오프만큼만 당긴다 — 같은 "next_fire 당기기" 메커니즘이라 새 실행 경로 없음.
        # event-poll과 같은 PAUSED/enabled·60s 게이트를 공유한다(둘 다 발사 스케줄링이라 성격이 같다).
        "$ROOT/bin/retry-backoff.sh" "$lid" >> "$ROOT/loops/$lid/state/run.log" 2>&1
      done
    fi

    # ── triage: 제품(products/<id>) 상위 분류기 — 공유 Linear 프로젝트에 라벨 없이 쌓인 이슈를 routes로 분류해
    #    라벨을 붙인다(≤60s). 라벨이 붙는 순간 해당 라벨 루프의 event-poll(linearNew)이 잡아 즉시 사이클 — 새 실행 경로 없음.
    #    PAUSED 가드 안: 분류는 발사로 이어지는 스케줄링 성격이라 전역 정지 중엔 하지 않는다.
    now=$(date +%s); lasttri=$(cat "$STATE/.last_triage" 2>/dev/null || echo 0)
    if (( now - lasttri >= 60 )); then
      echo "$now" > "$STATE/.last_triage"
      for PJ in $ROOT/products/*/product.json(N); do
        pdir="${PJ:h}"; pname="${PJ:h:t}"
        mkdir -p "$pdir/state"
        "$ROOT/bin/triage.sh" "$pname" >> "$pdir/state/triage.log" 2>&1
      done
    fi

    # ── retro: config retro.everyCycles 개의 정규 사이클이 쌓일 때마다 성과 분석 run(LOOP_MODE=retro)을 1회 발사
    #    → learnings.md 갱신(힐 클라이밍 루프). 미설정(retro 없음/0)이면 완전 비활성. run 중(lockdir)이면 다음 체크로.
    now=$(date +%s); lastrt=$(cat "$STATE/.last_retrocheck" 2>/dev/null || echo 0)
    if (( now - lastrt >= 300 )); then
      echo "$now" > "$STATE/.last_retrocheck"
      for CFG in $ROOT/loops/*/config.json(N); do
        [[ -f "$CFG" ]] || continue
        lid="$(field "$CFG" id)"; [[ -z "$lid" ]] && continue
        [[ "$(field "$CFG" enabled)" == "false" ]] && continue
        lstate="$ROOT/loops/$lid/state"
        [[ -f "$lstate/PAUSED" ]] && continue
        [[ -d /tmp/loop-$lid.lockdir ]] && continue
        every="$(field "$CFG" retro.everyCycles)"; [[ -z "$every" || "$every" == "0" ]] && continue
        # 정규 사이클 done 수(retro 자신의 done은 제외) — 마지막 retro 시점 대비 every개 쌓였으면 발사.
        done_n=$(grep '"event":"done"' "$lstate/runs.jsonl" 2>/dev/null | grep -vc '"type":"retro"')
        last_n=$(cat "$lstate/.last_retro_cycles" 2>/dev/null || echo 0)
        if (( done_n - last_n >= every )); then
          echo "$done_n" > "$lstate/.last_retro_cycles"
          "$ROOT/bin/spawn-orchestrator.sh" "$lid" retro >> "$lstate/dispatcher.log" 2>&1 &
          echo "[$(date '+%F %T')] 🧠 retro fired $lid (cycles ${last_n}→${done_n}, every $every)" >> "$STATE/dispatcher.log"
        fi
      done
    fi
  fi

  # ── reaper: 종료/고아 worker 탭을 orchestrator 스케줄과 독립으로 즉시(≤60s) 회수. ──
  # cmux 소켓 접근이 필요해 이 디스패처 루프(=cmux 패널 안)에서 돈다. PAUSED와 무관한 housekeeping이라 위 가드 밖.
  # 진행 중 run(lockdir)이면 **종료 이슈 정리만**(CLEANUP_TERMINAL_ONLY) — 통째로 스킵하지 않는다.
  #   통째 스킵은 "사이클 < interval"을 가정했는데, 사이클이 interval보다 긴 루프(예: intervalSec=120 · 사이클 8~10분)는
  #   lockdir이 상시 점유돼 리퍼가 영영 안 돌았다 → 완료된 이슈의 탭·worktree가 사이클 끝까지 쌓인다(자가복구 계층 아사).
  #   종료 이슈는 fan-out 대상이 아니라 run 중에도 레이스가 없다. 유령/잔재 회수(레이스 실재)는 lockdir이 풀린 뒤에만.
  # 무동작 reap은 CLEANUP_QUIET로 조용히.
  now=$(date +%s); lastreap=$(cat "$STATE/.last_reap" 2>/dev/null || echo 0)
  if (( now - lastreap >= 60 )); then
    echo "$now" > "$STATE/.last_reap"
    for CFG in $ROOT/loops/*/config.json(N); do
      [[ -f "$CFG" ]] || continue
      lid="$(field "$CFG" id)"; [[ -z "$lid" ]] && continue
      tonly=""; [[ -d /tmp/loop-$lid.lockdir ]] && tonly=1
      CLEANUP_QUIET=1 CLEANUP_TERMINAL_ONLY="$tonly" "$ROOT/bin/cleanup-terminal.sh" "$lid" >> "$ROOT/loops/$lid/state/run.log" 2>&1
    done
  fi

  # ── panel-heal: 죽은 대시보드·봇 패널 재기동(supervisor.sh panels 스코프, ≤60s). 디스패처의 PTY 컨텍스트에서 ──
  # spawn해야 cmux 탭이 즉시 materialize되므로 launchd(supervisor full — 디스패처만 감독)가 아니라 여기서 돈다.
  # STOPPED 마커(의도적 정지)·crash-loop 윈도는 supervisor.sh가 판단. PAUSED와 무관한 housekeeping이라 가드 밖.
  now=$(date +%s); lastph=$(cat "$STATE/.last_panelheal" 2>/dev/null || echo 0)
  if (( now - lastph >= 60 )); then
    echo "$now" > "$STATE/.last_panelheal"
    "$ROOT/bin/supervisor.sh" panels >> "$STATE/supervisor.log" 2>&1
  fi

  # ── incident-bridge: 엔진 런타임 장애(사이클 연속 실패·supervisor escalate/롤백)를 엔진 자가개선 루프의 ──
  # Linear 이슈로 자동 발제(≤120s). 신호는 전부 과거 run/이벤트 기록에서 오므로 housekeeping — PAUSED 가드 밖.
  # dedup·일일 캡은 incident-bridge.sh 안에서 (state/incidents.json). LINEAR 키/엔진 루프 미설정이면 조용히 스킵.
  now=$(date +%s); lastinc=$(cat "$STATE/.last_incident" 2>/dev/null || echo 0)
  if (( now - lastinc >= 120 )); then
    echo "$now" > "$STATE/.last_incident"
    "$ROOT/bin/incident-bridge.sh" >> "$STATE/dispatcher.log" 2>&1
  fi

  # ── self-update: origin이 앞서면 엔진(LOOPS_HOME)을 fast-forward로 자동 갱신. 코드가 바뀌면 디스패처 재실행. ──
  # 모든 루프가 idle(진행 중 run=lockdir 없음)일 때만 — 실행 중 bin/ 스크립트 스왑 레이스 방지. reaper/watchdog처럼 housekeeping이라 PAUSED 가드 밖.
  # ff-only만(no-force 불변식); 유저 데이터는 gitignore라 무관. 주기 기본 600s(LOOPS_UPDATE_INTERVAL로 조정, 0이면 비활성).
  upiv="${LOOPS_UPDATE_INTERVAL:-600}"
  now=$(date +%s); lastup=$(cat "$STATE/.last_update" 2>/dev/null || echo 0)
  if (( upiv > 0 && now - lastup >= upiv )); then
    echo "$now" > "$STATE/.last_update"
    busy=""; for d in /tmp/loop-*.lockdir(N); do [[ -d "$d" ]] && { busy=1; break; }; done
    if [[ -z "$busy" ]]; then
      LOOPS_UPDATE_QUIET=1 "$ROOT/bin/self-update.sh" >> "$STATE/dispatcher.log" 2>&1
      if (( $? == 10 )); then
        echo "[$(date '+%F %T')] self-update 적용됨 → 디스패처 재실행(exec)" >> "$STATE/dispatcher.log"
        exec "$ROOT/bin/dispatch.sh"   # 같은 PID·같은 cmux 패널 유지, 새 엔진 코드 로드
      fi
    fi
  fi

  # ── watchdog: 죽은 worker(탭 사망·worktree 생존·In Progress)를 ≤60s로 자가복구하거나 escalate. ──
  # 리퍼와 같은 이유로 이 루프(cmux 패널) 안에서 돈다. 진행 중 run(lockdir)은 스킵 — 그 run이 spawn 중일 수 있어 레이스 방지.
  # 무동작이면 WATCHDOG_QUIET로 조용히(run.log 무한 증식 방지). heal/escalate 액션 로그는 watchdog.sh가 무조건 출력.
  now=$(date +%s); lastwd=$(cat "$STATE/.last_watchdog" 2>/dev/null || echo 0)
  if (( now - lastwd >= 60 )); then
    echo "$now" > "$STATE/.last_watchdog"
    for CFG in $ROOT/loops/*/config.json(N); do
      [[ -f "$CFG" ]] || continue
      lid="$(field "$CFG" id)"; [[ -z "$lid" ]] && continue
      [[ -d /tmp/loop-$lid.lockdir ]] && continue
      WATCHDOG_QUIET=1 "$ROOT/bin/watchdog.sh" "$lid" >> "$ROOT/loops/$lid/state/run.log" 2>&1
    done
  fi

  sleep 15
done
