#!/bin/zsh
# 한 human-gate 제안 이슈를 심문할 검증자(validator) 스폰: BASE_REF의 **검증 전용 detached worktree**(${PREFIX}-<slug>-vd) +
# cmux 탭(🧪)에서 validator-run.sh 실행. 발굴자/검증자 분리 — 발굴 오케스트레이터와 다른 fresh-context 회의론자가
# 제안 근거를 재현·심문해 판정(strengthen/narrow/reject)을 게이트에 병기한다. 사람 결정 전 선별 보조 — 승인/기각은 여전히 사람.
# opt-in: config `"validate": true` 일 때만 동작(아니면 no-op). run-once.sh가 orchestrator run 후 결정론적으로 호출.
# 검증자는 코드를 못 고친다(validator-run이 Edit/Write를 구조적으로 차단) — 머지/배포/force-push/Linear 상태 이동 없음.
# usage: spawn-validator.sh <loop-id> <issue-id>
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: spawn-validator.sh <loop-id> <issue-id>}"
ID="${2:?usage: spawn-validator.sh <loop-id> <issue-id>}"
ROOT="$LOOPS_HOME"; LOOPDIR=$ROOT/loops/$LOOP; STATE=$LOOPDIR/state; CFG=$LOOPDIR/config.json
CMUX="$CMUX_BIN"
RUNNER=$ROOT/bin/validator-run.sh
[[ -f "$CFG" ]] || { echo "loop '$LOOP' config 없음 — skip"; exit 0; }
[[ "$(cfgval "$CFG" validate)" == "true" ]] || { echo "validate $LOOP/$ID: config validate=true 아님 — skip"; exit 0; }
[[ -f "$STATE/validate/$ID.json" ]] && { echo "validate $LOOP/$ID: 이미 판정 있음 — skip"; exit 0; }
[[ -f "$STATE/decisions/$ID.md" ]] && { echo "validate $LOOP/$ID: 사람이 이미 게이트 결정함 — skip"; exit 0; }
REPO="$(cfgval "$CFG" repo)"; PREFIX="$(cfgval "$CFG" worktreePrefix)"
BASEREF="$(cfgval "$CFG" baseRef)"; [[ -z "$BASEREF" ]] && BASEREF=origin/develop

slug="$(slugof "$ID")"
WTV="${PREFIX}-${slug}-vd"   # -vd 접미사 → 워커 worktree(${PREFIX}-<slug>)·verifier(-vf)와 슬러그가 달라 워치독/리퍼 매칭에 안 걸림

# 이미 검증자 탭이 있으면 중복 방지.
if [[ -n "$CMUX" ]]; then
  live="$("$CMUX" list-workspaces 2>/dev/null | grep -iE "🧪[[:space:]]+${LOOP}[[:space:]]+${ID}([[:space:]]|\$)" | head -1)"
  [[ -n "$live" ]] && { echo "validate $LOOP/$ID: 이미 검증자 탭 있음 — skip"; exit 0; }
fi

# 검증 worktree: 제안의 "기존 코드가 이미 해결하나" 심문은 BASE_REF 최신이 기준 — detached라 커밋/브랜치 이동이 원천 불가.
git -C "$REPO" fetch origin -q
git -C "$REPO" worktree remove --force "$WTV" 2>/dev/null
if ! git -C "$REPO" worktree add --detach "$WTV" "$BASEREF" 2>&1; then echo "ERROR: validate worktree 생성 실패 $WTV ($BASEREF 없음?)"; exit 1; fi

out="$("$CMUX" new-workspace --cwd "$WTV" --command "LOOP_ID=$LOOP LOOP_ISSUE=$ID $RUNNER" 2>&1)"
ref="$(echo "$out" | grep -oE 'workspace:[0-9]+' | head -1)"
if [[ -n "$ref" ]]; then
  "$CMUX" rename-workspace --workspace "$ref" "🧪 $LOOP $ID" 2>/dev/null
  cnt=$("$CMUX" list-workspaces 2>/dev/null | grep -c 'workspace:')   # 맨 밑에 추가
  "$CMUX" reorder-workspace --workspace "$ref" --index "$cnt" >/dev/null 2>&1
else
  # cmux 밖에서 호출됨(터미널에서 run-once 직접 실행 등 — cmux 소켓은 cmux 안 프로세스만 연결 가능).
  # validator는 headless라 탭 없이도 완주 가능 → 명시적 폴백으로 직접 실행한다(탭은 관측용일 뿐, 기능 손실 없음).
  echo "[$(date '+%F %T')] WARN validate $ID: cmux 탭 스폰 실패(응답=[$out]) → 탭 없이 headless 직접 실행" >> "$STATE/dispatcher.log"
  ( cd "$WTV" && LOOP_ID="$LOOP" LOOP_ISSUE="$ID" nohup "$RUNNER" >> "$STATE/run.log" 2>&1 & )
  ref="(headless)"
fi
ts=$(date '+%s')
print -r -- "{\"ts\":$ts,\"type\":\"validate\",\"event\":\"spawned\",\"issue\":\"$ID\",\"workspace\":\"$ref\"}" >> "$STATE/runs.jsonl"
echo "validator spawned $LOOP/$ID → worktree=$WTV tab=$ref"
