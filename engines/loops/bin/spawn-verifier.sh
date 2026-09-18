#!/bin/zsh
# 한 이슈의 PR을 채점할 검증자(verifier) 스폰: PR 브랜치의 **검증 전용 detached worktree**(${PREFIX}-<slug>-vf) +
# cmux 탭(🔎)에서 verifier-run.sh 실행. maker/checker 분리 — 워커(작성자)와 다른 fresh-context가 증거 기반 verdict를 남긴다.
# opt-in: config `"verify": true` + delivery=pr 일 때만 동작(아니면 no-op). 워커의 delivery 마지막 단계가 호출.
# 검증자는 코드를 못 고친다(verifier-run이 Edit/Write를 구조적으로 차단) — 머지/배포/force-push 없음.
# usage: spawn-verifier.sh <loop-id> <issue-id>
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: spawn-verifier.sh <loop-id> <issue-id>}"
ID="${2:?usage: spawn-verifier.sh <loop-id> <issue-id>}"
ROOT="$LOOPS_HOME"; LOOPDIR=$ROOT/loops/$LOOP; STATE=$LOOPDIR/state; CFG=$LOOPDIR/config.json
CMUX="$CMUX_BIN"
RUNNER=$ROOT/bin/verifier-run.sh
[[ -f "$CFG" ]] || { echo "loop '$LOOP' config 없음 — skip"; exit 0; }
[[ "$(cfgval "$CFG" verify)" == "true" ]] || { echo "verify $LOOP/$ID: config verify=true 아님 — skip"; exit 0; }
DELIVERY="$(cfgval "$CFG" delivery)"; [[ -z "$DELIVERY" ]] && DELIVERY=pr
[[ "$DELIVERY" == "direct" ]] && { echo "verify $LOOP/$ID: delivery=direct(PR 없음) — skip"; exit 0; }
REPO="$(cfgval "$CFG" repo)"; PREFIX="$(cfgval "$CFG" worktreePrefix)"
BRPFX="$(cfgval "$CFG" branchPrefix)"; [[ -z "$BRPFX" ]] && BRPFX="loop-$LOOP"

slug="$(slugof "$ID")"
BR="${BRPFX}/${slug}"
WTV="${PREFIX}-${slug}-vf"   # -vf 접미사 → 워커 worktree(${PREFIX}-<slug>)와 슬러그가 달라 워치독/리퍼 매칭에 안 걸림

# 이미 검증자 탭이 있으면 중복 방지.
if [[ -n "$CMUX" ]]; then
  live="$("$CMUX" list-workspaces 2>/dev/null | grep -iE "🔎[[:space:]]+${LOOP}[[:space:]]+${ID}([[:space:]]|\$)" | head -1)"
  [[ -n "$live" ]] && { echo "verify $LOOP/$ID: 이미 검증자 탭 있음 — skip"; exit 0; }
fi

# 검증 worktree: PR 브랜치의 push된 커밋(origin)이 채점 대상 — detached라 커밋/브랜치 이동이 원천 불가.
git -C "$REPO" fetch origin -q
git -C "$REPO" worktree remove --force "$WTV" 2>/dev/null
if ! git -C "$REPO" worktree add --detach "$WTV" "origin/$BR" 2>&1; then echo "ERROR: verify worktree 생성 실패 $WTV (origin/$BR 없음?)"; exit 1; fi

out="$("$CMUX" new-workspace --cwd "$WTV" --command "LOOP_ID=$LOOP LOOP_ISSUE=$ID $RUNNER" 2>&1)"
ref="$(echo "$out" | grep -oE 'workspace:[0-9]+' | head -1)"
if [[ -n "$ref" ]]; then
  "$CMUX" rename-workspace --workspace "$ref" "🔎 $LOOP $ID" 2>/dev/null
  cnt=$("$CMUX" list-workspaces 2>/dev/null | grep -c 'workspace:')   # 맨 밑에 추가
  "$CMUX" reorder-workspace --workspace "$ref" --index "$cnt" >/dev/null 2>&1
fi
ts=$(date '+%s')
print -r -- "{\"ts\":$ts,\"type\":\"verify\",\"event\":\"spawned\",\"issue\":\"$ID\",\"workspace\":\"$ref\"}" >> "$STATE/runs.jsonl"
[[ -z "$ref" ]] && echo "[$(date '+%F %T')] WARN verify $ID: cmux 응답=[$out] (detach된 컨텍스트?)" >> "$STATE/dispatcher.log"
echo "verifier spawned $LOOP/$ID → worktree=$WTV tab=$ref"
