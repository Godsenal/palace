#!/bin/zsh
# 종료된 이슈 1건의 리소스 정리(멱등): cmux 워크스페이스 닫기 + worktree 제거 + 브랜치 삭제.
# 호출자가 이 이슈가 종료 상태(Done/Canceled)임을 보장한다 — 여기서는 상태 검증 안 함.
# usage: cleanup-issue.sh <loop-id> <issue-id>
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: cleanup-issue.sh <loop-id> <issue-id>}"
ID="${2:?usage: cleanup-issue.sh <loop-id> <issue-id>}"
ROOT="$LOOPS_HOME"; STATE=$ROOT/loops/$LOOP/state; CFG=$ROOT/loops/$LOOP/config.json
CMUX="$CMUX_BIN"
REPO="$(cfgval "$CFG" repo)"
PREFIX="$(cfgval "$CFG" worktreePrefix)"; BRPFX="$(cfgval "$CFG" branchPrefix)"; [[ -z "$BRPFX" ]] && BRPFX="loop-$LOOP"

# slug/WT/BR 산출 — _common.sh의 slugof()가 단일 원천(spawn-worker.sh와 동일 규칙).
slug="$(slugof "$ID")"
WT="${PREFIX}-${slug}"; BR="${BRPFX}/${slug}"

did=0

# 1. cmux 워크스페이스 닫기. ref(workspace:N)는 불안정 → 제목으로 매칭(대시보드 tabByIssue 패턴과 동일).
#    워커 🛠·resume ↩·종료마킹 ⏹ + 검증 탭 🧪(validator)·🔎(verifier)까지. ID 뒤는 공백/줄끝 경계 → LIN-12가 LIN-123을 오매칭 안 하게.
#    (🧪/🔎는 각 run이 EXIT 트랩으로 자가 정리하지만, 트랩 없이 죽은 라이브 타이틀 탭의 2중 안전망 — vv-리퍼가 상시 걷지만 여기서도 확실히.)
#    ⚠️ TAB_TRUTH: cmux list-workspaces는 간헐적으로 **빈 응답**을 준다(RPC 플레이크 — 정상 응답 사이에 수 초간
#    빈 응답 버스트가 실측된다). 빈 목록을 "닫을 탭 없음"으로 믿으면 worktree·브랜치만 지우고 탭은 영구히 남는데,
#    worktree가 사라진 뒤라 리퍼의 "종료 이슈" 분기가 탭을 못 찾으면 아무도 회수하지 않는다
#    → "머지됐는데 cmux 탭이 안 닫힘"의 근원. cleanup-terminal.sh는 같은 이유로 TAB_TRUTH 가드를 갖고 있는데
#    여기엔 없어서 조용히 실패했다. 재시도하고, 그래도 비면 **loud하게** 남긴다(무음 실패 금지).
tabs=""
if [[ -n "$CMUX" ]]; then
  for _try in 1 2 3; do
    tabs="$("$CMUX" list-workspaces 2>/dev/null)"
    [[ -n "$tabs" ]] && break
    sleep 1
  done
  if [[ -z "$tabs" ]]; then
    echo "⚠️ cleanup-issue $LOOP/$ID — cmux list-workspaces 3회 연속 빈 응답(플레이크) → 탭 닫기 skip. worktree/브랜치는 정리하고, 탭은 다음 리퍼 패스가 회수한다."
  else
    refs="$(print -r -- "$tabs" | grep -iE "(🛠|↩|⏹|🧪|🔎)[[:space:]]+${LOOP}[[:space:]]+${ID}([[:space:]]|\$)" | grep -oE 'workspace:[0-9]+')"
    # close 실패도 조용히 넘기지 않는다 — 실패를 삼키면 위와 똑같이 탭만 남는다.
    for r in ${(f)refs}; do
      if "$CMUX" close-workspace --workspace "$r" >/dev/null 2>&1; then did=1
      else echo "⚠️ cleanup-issue $LOOP/$ID — close-workspace $r 실패 → 다음 리퍼 패스가 재시도한다."; fi
    done
  fi
fi
# 상주 monitor를 close-workspace로 죽이면 worker-run의 on_exit trap이 못 탈 수 있다 → stale pidfile 직접 걷기(멱등).
# 워커(live)·validator(validate)·verifier(verify) pidfile 모두 — 탭을 강제로 닫으면 트랩이 못 지운 잔재가 남을 수 있다.
rm -f "$STATE/live/$ID.pid" "$STATE/validate/$ID.pid" "$STATE/verify/$ID.pid" 2>/dev/null

# 2. worktree·브랜치 제거(멱등 — 없으면 조용히 통과). PREFIX/REPO 비면 경로 사고 방지로 건너뜀.
#    검증 전용 worktree(${WT}-vf verifier, ${WT}-vd validator)도 함께 — 각 run이 자가 정리하지만 크래시 잔재의 2중 안전망.
if [[ -n "$REPO" && -n "$PREFIX" ]]; then
  [[ -d "$WT" ]] && did=1
  git -C "$REPO" worktree remove --force "$WT" 2>/dev/null
  git -C "$REPO" worktree remove --force "${WT}-vf" 2>/dev/null
  git -C "$REPO" worktree remove --force "${WT}-vd" 2>/dev/null
  git -C "$REPO" worktree prune 2>/dev/null
  git -C "$REPO" branch -D "$BR" 2>/dev/null && did=1
fi

# 실제로 뭔가 제거했을 때만 기록(빈 호출이 runs.jsonl·피드를 오염시키지 않게).
if (( did )); then
  ts=$(date '+%s')
  print -r -- "{\"ts\":$ts,\"type\":\"worker\",\"event\":\"cleaned\",\"issue\":\"$ID\",\"branch\":\"$BR\"}" >> "$STATE/runs.jsonl"
  echo "cleaned $LOOP/$ID → worktree=$WT branch=$BR"
else
  echo "nothing to clean for $LOOP/$ID (no tab/worktree/branch)"
fi
