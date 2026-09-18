#!/bin/zsh
# 죽은 worker를 "진행분 보존" 방식으로 재기동한다(자가복구). spawn-worker.sh와 달리 worktree를 지우지 않는다.
#   • worktree 존재  → 그 worktree(cwd)에서 worker-run.sh 재실행 → 새 cmux 탭 "↩ <loop> <id>"(resume 탭).
#   • worktree 소멸  → spawn-worker.sh 로 위임(전체 재생성).
#   • 이미 live 탭 있음 → 중복 방지로 skip.
# 결정론적 쉘만 — 머지/배포/force-push/worktree 삭제/Linear 취소 없음. watchdog.sh 및 대시보드 heal-issue가 호출.
# usage: heal-worker.sh <loop-id> <issue-id> [attempt]
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: heal-worker.sh <loop-id> <issue-id> [attempt]}"
ID="${2:?usage: heal-worker.sh <loop-id> <issue-id> [attempt]}"
ATTEMPT="${3:-0}"
ROOT="$LOOPS_HOME"; LOOPDIR=$ROOT/loops/$LOOP; STATE=$LOOPDIR/state; CFG=$LOOPDIR/config.json
CMUX="$CMUX_BIN"
RUNNER=$ROOT/bin/worker-run.sh
[[ -f "$CFG" ]] || { echo "loop '$LOOP' config 없음 — skip"; exit 0; }
REPO="$(cfgval "$CFG" repo)"; PREFIX="$(cfgval "$CFG" worktreePrefix)"

slug="$(slugof "$ID")"
WT="${PREFIX}-${slug}"

# 이미 살아있는 worker/resume 탭(🛠|↩ <loop> <id>)이 있으면 재기동 불필요 — 중복 방지.
# ⚠️ cmux CLI가 플레이크(빈 응답/타임아웃)일 때 빈 목록을 "탭 없음"으로 믿으면 안 된다 — dedup이 뚫려
#    같은 이슈에 ↩ 탭이 계속 쌓인다(실제 사고: heal 폭풍). 디스패처 자신이 cmux 탭에서 돌므로 정상이면
#    목록이 빌 수 없다 → 빈 응답 = 판정 불가 = heal 보류(다음 패스에 재시도).
if [[ -n "$CMUX" ]]; then
  tabs="$("$CMUX" list-workspaces 2>/dev/null)"
  [[ -z "$tabs" ]] && { echo "heal $LOOP/$ID: cmux list-workspaces 빈 응답(플레이크?) — heal 보류(중복 spawn 방지)"; exit 0; }
  live="$(print -r -- "$tabs" | grep -iE "(🛠|↩)[[:space:]]+${LOOP}[[:space:]]+${ID}([[:space:]]|\$)" | head -1)"
  [[ -n "$live" ]] && { echo "heal $LOOP/$ID: 이미 live 탭 있음 — skip"; exit 0; }
fi

# worktree 없으면 진행분이 없으니 전체 재생성(spawn-worker)에 위임.
if [[ ! -d "$WT" ]]; then
  echo "heal $LOOP/$ID: worktree 없음 → spawn-worker 위임(전체 재생성)"
  exec "$ROOT/bin/spawn-worker.sh" "$LOOP" "$ID"
fi

# worktree 보존 재기동: 같은 cwd에서 worker-run.sh 새 탭으로. 진행분(커밋/미커밋)은 그대로 유지된다.
out="$("$CMUX" new-workspace --cwd "$WT" --command "LOOP_ID=$LOOP LOOP_ISSUE=$ID $RUNNER" 2>&1)"
ref="$(echo "$out" | grep -oE 'workspace:[0-9]+' | head -1)"
if [[ -n "$ref" ]]; then
  "$CMUX" rename-workspace --workspace "$ref" "↩ $LOOP $ID" 2>/dev/null
  cnt=$("$CMUX" list-workspaces 2>/dev/null | grep -c 'workspace:')   # 맨 밑에 추가
  "$CMUX" reorder-workspace --workspace "$ref" --index "$cnt" >/dev/null 2>&1
fi
ts=$(date '+%s')
print -r -- "{\"ts\":$ts,\"type\":\"worker\",\"event\":\"healed\",\"issue\":\"$ID\",\"attempt\":$ATTEMPT,\"workspace\":\"$ref\",\"worktree\":\"$WT\"}" >> "$STATE/runs.jsonl"
[[ -z "$ref" ]] && echo "[$(date '+%F %T')] WARN heal $ID: cmux 응답=[$out] (detach된 컨텍스트?)" >> "$STATE/dispatcher.log"
echo "healed $LOOP/$ID (attempt $ATTEMPT) → worktree=$WT tab=$ref"
