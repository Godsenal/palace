#!/bin/zsh
# spawn-liveness 워치독 (재설계): "in-flight = Linear started" 를 권위 소스로 죽은/멈춘 worker를 자가복구(heal)하거나
# 반복 실패 시 escalate(사람에게 표면화)한다. 결정론적·멱등. dispatch.sh가 리퍼와 같은 ≤60s 케이던스로 호출(진행 중 run은 lockdir로 스킵).
#
# 왜 재설계했나(근본원인):
#   구버전은 후보 = 현존 worktree, In Progress 게이트 = snapshot.json 이었다. 둘 다 새는 근원:
#     • worktree만 후보 → worktree 없이 Linear만 started인 "유령"(크래시 후 worktree 소멸/미생성)을 못 본다.
#     • snapshot(orchestrator가 시간당 1회 기록)은 Linear보다 최대 1주기 뒤처져 → started를 Backlog로 오인해 스킵.
#   ⇒ 이제 후보 = Linear "started"(항상 신선). 탭 생존은 신뢰 가능한 신호다(cmux 탭은 --command 종료 시 auto-close → "탭 없음"="OMP 종료").
#
# 판정 (후보 = Linear started slug):
#   • Linear completed/canceled  → 종료 → 리퍼(cleanup-terminal) 담당 → liveness 제거.
#   • (pr 모드) 브랜치에 PR이 하나라도 있음(open/merged/closed) = 배달 완료 → 소관 아님 → liveness 제거.
#     ⚠️ **탭 유무 무관으로 먼저 판정하고, open만 보지 말 것.** 워커는 PR을 연 뒤에도 종료하지 않고 프롬프트에서 idle이며,
#        사람이 머지한 직후엔 Linear가 아직 started(리컨사일 전) + open PR 없음 → 안 걸러내면 idle 화면을 정지로 보고 wedged 오탐한다.
#   • live 탭 있음(In Review 아님):
#       - 화면 정지(read-screen 해시가 WEDGE_SEC 이상 불변) → **wedged**: 사람에게 표면화만(자동 kill 안 함 — 오탐 시 멀쩡한 worker를 죽일 수 있어 보수적).
#       - 화면 변화 있음 → 건강(진행중) → dead/escalated/wedged 클리어(scrhash만 유지).
#   • live 탭 없음(=OMP 종료, In Review 아님):
#       - worktree 없음(=진행분 없는 유령) → watchdog은 손대지 않는다. over-cap spawn(cap 무시) 대신 리퍼(cleanup-terminal)가
#         linear-move로 Backlog 회수 → orchestrator가 cap·우선순위 안에서 재spawn. (이 유령이 in-flight를 붙잡아 cap을 막던 게 "루프 정지"의 근원.)
#       - worktree 있음(=진행분 있음) → 죽은 In Progress:
#           · 첫 감지 → deadSince 기록, grace(LOOP_WATCHDOG_GRACE_SEC=90s) 대기(spawn 직후 rename 레이스 방지).
#           · grace 경과 & attempts<LOOP_HEAL_MAX(2) → heal-worker.sh 로 그 worktree에서 resume(진행분 보존·1:1 대체 → 동시성 불변), attempts++.
#           · attempts>=MAX → escalated=true. churn 중단 → 서버가 attention:"stuck"으로 표면화(대시보드🔴+Telegram).
#   • Linear 미가용(키 없음/오프라인) → snapshot In Progress를 후보로 폴백(구버전 동작 보존).
# 안전: 머지/배포/force-push/worktree 삭제/Linear 취소 없음 — 재기동(cmux 탭)과 liveness.json 쓰기만. wedged는 표면화만(kill 없음).
# usage: watchdog.sh <loop-id>   (env: WATCHDOG_QUIET=1 무동작 요약 억제, LOOP_HEAL_MAX, LOOP_WATCHDOG_GRACE_SEC, LOOP_WEDGE_SEC)
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: watchdog.sh <loop-id>}"
ROOT="$LOOPS_HOME"; LOOPDIR=$ROOT/loops/$LOOP; STATE=$LOOPDIR/state; CFG=$LOOPDIR/config.json
[[ -f "$CFG" ]] || { echo "loop '$LOOP' config 없음 — skip"; exit 0; }
REPO="$(cfgval "$CFG" repo)"; PREFIX="$(cfgval "$CFG" worktreePrefix)"; PID="$(cfgval "$CFG" linearProjectId)"
LABEL="$(cfgval "$CFG" linearLabel)"   # 공유 프로젝트 라벨 분리 — 비면 프로젝트 전체(기존 동작). started/terminal 집합을 이 라벨로 스코프.
BRPFX="$(cfgval "$CFG" branchPrefix)"; [[ -z "$BRPFX" ]] && BRPFX="loop-$LOOP"
DELIVERY="$(cfgval "$CFG" delivery)"; [[ -z "$DELIVERY" ]] && DELIVERY=pr
BASEREF="$(cfgval "$CFG" baseRef)"; [[ -z "$BASEREF" ]] && BASEREF=origin/develop   # 미머티리얼라이즈 시체의 "커밋 0" 판정 기준.
CMUX="$CMUX_BIN"; GH="$GH_BIN"
[[ -z "$REPO" || -z "$PREFIX" ]] && { echo "repo/worktreePrefix 없음 — skip"; exit 0; }
HEAL_MAX=${LOOP_HEAL_MAX:-2}
GRACE=${LOOP_WATCHDOG_GRACE_SEC:-90}
WEDGE_SEC=${LOOP_WEDGE_SEC:-300}   # 화면이 이 시간 이상 불변이면 wedge로 표면화(진행중 OMP는 타이머/스피너로 매초 화면이 변함).
# 배달 후(OPEN PR) 상주 monitor가 굳은 걸 판정하는 임계. 일반 wedge(300s)보다 훨씬 길게 잡는다 — monitor는 폴링 사이에
# 정당하게 조용하고, 실측 정상치가 open→merge 67~103분이라 짧게 잡으면 멀쩡한 감시를 정체로 오탐한다.
MERGE_WEDGE_SEC=${LOOP_MERGE_WEDGE_SEC:-3600}
CORPSE_PASSES=${LOOP_CORPSE_PASSES:-3}   # 미머티리얼라이즈 시체 판정: pidfile 없음+커밋 0+빈 화면이 이 패스 수만큼 연속돼야 닫는다(플레이크 방어).
LIVENESS="$STATE/liveness.json"

# liveness.json 조작 (원자적 read-modify-write, 파싱 실패는 빈 객체로 안전 복구).
lv_get(){ node -e 'const fs=require("fs"),[f,id,k]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}const e=o[id]||{};process.stdout.write(e[k]!=null?String(e[k]):"")' "$LIVENESS" "$1" "$2"; }
lv_set(){ node -e 'const fs=require("fs"),[f,id,p]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}o[id]=Object.assign({},o[id]||{},JSON.parse(p));fs.writeFileSync(f,JSON.stringify(o))' "$LIVENESS" "$1" "$2"; }
lv_put(){ node -e 'const fs=require("fs"),[f,id,p]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}o[id]=JSON.parse(p);fs.writeFileSync(f,JSON.stringify(o))' "$LIVENESS" "$1" "$2"; }
lv_del(){ node -e 'const fs=require("fs"),[f,id]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}if(o[id]!=null){delete o[id];fs.writeFileSync(f,JSON.stringify(o))}' "$LIVENESS" "$1"; }
lv_keys(){ node -e 'const fs=require("fs");let o={};try{o=JSON.parse(fs.readFileSync(process.argv[1]))}catch{}process.stdout.write(Object.keys(o).join("\n"))' "$LIVENESS"; }

# 죽은 껍데기 탭 감지·폐기 (cmux 재시작 세션복원 등): worker-run이 남긴 pidfile의 프로세스가 죽었으면 그 탭은
# 타이틀(🛠|↩)만 남은 빈 쉘이다 — 산 것으로 오인하면 wedged 오탐 + heal 차단(GOD-28), 그리고 상주 monitor 도입 후엔
# DELIVERED(In Review) 이슈의 시체 탭이 rework/heal의 live-탭 dedup을 영구 차단한다 → DELIVERED 분기에서도 걷어낸다.
# pidfile 없는 탭(구버전 워커·수동 resume)은 판정하지 않는다(보수적). 반환 0 = 시체를 닫음, 1 = 대상 아님/살아있음.
close_if_corpse(){ # $1=tab-ref $2=issue-id
  local ref="$1" id="$2" pidf="$STATE/live/$2.pid"
  [[ -n "$ref" && -f "$pidf" ]] || return 1
  kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null && return 1
  "$CMUX" close-workspace --workspace "$ref" >/dev/null 2>&1
  rm -f "$pidf"
  echo "💀 watchdog $LOOP/$id — 탭은 있으나 worker 프로세스 죽음(cmux 재시작 복원 탭?) → 탭 닫음"
  print -r -- "{\"ts\":$now,\"type\":\"worker\",\"event\":\"dead-tab-closed\",\"issue\":\"$id\"}" >> "$STATE/runs.jsonl"
  return 0
}

# 미머티리얼라이즈 시체 탭 감지·폐기 (GOD-59): cmux lazy-PTY로 --command가 발화되지 않은 워커 탭은 worker-run.sh가
# 한 줄도 안 돌아 pidfile이 없고(worker-run:15가 시작 즉시 기록하므로 부재=미실행), 화면이 렌더된 적 없어 read-screen이
# 계속 빈 응답이며, worktree는 baseRef 그대로(커밋 0)다 — pidfile-corpse도 wedge도 heal도 못 잡는 사각(started+🛠탭+
# pidfile 없음+빈 화면)이라 In Progress 슬롯을 영구 점유한다(GOD-37·47·52). 이 세 신호가 CORPSE_PASSES 패스 연속
# 겹칠 때만 죽은 껍데기로 판정해 탭을 닫는다 → 다음 패스에서 "탭 없음+worktree 있음" 정상 heal 경로로 재기동된다.
# 보수성(수용기준): pidfile이 있거나(=worker-run이 돎) 커밋이 하나라도 있거나(=진행분) 화면이 한 번이라도 non-empty면
# (=렌더됨, 카운터가 리셋됨) 절대 대상 아님 — "느리지만 정상"인 워커를 죽이지 않는다. 빈 화면은 일시적 read 플레이크
# 일 수도 있으나, 플레이크는 임계 전에 화면이 뜨거나 pidfile이 생겨 카운터가 리셋되므로 연속 임계를 못 넘는다.
# 반환 0 = 시체를 닫음, 1 = 대상 아님/임계 미만(계속 관망). worktree 삭제/Linear 이동 없음(탭만 닫음).
close_if_dead_shell(){ # $1=tab-ref $2=issue-id $3=slug
  local ref="$1" id="$2" sl="$3" pidf="$STATE/live/$2.pid"
  [[ -n "$ref" ]] || return 1
  [[ -f "$pidf" ]] && return 1                                  # pidfile 있음 = worker-run 실행됨 → close_if_corpse 소관, 여기 아님
  local wt="${PREFIX}-${sl}"
  [[ -d "$wt" ]] || return 1                                    # worktree 없음 = 이 케이스 아님(유령 경로가 처리)
  local ahead; ahead="$(git -C "$wt" rev-list --count "${BASEREF}..HEAD" 2>/dev/null)"
  [[ "$ahead" == "0" ]] || return 1                             # 커밋≥1(또는 판정불가) = 진행분/불확실 → 절대 건드리지 않음(보수)
  local n; n="$(lv_get "$id" noMatEmpty)"; [[ -z "$n" ]] && n=0; n=$(( n + 1 ))
  if (( n < CORPSE_PASSES )); then
    lv_set "$id" "{\"noMatEmpty\":$n}"; return 1                # 임계 미만 → 보류(연속 카운트 누적)
  fi
  "$CMUX" close-workspace --workspace "$ref" >/dev/null 2>&1
  lv_set "$id" "{\"noMatEmpty\":0}"
  echo "💀 watchdog $LOOP/$id — pidfile 없음·커밋 0·화면 ${n}패스 연속 빈응답 = 미머티리얼라이즈 시체 → 탭 닫음(다음 패스 heal)"
  print -r -- "{\"ts\":$now,\"type\":\"worker\",\"event\":\"dead-shell-closed\",\"issue\":\"$id\"}" >> "$STATE/runs.jsonl"
  return 0
}

# 1) Linear 권위 상태 — slug→statusType, slug→id. "started"(In Progress ∪ In Review)가 in-flight 집합.
#    (LINEAR_API_KEY는 loops.env에 export 안 돼 있어 node 자식에 명시 전달. cleanup-terminal.sh와 동일 패턴.)
typeset -A STATE_OF SLUGID STARTED TERMINAL
linear_n=0
if [[ -n "$PID" && -n "${LINEAR_API_KEY:-}" ]]; then
  while IFS=$'\t' read -r id t; do
    [[ -z "$id" ]] && continue
    sl="$(slugof "$id")"; SLUGID[$sl]="$id"; STATE_OF[$sl]="$t"; (( linear_n++ ))
    [[ "$t" == "started" ]] && STARTED[$sl]=1
    [[ "$t" == "completed" || "$t" == "canceled" ]] && TERMINAL[$sl]=1
  done < <(LINEAR_API_KEY="${LINEAR_API_KEY:-}" node "$ROOT/bin/linear-states.mjs" "$PID" "$LABEL" 2>/dev/null)
fi

# 1b) 폴백 — Linear 0건이면 snapshot In Progress를 in-flight로(구버전 동작). Done/Canceled는 terminal veto.
SNAP="$STATE/snapshot.json"
if (( linear_n == 0 )) && [[ -f "$SNAP" ]]; then
  while IFS=$'\t' read -r sl id st; do
    [[ -z "$sl" ]] && continue
    [[ -z "${SLUGID[$sl]:-}" ]] && SLUGID[$sl]="$id"
    [[ "$st" == "In Progress" ]] && STARTED[$sl]=1
    [[ "$st" == "Done" || "$st" == "Canceled" ]] && TERMINAL[$sl]=1
  done < <(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));for(const i of (s.issues||[])){const g=String(i.id||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/-+$/,"");process.stdout.write(g+"\t"+(i.id||"")+"\t"+(i.state||"")+"\n")}' "$SNAP" 2>/dev/null)
fi

# 2) live 탭(🛠|↩ <loop> <id>) slug→ref.
# ⚠️ cmux CLI 플레이크(빈 응답/타임아웃) 가드: 디스패처 자신이 cmux 탭에서 돌므로 정상이면 목록이 빌 수 없다.
#    빈 응답을 "탭 전멸"로 믿으면 산 워커 전부를 죽은 것으로 오인 → heal 폭풍(중복 ↩ 탭, 실제 사고). 판정 불가 = 패스 skip.
typeset -A TAB_REF
if [[ -n "$CMUX" ]]; then
  CMUX_TABS="$("$CMUX" list-workspaces 2>/dev/null)"
  if [[ -z "$CMUX_TABS" ]]; then
    echo "⚠️ watchdog $LOOP — cmux list-workspaces 빈 응답(플레이크?) → 이번 패스 전체 skip"
    exit 0
  fi
  while IFS= read -r line; do
    ref="$(print -r -- "$line" | grep -oE 'workspace:[0-9]+' | head -1)"
    # ⚠️ cmux는 현재 선택된 워크스페이스 줄 끝에 "[selected]"를 붙인다 — $NF를 그대로 쓰면 선택된 워커 탭의
    #    이슈 ID가 "[selected]"로 오파싱된다(실제 사고: 리퍼가 산 워커 탭을 고아로 닫음). 마커 제거 후 마지막 토큰.
    id="$(print -r -- "$line" | sed -E 's/[[:space:]]*\[selected\][[:space:]]*$//' | awk '{print $NF}')"
    [[ -z "$ref" || -z "$id" ]] && continue
    TAB_REF[$(slugof "$id")]="$ref"
  done < <(print -r -- "$CMUX_TABS" | grep -iE "(🛠|↩)[[:space:]]+${LOOP}[[:space:]]")
fi

# 2b) 현존 worker worktree(${PREFIX}-<slug>) — 죽은 worker의 "진행분 보존 resume" 여부 판단용.
#     worktree 있음 = 진행분 있음 → resume heal. worktree 없음 = 유령 → 리퍼가 Backlog로 회수(watchdog은 over-cap spawn 안 함).
typeset -A WT_EXISTS
while IFS= read -r p; do
  [[ "$p" == "${PREFIX}-"* ]] || continue
  WT_EXISTS[${p#"$PREFIX"-}]=1
done < <(git -C "$REPO" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')

# 3) (pr 모드) 브랜치에 PR이 **하나라도** 있으면(open/merged/closed) = 워커가 배달을 마친 것 → wedge·heal 대상 아님.
#    ⚠️ open만 보면 안 된다: 사람이 머지한 직후(merged)엔 Linear가 아직 started인데(orchestrator STEP1 리컨사일 전)
#       OMP 워커는 프롬프트에서 idle → open PR 없다고 wedged로 오탐한다. merged=Done대기, closed=Canceled대기, 모두 "배달됨".
#    gh는 cwd로 레포를 잡는다(origin이 mirror여도 로컬 레포 기준 — PR URL 추측 금지 원칙과 동일).
#    ⚠️ 단 "소관 아님"이 곧 "복구 액터 있음"은 아니다 — OPEN PR 상태로 상주 monitor가 굳으면 heal도 wedge도 안 걸려
#       아무도 안 움직인다. 그래서 OPEN 여부를 따로 들고 아래에서 머지단계 정체만 표면화한다(PR_OPEN).
typeset -A DELIVERED PR_OPEN PR_NUM
if [[ "$DELIVERY" != "direct" && -n "$GH" && -n "$REPO" ]]; then
  while IFS=$'\t' read -r br pst pnum; do
    [[ "$br" == "${BRPFX}/"* ]] || continue
    psl="$(slugof "${br#${BRPFX}/}")"
    DELIVERED[$psl]=1
    [[ "$pst" == "OPEN" ]] && { PR_OPEN[$psl]=1; PR_NUM[$psl]="$pnum" }
  done < <(cd "$REPO" && "$GH" pr list --search "head:${BRPFX}/" --state all --json headRefName,state,number --limit 200 -q '.[] | [.headRefName, .state, (.number|tostring)] | @tsv' 2>/dev/null)
fi

now=$(date +%s)
healed=0; escalated=0; waiting=0; cleared=0; wedged_n=0; ghost_n=0; mwedged_n=0
for sl in ${(k)STARTED}; do
  id="${SLUGID[$sl]:-${sl:u}}"
  if [[ -n "${TERMINAL[$sl]:-}" ]]; then
    lv_del "$id"; (( cleared++ )); continue                    # started+terminal 모순 방어 — 리퍼 담당
  fi
  if [[ -n "${DELIVERED[$sl]:-}" ]]; then
    # (pr 모드) 브랜치에 PR 존재(배달됨: In Review/Done대기/Canceled대기) → 소관 아님. **탭 유무 무관** — 워커가 PR 열고
    # 상주 monitor로 탭이 살아있어도, 사람이 머지한 직후여도 wedge/heal로 오탐하면 안 되므로 여기서 먼저 걸러낸다.
    # 단 시체 탭만은 여기서도 걷는다 — 안 걷으면 rework/heal의 live-탭 dedup이 영구 차단돼 새 피드백이 처리되지 않는다.
    if ! close_if_corpse "${TAB_REF[$sl]:-}" "$id"; then
      # ── 머지단계 wedge 표면화 ──
      # 배달된 이슈는 위 게이트로 heal·wedge 대상에서 빠지므로, PR이 OPEN인 채 상주 monitor가 굳으면 **복구할 액터가
      # 구조적으로 존재하지 않는다**(실측: 3구간 누적 ~7.5h 손실). 이 공백이 "오케스트레이터가 직접 머지하라"는 우회
      # 학습을 낳아 no-merge 불변식을 침식했다 — 그래서 엔진이 대신 **사람에게 표면화**한다.
      # 여기서 머지·kill·push는 하지 않는다. 머지는 여전히 사람 게이트고, 이건 그 게이트를 깨우는 신호일 뿐이다.
      mref="${TAB_REF[$sl]:-}"
      if [[ -n "${PR_OPEN[$sl]:-}" && -n "$mref" ]]; then
        mscr="$("$CMUX" read-screen --workspace "$mref" --lines 24 2>/dev/null)"
        if [[ -n "$mscr" ]]; then    # 빈 응답은 읽기 플레이크 — 해시하면 상수라 정체로 오탐한다(일반 wedge와 동일 이유)
          mh="$(print -r -- "$mscr" | shasum | awk '{print $1}')"
          pmh="$(lv_get "$id" mscrhash)"; pmat="$(lv_get "$id" mscrAt)"
          if [[ "$mh" != "$pmh" ]]; then
            lv_put "$id" "{\"mscrhash\":\"$mh\",\"mscrAt\":$now}"      # 화면 변화 = monitor 살아있음 → 정상
            (( cleared++ )); continue
          fi
          [[ -z "$pmat" ]] && pmat=$now
          if (( now - pmat >= MERGE_WEDGE_SEC )); then
            [[ "$(lv_get "$id" mergeWedged)" == "true" ]] || \
              echo "🔀 watchdog $LOOP/$id — PR #${PR_NUM[$sl]:-?} OPEN인데 배달 후 $(( (now-pmat)/60 ))분째 정체 → 사람 표면화 (머지 안 함)"
            lv_put "$id" "{\"mergeWedged\":true,\"prNum\":\"${PR_NUM[$sl]:-}\",\"mscrhash\":\"$mh\",\"mscrAt\":$pmat}"
            (( mwedged_n++ )); continue
          fi
          lv_put "$id" "{\"mscrhash\":\"$mh\",\"mscrAt\":$pmat}"       # 임계 미만 → 관망
          (( waiting++ )); continue
        fi
      fi
    fi
    lv_del "$id"; (( cleared++ )); continue
  fi
  ref="${TAB_REF[$sl]:-}"
  if [[ -n "$ref" ]]; then
    # ── 죽은 껍데기 탭 감지 → 닫고 이번 패스는 넘긴다 → 다음 패스(≤60s)에 "탭 없음+worktree 있음" 정상 경로로 heal.
    if close_if_corpse "$ref" "$id"; then
      (( waiting++ )); continue
    fi
    # ── 탭 살아있음 → wedge(화면 정지) 검사 ──
    # ⚠️ read-screen 빈 응답은 "화면이 비었다"가 아니라 읽기 실패/플레이크 또는 미머티리얼라이즈다 — 빈 입력의 shasum은
    #    상수라 그대로 해시하면 "정지"로 오탐된다(실제 사고: wedged 오탐 3건). 그래서 빈 응답은 여기서 해시하지 않는다.
    scr="$("$CMUX" read-screen --workspace "$ref" --lines 24 2>/dev/null)"
    if [[ -z "$scr" ]]; then
      # 빈 응답이 연속되면 미머티리얼라이즈 시체일 수 있다(GOD-59) — pidfile 없음+커밋 0과 겹쳐 CORPSE_PASSES 연속이면
      # 탭을 닫는다(다음 패스에 heal). 플레이크(일시적 빈 응답)는 임계 전 화면이 떠 아래 리셋으로 카운터가 풀린다.
      close_if_dead_shell "$ref" "$id" "$sl"
      (( waiting++ )); continue
    fi
    # 화면 non-empty = 렌더됨(머티리얼라이즈 확인) → 미머티리얼라이즈 연속 카운터 리셋(진짜 "연속"만 임계에 도달).
    [[ -z "$(lv_get "$id" noMatEmpty)" ]] || lv_set "$id" "{\"noMatEmpty\":0}"
    h="$(print -r -- "$scr" | shasum | awk '{print $1}')"
    prevh="$(lv_get "$id" scrhash)"; prevat="$(lv_get "$id" scrAt)"
    if [[ "$h" != "$prevh" ]]; then
      lv_put "$id" "{\"scrhash\":\"$h\",\"scrAt\":$now,\"attempts\":0}"   # 진행중 → 건강(dead/escalated/wedged 클리어, scr만 유지)
      (( cleared++ )); continue
    fi
    [[ -z "$prevat" ]] && prevat=$now
    if (( now - prevat >= WEDGE_SEC )); then
      [[ "$(lv_get "$id" wedged)" == "true" ]] || echo "🥶 watchdog $LOOP/$id — 화면 $(( (now-prevat)/60 ))분째 정지(wedged) → 사람 표면화 (자동 kill 안 함)"
      lv_set "$id" "{\"wedged\":true,\"scrhash\":\"$h\",\"scrAt\":$prevat}"
      (( wedged_n++ ))
    else
      (( waiting++ ))                                            # 정지 임계 미만 → 관망
    fi
    continue
  fi
  # ── 탭 없음 = OMP 종료 ── (In Review=open PR는 위에서 이미 걸러짐)
  if [[ -z "${WT_EXISTS[$sl]:-}" ]]; then
    # worktree 없음 = 진행분 없는 유령(started인데 탭·worktree·PR 전부 없음). watchdog은 spawn하지 않는다:
    #   over-cap spawn(cap 무시) 대신 리퍼(cleanup-terminal)가 linear-move로 Backlog 회수 → orchestrator가 cap 안에서 재spawn.
    (( ghost_n++ )); continue
  fi
  # 죽은 In Progress (worktree 존재 = 진행분 있음) → 그 worktree에서 resume heal(진행분 보존)
  deadSince="$(lv_get "$id" deadSince)"
  if [[ -z "$deadSince" ]]; then
    lv_set "$id" "{\"deadSince\":$now,\"attempts\":0}"; (( waiting++ )); continue   # 첫 감지
  fi
  (( now - deadSince < GRACE )) && { (( waiting++ )); continue; }                    # grace 대기
  [[ "$(lv_get "$id" escalated)" == "true" ]] && continue                            # 이미 escalate — 사람 대기
  attempts="$(lv_get "$id" attempts)"; [[ -z "$attempts" ]] && attempts=0
  if (( attempts < HEAL_MAX )); then
    "$ROOT/bin/heal-worker.sh" "$LOOP" "$id" $(( attempts + 1 )) >> "$STATE/run.log" 2>&1
    lv_set "$id" "{\"attempts\":$(( attempts + 1 )),\"lastHeal\":$now,\"deadSince\":$now}"
    (( healed++ )); echo "🔧 watchdog $LOOP/$id — 자가복구 재기동 (attempt $(( attempts + 1 ))/$HEAL_MAX)"
  else
    lv_set "$id" "{\"escalated\":true}"
    (( escalated++ )); echo "🧟 watchdog $LOOP/$id — ${HEAL_MAX}회 자가복구 실패 → escalate (stuck, 사람 판단 대기)"
  fi
done

# GC — Linear 신선할 때만: 더는 started 아닌(=해소된) liveness 엔트리 제거(대시보드 유령카드 잔상 방지).
if (( linear_n > 0 )); then
  for id in ${(f)"$(lv_keys)"}; do
    [[ -z "$id" ]] && continue
    [[ -z "${STARTED[$(slugof "$id")]:-}" ]] && lv_del "$id"
  done
fi

[[ -z "${WATCHDOG_QUIET:-}" ]] && echo "🐕 watchdog $LOOP — started ${#STARTED}개 · heal ${healed} · escalate ${escalated} · wedged ${wedged_n} · 머지정체 ${mwedged_n} · 유령 ${ghost_n}(리퍼회수) · 대기 ${waiting} · clear ${cleared}"
exit 0
