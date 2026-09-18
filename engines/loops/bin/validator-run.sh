#!/bin/zsh
# 검증자 탭 본체: 검증 전용 worktree(cwd)에서 headless OMP로 human-gate 제안을 심문하고, 판정을 남긴 뒤 worktree를 스스로 걷는다.
# OMP validator 역할 정책이 코드 수정 도구와 Git 변경을 구조적으로 차단한다.
set -u
source "${0:A:h}/_common.sh"
LOOP="${LOOP_ID:?LOOP_ID 미설정}"
ID="${LOOP_ISSUE:?LOOP_ISSUE 미설정}"
ROOT="$LOOPS_HOME"; STATE=$ROOT/loops/$LOOP/state; CFG=$ROOT/loops/$LOOP/config.json
WTV="$PWD"
REPO="$(cfgval "$CFG" repo)"
PIDF="$STATE/validate/$ID.pid"
mkdir -p "$STATE/validate"; echo $$ > "$PIDF"   # 생존 신호(worker state/live/*.pid와 동형): cmux 재시작 등으로 트랩 없이 죽으면 cleanup-terminal의 vv-리퍼가 시체로 감지해 탭·worktree를 회수한다.
# 종료 시(성공/실패 무관) 검증 worktree 자가 정리 — 크래시로 남으면 cleanup-issue.sh가 -vd도 함께 걷는다(2중 안전망).
# 탭 타이틀도 ⏹로 — 끝난 탭이 🧪 dedup(spawn-validator 중복 방지)을 막지 않게.
cleanup(){
  rm -f "$PIDF"
  cd "$REPO" 2>/dev/null && git worktree remove --force "$WTV" 2>/dev/null
  if [[ -n "${CMUX_BIN:-}" ]]; then
    local wref="$("$CMUX_BIN" list-workspaces 2>/dev/null | grep -iE "🧪[[:space:]]+${LOOP}[[:space:]]+${ID}([[:space:]]|\$)" | grep -oE 'workspace:[0-9]+' | head -1)"
    [[ -n "$wref" ]] && "$CMUX_BIN" rename-workspace --workspace "$wref" "⏹ $LOOP $ID" 2>/dev/null
  fi
}
trap cleanup EXIT

PROMPT="$(node "$ROOT/bin/render-prompt.mjs" "$LOOP" validator)"
LOOP_OMP="$(cfgval "$CFG" ompCommand)"; [[ -n "$LOOP_OMP" ]] && export OMP_COMMAND="$LOOP_OMP"
MODEL="$(cfgval "$CFG" validator.model)"; [[ -z "$MODEL" ]] && MODEL="$(cfgval "$CFG" model)"
mkdir -p "$STATE/validate"
echo "════════ 🧪 $LOOP validator $ID 시작  $(date '+%F %T') ════════"
OUTJSON="$STATE/validate/.last_out_$ID.json"
FINAL_PROMPT="$PROMPT

═══ 배정 이슈 ID: $ID ═══"
export OMP_TIMEOUT_SEC="${LOOP_VALIDATE_TIMEOUT:-1800}"
print -rn -- "$FINAL_PROMPT" | omp_run validator "$MODEL" > "$OUTJSON"
code=$?
node "$ROOT/bin/record-cost.mjs" "$LOOP" "$OUTJSON" validate
echo
# verdict 파일에서 판정을 읽어 피드에 남긴다(검증자 LLM이 기록; 없으면 실패로 크게 표시 — 조용히 넘어가지 않음).
VF="$STATE/validate/$ID.json"
verdict="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1])).verdict||""))}catch{}' "$VF" 2>/dev/null)"
ts=$(date '+%s')
if [[ -n "$verdict" ]]; then
  print -r -- "{\"ts\":$ts,\"type\":\"validate\",\"event\":\"verdict\",\"issue\":\"$ID\",\"verdict\":\"$verdict\"}" >> "$STATE/runs.jsonl"
  echo "════════ 🧪 verdict: $verdict  (exit $code) ════════"
else
  print -r -- "{\"ts\":$ts,\"type\":\"validate\",\"event\":\"error\",\"issue\":\"$ID\",\"note\":\"verdict 파일 없음 (exit $code)\"}" >> "$STATE/runs.jsonl"
  echo "⚠️ validator가 verdict 파일($VF)을 남기지 않음 (exit $code) — $OUTJSON 확인"
fi
