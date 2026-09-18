#!/bin/zsh
# 루프 1개의 모든 리소스 정리(멱등): 워커 worktree 전부 + orchestrator worktree + 관련 cmux 탭.
# 루프 폐기(대시보드 delete-loop / loopctl cleanup) 시 호출. config 가 아직 있어야 한다 — rm -rf 보다 먼저.
# usage: cleanup-loop.sh <loop-id>
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: cleanup-loop.sh <loop-id>}"
ROOT="$LOOPS_HOME"; CFG=$ROOT/loops/$LOOP/config.json
CMUX="$CMUX_BIN"
[[ -f "$CFG" ]] || { echo "loop '$LOOP' config 없음 — 정리 대상 없음"; exit 0; }
REPO="$(cfgval "$CFG" repo)"; PREFIX="$(cfgval "$CFG" worktreePrefix)"; ORCHWT="$(cfgval "$CFG" orchestratorWorktree)"

# 1. 워커 worktree(${PREFIX}-<slug>) 전부 제거 — loopctl worktrees 의 열거 로직 재사용.
#    git worktree list 기준으로만 추려 ${PREFIX}- 로 시작하는 것만(orchestrator/main 제외). 각 브랜치도 -D.
if [[ -n "$REPO" && -n "$PREFIX" ]]; then
  wt=""; br=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        # 직전 항목 처리
        if [[ -n "$wt" && "$wt" == "${PREFIX}-"* ]]; then
          git -C "$REPO" worktree remove --force "$wt" 2>/dev/null
          [[ -n "$br" ]] && git -C "$REPO" branch -D "$br" 2>/dev/null
          echo "removed worktree $wt ${br:+(branch $br)}"
        fi
        wt="${line#worktree }"; br="" ;;
      "branch refs/heads/"*) br="${line#branch refs/heads/}" ;;
    esac
  done <<< "$(git -C "$REPO" worktree list --porcelain 2>/dev/null)"
  # 마지막 항목
  if [[ -n "$wt" && "$wt" == "${PREFIX}-"* ]]; then
    git -C "$REPO" worktree remove --force "$wt" 2>/dev/null
    [[ -n "$br" ]] && git -C "$REPO" branch -D "$br" 2>/dev/null
    echo "removed worktree $wt ${br:+(branch $br)}"
  fi
  # 2. orchestrator worktree (detached, ${PREFIX} 와 별개일 수 있음)
  [[ -n "$ORCHWT" && -d "$ORCHWT" ]] && { git -C "$REPO" worktree remove --force "$ORCHWT" 2>/dev/null; echo "removed orchestrator worktree $ORCHWT"; }
  git -C "$REPO" worktree prune 2>/dev/null
fi

# 3. 이 루프의 cmux 탭(워커 🛠 / resume ↩) 전부 닫기.
if [[ -n "$CMUX" ]]; then
  refs="$("$CMUX" list-workspaces 2>/dev/null | grep -E "(🛠|↩|⏹)[[:space:]]+${LOOP}[[:space:]]" | grep -oE 'workspace:[0-9]+')"
  for r in ${(f)refs}; do "$CMUX" close-workspace --workspace "$r" >/dev/null 2>&1; done
fi

echo "cleaned-loop $LOOP"
