#!/bin/zsh
# 한 루프의 죽은 worker 리소스(worktree·cmux 탭·브랜치)를 쓸어담는다(멱등). run-once.sh 및 dispatch.sh reaper가 호출.
# "종료" 판정의 권위 신호 = Linear statusType(completed|canceled). Linear 프로젝트가 곧 상태머신이기 때문.
#   snapshot은 활성 보드만 담아 Done을 빠뜨리고, origin이 mirror면 gh PR도 안 보이므로 Linear를 1차로 쓴다.
#   Linear 미가용(키 없음/오프라인)이면 snapshot의 Done/Canceled를 폴백으로 사용.
# 회수 대상 = (worker worktree) ∪ (cmux worker 탭). 둘의 수명이 어긋나도 고아가 안 남게 합집합으로 훑는다:
#   • 종료(TERMINAL)          → cleanup-issue.sh (탭+worktree+브랜치, worktree 없어도 탭 닫음).
#   • 비종료 & worktree 소멸  → 죽은 고아 탭(cwd 사라져 resume 불가) → 탭만 닫음(브랜치는 PR 살아있을 수 있어 보존).
#   • 비종료 & worktree 존재  → In Progress/Review → OMP 세션 재개용으로 보존.
# ── 추가(Linear 신선할 때만) — in-flight를 붙잡아 cap을 막던 유령/잔재를 결정론적으로 회수(구버전은 LLM orchestrator STEP1에만 의존해 새던 곳):
#   • started 유령(탭·worktree·PR(any state) 전부 없음) → linear-move로 Backlog 복귀(슬롯 해제). watchdog이 over-cap spawn 대신 여기로 넘긴다.
#   • Backlog 잔재 worktree(죽은 worker가 되돌려진 뒤 방치, 탭·PR 없음) → cleanup-issue로 worktree+브랜치 회수.
# ⚠️ Backlog 이동은 머지/취소가 아니다 — no-merge/no-cancel 원칙 불변. force-push/배포 없음.
# usage: cleanup-terminal.sh <loop-id>   (env: CLEANUP_DRY_RUN=1 → 삭제/이동 없이 대상만 출력)
# env CLEANUP_TERMINAL_ONLY=1 → **종료 이슈 정리만** 하고 유령 회수(4)·Backlog 잔재 회수(5)·검증탭 회수(6)·고아 탭 닫기는 건너뛴다.
#   왜: dispatch.sh의 60s 리퍼는 run 진행 중(lockdir)인 루프를 통째로 skip했다. 그런데 사이클이 interval보다 긴 루프
#   (예: intervalSec=120인데 사이클 8~10분)는 lockdir이 사실상 상시 점유돼 리퍼가 **영영 안 돈다** → 완료된 이슈의
#   탭·worktree가 사이클이 끝날 때까지 쌓인다("완료됐는데 작업중으로 보임"의 물리적 근원).
#   종료(completed/canceled) 이슈는 오케스트레이터의 fan-out 대상이 아니므로 그 정리만은 run 중에도 레이스가 없다.
#   반대로 4·5는 **레이스가 실재한다**: 오케스트레이터는 spawn *전에* Linear를 In Progress로 옮기므로(spawn-worker.sh:45 주석)
#   그 창에서 "started인데 탭·worktree 없음"이 정상적으로 존재한다 → 유령으로 오판해 Backlog로 되돌리면 팬아웃을 취소시킨다.
#   그래서 4·5·6과 고아 탭 닫기는 lockdir이 풀린 뒤(=이 플래그 없이 호출될 때)만 돈다.
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: cleanup-terminal.sh <loop-id>}"
ROOT="$LOOPS_HOME"; LOOPDIR=$ROOT/loops/$LOOP; STATE=$LOOPDIR/state; CFG=$LOOPDIR/config.json
[[ -f "$CFG" ]] || { echo "loop '$LOOP' config 없음 — skip"; exit 0; }
REPO="$(cfgval "$CFG" repo)"; PREFIX="$(cfgval "$CFG" worktreePrefix)"; PID="$(cfgval "$CFG" linearProjectId)"
LABEL="$(cfgval "$CFG" linearLabel)"   # 공유 프로젝트 라벨 분리 — 비면 전체. TERMINAL/STARTED/BACKLOG 집합을 이 라벨로 스코프.
BRPFX="$(cfgval "$CFG" branchPrefix)"; [[ -z "$BRPFX" ]] && BRPFX="loop-$LOOP"
DELIVERY="$(cfgval "$CFG" delivery)"; [[ -z "$DELIVERY" ]] && DELIVERY=pr
CMUX="$CMUX_BIN"; GH="$GH_BIN"
[[ -z "$REPO" || -z "$PREFIX" ]] && { echo "repo/worktreePrefix 없음 — skip"; exit 0; }

# slug→종료여부(TERMINAL)/시작(STARTED)/백로그(BACKLOG), slug→이슈id(SLUGID). slug는 _common.sh의 slugof()(spawn 정본)로 산출.
typeset -A TERMINAL STARTED BACKLOG SLUGID
# liveness.json에서 escalated 여부(사람 대기) — 유령 회수 시 escalation을 리셋하지 않기 위한 veto.
lv_escalated(){ node -e 'const fs=require("fs"),[f,id]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}process.stdout.write((o[id]&&o[id].escalated)?"true":"")' "$STATE/liveness.json" "$1"; }

# 1) 권위 신호 — Linear statusType. (LINEAR_API_KEY는 loops.env에 export 안 돼 있어 node 자식에 명시 전달.)
#    자식 stderr를 버리지 않고 캡처 — 만료/무효 키·네트워크 장애로 인한 조용한 snapshot 강등을 로그에 노출한다.
linear_n=0
if [[ -n "$PID" && -n "${LINEAR_API_KEY:-}" ]]; then
  lserr="$(mktemp)"
  while IFS=$'\t' read -r id t; do
    [[ -z "$id" ]] && continue
    sl="$(slugof "$id")"; SLUGID[$sl]="$id"; (( linear_n++ ))
    [[ "$t" == "completed" || "$t" == "canceled" ]] && TERMINAL[$sl]=1
    [[ "$t" == "started" ]] && STARTED[$sl]=1
    [[ "$t" == "backlog" ]] && BACKLOG[$sl]=1
  done < <(LINEAR_API_KEY="${LINEAR_API_KEY:-}" node "$ROOT/bin/linear-states.mjs" "$PID" "$LABEL" 2>"$lserr")
  [[ -s "$lserr" ]] && echo "⚠️ cleanup-terminal $LOOP — $(<"$lserr")" >&2
  rm -f "$lserr"
  (( linear_n == 0 )) && echo "⚠️ cleanup-terminal $LOOP — LINEAR_API_KEY 있으나 linear-states 0건(만료/네트워크 의심) → snapshot 폴백" >&2
elif [[ -z "${LINEAR_API_KEY:-}" ]]; then
  echo "ℹ️ cleanup-terminal $LOOP — LINEAR_API_KEY 미설정 → snapshot 폴백" >&2
fi

# 2) 폴백/보강 — snapshot의 Done/Canceled (Linear 0건이면 폴백, 아니면 보강).
SNAP="$STATE/snapshot.json"
if [[ -f "$SNAP" ]]; then
  while IFS=$'\t' read -r sl id st; do
    [[ -z "$sl" ]] && continue
    [[ -z "${SLUGID[$sl]:-}" ]] && SLUGID[$sl]="$id"
    [[ "$st" == "Done" || "$st" == "Canceled" ]] && TERMINAL[$sl]=1
  done < <(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));for(const i of (s.issues||[])){const g=String(i.id||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/-+$/,"");process.stdout.write(g+"\t"+(i.id||"")+"\t"+(i.state||"")+"\n")}' "$SNAP" 2>/dev/null)
fi

# 3) 회수 대상 열거 = 현존 worktree slug ∪ 현존 cmux worker 탭 slug. (process substitution으로 현재 셸에 배열 유지.)
typeset -A WT_EXISTS TAB_REFS TAB_ID
# 3a) worker worktree(${PREFIX}-<slug>) 열거.
while IFS= read -r p; do
  [[ "$p" == "${PREFIX}-"* ]] || continue
  WT_EXISTS[${p#"$PREFIX"-}]=1
done < <(git -C "$REPO" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
# 3b) 이 루프의 cmux worker 탭(🛠/↩) 열거 → slug→ref들, slug→정확한 id(제목 끝 토큰). cleanup-issue.sh와 동일 매칭 경계.
# ⚠️ TAB_TRUTH: cmux CLI 플레이크(빈 응답)면 0. "탭 부재"를 증거로 쓰는 판정(고아 탭 닫기·유령 회수·잔재 회수)은
#    TAB_TRUTH=1일 때만 — 빈 응답을 탭 전멸로 믿으면 산 워커 탭을 닫거나 진행 중 이슈를 Backlog로 되돌린다(실제 사고 계열).
tab_n=0; TAB_TRUTH=0
if [[ -n "$CMUX" ]]; then
  CMUX_TABS="$("$CMUX" list-workspaces 2>/dev/null)"
  if [[ -n "$CMUX_TABS" ]]; then
    TAB_TRUTH=1
    while IFS= read -r line; do
      ref="$(print -r -- "$line" | grep -oE 'workspace:[0-9]+' | head -1)"
      # 제목 "🛠 <loop> <ID>" → ID가 마지막 토큰. ⚠️ 단, cmux는 선택된 워크스페이스 줄 끝에 "[selected]"를 붙인다 —
      # 마커를 안 벗기면 선택된 산 워커 탭이 이슈 "[selected]"의 고아로 오인돼 닫힌다(실제 사고). 제거 후 파싱.
      id="$(print -r -- "$line" | sed -E 's/[[:space:]]*\[selected\][[:space:]]*$//' | awk '{print $NF}')"
      [[ -z "$ref" || -z "$id" ]] && continue
      sl="$(slugof "$id")"
      TAB_REFS[$sl]+="$ref "; TAB_ID[$sl]="$id"; (( tab_n++ ))
    done < <(print -r -- "$CMUX_TABS" | grep -iE "(🛠|↩)[[:space:]]+${LOOP}[[:space:]]")
  else
    echo "⚠️ reaper $LOOP — cmux list-workspaces 빈 응답(플레이크?) → 탭 부재 기반 판정(고아/유령/잔재) skip"
  fi
fi
# 3c) (pr 모드) 브랜치별 최신 PR 상태 조회. DELIVERED=PR 존재(유령 회수 veto용), 그리고 최신 PR이 **MERGED면 터미널로 승격**.
#    ⚠️ 왜 필요한가: 사람이 PR을 머지해도 Linear→Done 전환은 LLM 오케스트레이터 STEP1(시간당 1회, 워커가 In Review로 안 옮겼으면 놓침)에
#       의존한다 → 그때까지 리퍼가 "종료"로 못 보고 idle 워커 탭·worktree가 계속 쌓인다("완료됐는데 탭 안 닫힘"의 근원).
#       머지는 코드가 base에 반영된 **결정적 완료 신호**이므로 Linear 리컨사일을 기다리지 않고 여기서 바로 회수한다.
#    CLOSED(머지 없이 닫힘)는 승격하지 않는다 — 브랜치 재사용 시 이전 attempt의 닫힌 PR이 최신으로 잡혀 현재 작업 탭을 오회수할 위험이 있어
#       기존 오케스트레이터 CLOSED→Canceled 경로에 맡긴다. MERGED는 재작업이 사실상 없어 그 위험이 없다.
#    gh는 최신순 → 브랜치별 첫(=최신) PR만 채택(reopen 대비). direct는 PR 없음 → 스킵. gh는 cwd로 레포를 잡는다.
typeset -A DELIVERED PRSTATE
if [[ "$DELIVERY" != "direct" && -n "$GH" && -n "$REPO" ]]; then
  while IFS=$'\t' read -r br st; do
    [[ "$br" == "${BRPFX}/"* ]] || continue
    sl="$(slugof "${br#${BRPFX}/}")"
    DELIVERED[$sl]=1
    [[ -z "${PRSTATE[$sl]:-}" ]] && PRSTATE[$sl]="$st"
  done < <(cd "$REPO" && "$GH" pr list --search "head:${BRPFX}/" --state all --json headRefName,state --limit 200 -q '.[] | .headRefName + "\t" + .state' 2>/dev/null)
  for sl in ${(k)PRSTATE}; do [[ "${PRSTATE[$sl]}" == "MERGED" ]] && TERMINAL[$sl]=1; done
fi

# 요약줄은 무동작이어도 매번 찍힌다 → 60s reaper(CLEANUP_QUIET=1)에선 억제(run.log 무한 증식 방지). 실제 정리 액션 로그는 아래에서 무조건 출력.
[[ -z "${CLEANUP_QUIET:-}" ]] && echo "🧹 cleanup-terminal $LOOP — Linear ${linear_n}건 조회, 종료 후보 ${#TERMINAL}개, worker 탭 ${tab_n}개"

# 3c) 합집합 slug 순회 → 판정 매트릭스. id는 탭 제목(정확) > SLUGID > slug 대문자화 순.
typeset -aU ALLSLUGS; ALLSLUGS=(${(k)WT_EXISTS} ${(k)TAB_REFS})
for sl in $ALLSLUGS; do
  id="${TAB_ID[$sl]:-${SLUGID[$sl]:-${sl:u}}}"
  if [[ -n "${TERMINAL[$sl]:-}" ]]; then
    # 종료 → 풀 정리(탭+worktree+브랜치). worktree 없어도 cleanup-issue가 남은 탭을 닫는다.
    if [[ -n "${CLEANUP_DRY_RUN:-}" ]]; then echo "  [dry-run] terminal → clean $id (${PREFIX}-$sl)"; else "$ROOT/bin/cleanup-issue.sh" "$LOOP" "$id"; fi
  elif [[ -n "${CLEANUP_TERMINAL_ONLY:-}" ]]; then
    continue   # run 중 호출 — 종료 이슈만 정리한다(위 분기). 비종료 판정은 팬아웃 과도기와 구분이 안 돼 보류.
  elif [[ -z "${WT_EXISTS[$sl]:-}" && -n "${TAB_REFS[$sl]:-}" ]]; then
    # 비종료인데 worktree 소멸 + 탭 잔존 → 죽은 고아 탭. cwd가 사라져 resume 불가하므로 탭만 닫음(브랜치는 보존).
    if [[ -n "${CLEANUP_DRY_RUN:-}" ]]; then
      echo "  [dry-run] orphan(worktree 없음) → close tab $id (${TAB_REFS[$sl]% })"
    else
      for r in ${=TAB_REFS[$sl]}; do "$CMUX" close-workspace --workspace "$r" >/dev/null 2>&1; done
      ts=$(date '+%s'); print -r -- "{\"ts\":$ts,\"type\":\"worker\",\"event\":\"orphan-tab-closed\",\"issue\":\"$id\"}" >> "$STATE/runs.jsonl"
      echo "closed orphan tab $LOOP/$id (worktree 없음 — resume 불가)"
    fi
  fi
  # else: 비종료 & worktree 존재 → 진행/리뷰 중 → 보존(무동작).
done

# ⚠️ 아래 4)·5)는 Linear 상태를 바꾸거나(=4, Backlog 이동) worktree를 지운다(=5) → Linear가 신선(linear_n>0)할 때만.
#    snapshot 폴백(만료/오프라인)일 땐 오판 위험이 커서 아예 건너뛴다(보수적). lockdir 게이트가 spawn 레이스도 막는다.
#    + TAB_TRUTH: 둘 다 "live 탭 없음"을 veto 해제 증거로 쓰므로, cmux 플레이크(빈 목록)면 산 워커를 유령/잔재로 오판한다 — skip.
if (( linear_n > 0 && TAB_TRUTH )) && [[ -z "${CLEANUP_TERMINAL_ONLY:-}" ]]; then
  # 4) started 유령 회수 — Linear started인데 worktree·worker 탭·PR(any state) 전부 없음 = 진행분 없이 in-flight 슬롯만 붙잡는 유령.
  #    linear-move로 Backlog 복귀 → 슬롯 해제 → orchestrator가 cap·우선순위 안에서 재spawn. (watchdog이 spawn 대신 리퍼로 넘긴 케이스.)
  #    escalated(사람 대기)는 건너뜀 — 사람이 볼 stuck을 리셋하지 않게. 머지/취소 아님(Backlog 이동만) — no-merge 원칙 불변.
  for sl in ${(k)STARTED}; do
    [[ -n "${WT_EXISTS[$sl]:-}" || -n "${TAB_REFS[$sl]:-}" || -n "${DELIVERED[$sl]:-}" ]] && continue
    id="${SLUGID[$sl]:-${sl:u}}"
    [[ "$(lv_escalated "$id")" == "true" ]] && continue
    if [[ -n "${CLEANUP_DRY_RUN:-}" ]]; then echo "  [dry-run] ghost started(탭·worktree·PR 없음) → linear-move backlog $id"; continue; fi
    out="$(LINEAR_API_KEY="${LINEAR_API_KEY:-}" node "$ROOT/bin/linear-move.mjs" "$id" backlog 2>&1)"
    ts=$(date '+%s'); print -r -- "{\"ts\":$ts,\"type\":\"worker\",\"event\":\"ghost-reclaimed\",\"issue\":\"$id\"}" >> "$STATE/runs.jsonl"
    echo "reclaimed ghost $LOOP/$id → Backlog (in-flight 슬롯 해제) — $out"
  done

  # 5) Backlog 잔재 worktree 회수 — Linear backlog인데 worktree만 남음(죽은 worker가 Backlog로 되돌려진 뒤 방치된 잔재).
  #    보존 스코프는 In Progress/In Review 뿐 → Backlog worktree는 회수 대상. live 탭 없고(작업 중 아님) open PR 없을 때만.
  #    재spawn 때 어차피 spawn-worker가 force-remove하므로 안전 — 사이만 깔끔히 정리.
  for sl in ${(k)BACKLOG}; do
    [[ -z "${WT_EXISTS[$sl]:-}" ]] && continue
    [[ -n "${TAB_REFS[$sl]:-}" || -n "${DELIVERED[$sl]:-}" ]] && continue
    id="${SLUGID[$sl]:-${sl:u}}"
    if [[ -n "${CLEANUP_DRY_RUN:-}" ]]; then echo "  [dry-run] backlog 잔재 worktree → clean $id (${PREFIX}-$sl)"; else "$ROOT/bin/cleanup-issue.sh" "$LOOP" "$id"; fi
  done
fi

# 6) validator(🧪)/verifier(🔎) 고아 정리 — Linear 무관, TAB_TRUTH(cmux 목록이 신선=빈 응답 아님)만 필요. ──
#    검증자/검증기는 detached -vd/-vf worktree에서 headless로 돌다 EXIT 트랩으로 자가 정리하는데, cmux 앱 재시작이 트랩 없이
#    프로세스를 죽이면 (a) 타이틀 잃은 맨셸 탭 + (b) 남은 -vd/-vf worktree가 어떤 리퍼에도 안 걸려 누적됐다(sweep_panels=인프라
#    탭만 · watchdog=🛠 워커 pidfile만 — 검증 탭은 사각). validator/verifier-run이 시작 시 남기는 pidfile로 생존을 판별해
#    "죽은 것"만 탭 close + worktree 제거한다. 실행 중(pidfile 생존)·방금 스폰(🧪 타이틀+pidfile 부재)은 보수적 보존.
#    탭·worktree 정리뿐 — Linear 이동/머지/force-push 없음. cleanup-issue와 겹쳐도 remove는 멱등.
if [[ -n "$CMUX" && $TAB_TRUTH -eq 1 && -z "${CLEANUP_TERMINAL_ONLY:-}" ]]; then
  PFXBASE="${PREFIX:t}"
  # 살아있는 검증 pidfile의 슬러그 집합 — worktree·맨셸 회수의 veto(cmux 스폰 실패 시 탭 없이 도는 headless 폴백 실행 보호).
  typeset -A VV_LIVE
  for pf in "$STATE"/validate/*.pid(N) "$STATE"/verify/*.pid(N); do
    ppid="$(cat "$pf" 2>/dev/null)"
    [[ -n "$ppid" ]] && kill -0 "$ppid" 2>/dev/null && VV_LIVE[$(slugof "${pf:t:r}")]=1
  done
  vv_closed=0; vv_wt=0
  # 6a) 🧪/🔎 라이브 타이틀 탭 → pidfile로 시체 판별(worker close_if_corpse와 동일 보수성: pidfile 부재=방금 스폰 → 보존).
  while IFS= read -r line; do
    ref="$(print -r -- "$line" | grep -oE 'workspace:[0-9]+' | head -1)"; [[ -z "$ref" ]] && continue
    vid="$(print -r -- "$line" | sed -E 's/[[:space:]]*\[selected\][[:space:]]*$//' | awk '{print $NF}')"; [[ -z "$vid" ]] && continue
    if print -r -- "$line" | grep -qE "🧪[[:space:]]+${LOOP}[[:space:]]"; then vdir=validate; vsfx=vd; else vdir=verify; vsfx=vf; fi
    pidf="$STATE/$vdir/$vid.pid"
    [[ -f "$pidf" ]] && kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null && continue   # 실행 중 → 보존
    [[ -f "$pidf" ]] || continue                                                        # pidfile 부재 → 보수적 보존(끝나면 맨셸로 떨어져 6b가 회수)
    vwt="${PREFIX}-$(slugof "$vid")-${vsfx}"
    if [[ -n "${CLEANUP_DRY_RUN:-}" ]]; then echo "  [dry-run] vv-corpse → close $ref (${vsfx} $vid) + rm $vwt"; continue; fi
    "$CMUX" close-workspace --workspace "$ref" >/dev/null 2>&1 && (( vv_closed++ ))
    rm -f "$pidf" 2>/dev/null
    git -C "$REPO" worktree remove --force "$vwt" 2>/dev/null && (( vv_wt++ ))
  done < <(print -r -- "$CMUX_TABS" | grep -iE "(🧪|🔎)[[:space:]]+${LOOP}[[:space:]]")
  # 6b) 맨셸 탭(타이틀이 -vd/-vf cwd로 떨어짐 = --command 종료됨 → 프로세스 없음) → 회수. 살아있는 슬러그는 veto(방어).
  while IFS= read -r line; do
    ref="$(print -r -- "$line" | grep -oE 'workspace:[0-9]+' | head -1)"; [[ -z "$ref" ]] && continue
    base="$(print -r -- "$line" | grep -oE "${PFXBASE}-[a-z0-9][a-z0-9-]*-v[df]" | head -1)"; [[ -z "$base" ]] && continue
    vsfx="${base##*-}"; vslug="${base#${PFXBASE}-}"; vslug="${vslug%-${vsfx}}"
    [[ -n "${VV_LIVE[$vslug]:-}" ]] && continue
    if [[ -n "${CLEANUP_DRY_RUN:-}" ]]; then echo "  [dry-run] vv-shell → close $ref ($base)"; continue; fi
    "$CMUX" close-workspace --workspace "$ref" >/dev/null 2>&1 && (( vv_closed++ ))
    git -C "$REPO" worktree remove --force "${PREFIX}-${vslug}-${vsfx}" 2>/dev/null && (( vv_wt++ ))
  done < <(print -r -- "$CMUX_TABS" | grep -iE "${PFXBASE}-[a-z0-9][a-z0-9-]*-v[df]([[:space:]]|\$)")
  # 6c) 탭 없는 -vd/-vf worktree litter(트랩 없이 죽어 worktree만 남음, 게이트 제안이 터미널에 안 가 cleanup-issue -vd가 안 돎). 살아있는 슬러그는 veto.
  while IFS= read -r p; do
    case "$p" in
      "${PREFIX}-"*"-vd") vsfx=vd;; "${PREFIX}-"*"-vf") vsfx=vf;; *) continue;;
    esac
    vslug="${p#${PREFIX}-}"; vslug="${vslug%-${vsfx}}"
    [[ -n "${VV_LIVE[$vslug]:-}" ]] && continue
    if [[ -n "${CLEANUP_DRY_RUN:-}" ]]; then echo "  [dry-run] vv-litter → rm $p"; continue; fi
    git -C "$REPO" worktree remove --force "$p" 2>/dev/null && (( vv_wt++ ))
  done < <(git -C "$REPO" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  git -C "$REPO" worktree prune 2>/dev/null
  if (( vv_closed > 0 || vv_wt > 0 )); then
    ts=$(date '+%s'); print -r -- "{\"ts\":$ts,\"type\":\"validate\",\"event\":\"vv-reaped\",\"tabs\":$vv_closed,\"worktrees\":$vv_wt}" >> "$STATE/runs.jsonl"
    echo "vv-reaper $LOOP — 고아 검증 탭 ${vv_closed} · worktree ${vv_wt} 회수"
  fi
fi
