#!/bin/zsh
# worker 탭 본체 (라이브 TUI). 배정 이슈 1건을 이 worktree(=cwd)에서 구현→PR.
set -u
source "${0:A:h}/_common.sh"
LOOP="${LOOP_ID:?LOOP_ID 미설정}"
ID="${LOOP_ISSUE:?LOOP_ISSUE 미설정}"
ROOT="$LOOPS_HOME"
STATE="$ROOT/loops/$LOOP/state"
# 생존 pidfile + 종료 훅. cmux가 재시작되면 탭이 "타이틀만 남은 빈 쉘"로 세션 복원되는데, 엔진의 생존 판정이 탭 타이틀
# 기반이라 죽은 워커가 산 것으로 오인된다(wedged 오탐 + heal 차단 — GOD-28 사고). 그래서:
#   · pidfile: 워치독이 "탭은 있는데 프로세스는 죽음"을 판별하는 결정론적 근거 (kill -0).
#   · 종료 시(정상/크래시 무관): pidfile 제거 + 탭 타이틀 ⏹로 변경 → 생존 신호(🛠|↩ 매칭)에서 즉시 제거 + exit 이벤트 기록.
#     (OMP TUI가 turn을 멈추고 대기하는 동안은 프로세스가 살아있으므로 이 훅이 안 탄다 — 검토용 탭 유지 설계 그대로.)
mkdir -p "$STATE/live"
PIDFILE="$STATE/live/$ID.pid"; echo $$ > "$PIDFILE"
OMP_EXIT=""
on_exit(){
  rm -f "$PIDFILE" 2>/dev/null
  print -r -- "{\"ts\":$(date '+%s'),\"type\":\"worker\",\"event\":\"exit\",\"issue\":\"$ID\",\"code\":${OMP_EXIT:-null}}" >> "$STATE/runs.jsonl" 2>/dev/null
  if [[ -n "${CMUX_BIN:-}" ]]; then
    local wref="$("$CMUX_BIN" list-workspaces 2>/dev/null | grep -iE "(🛠|↩)[[:space:]]+${LOOP}[[:space:]]+${ID}([[:space:]]|\$)" | grep -oE 'workspace:[0-9]+' | head -1)"
    [[ -n "$wref" ]] && "$CMUX_BIN" rename-workspace --workspace "$wref" "⏹ $LOOP $ID" 2>/dev/null
  fi
}
trap on_exit EXIT
PROMPT="$(node "$ROOT/bin/render-prompt.mjs" "$LOOP" worker)"
# 루프/제품별 OMP 명령과 선택 모델. auto/빈 모델은 runner가 --model을 생략한다.
LOOP_OMP="$(cfgval "$ROOT/loops/$LOOP/config.json" ompCommand)"; [[ -n "$LOOP_OMP" ]] && export OMP_COMMAND="$LOOP_OMP"
MODEL="$(cfgval "$ROOT/loops/$LOOP/config.json" model)"
# human-gate 해제: 사용자가 대시보드에서 결정을 내리면 decisions/<ISSUE>.md 에 저장된다 → 워커에 주입.
DECISION_FILE="$ROOT/loops/$LOOP/state/decisions/$ID.md"
DECISION=""
[[ -f "$DECISION_FILE" ]] && DECISION="$(cat "$DECISION_FILE")"
# 리뷰 재작업 모드 (rework-worker.sh가 LOOP_REWORK=1로 스폰): 신규 구현 절차를 덮어쓰는 재작업 지침 블록을 주입.
REWORK_BLOCK=""
if [[ -n "${LOOP_REWORK:-}" ]]; then
  REWORK_BLOCK="═══ 🔁 리뷰 재작업 모드 (피드백 반영) ═══
이 worktree의 브랜치에는 이미 열린 PR이 있고, 사람 리뷰어가 변경을 요청했거나(CHANGES_REQUESTED) 검증자(verifier)가 ❌ fail verdict를 PR 코멘트로 남겼다. **위 절차의 신규 구현·PR 생성(절차 2~6.5)을 다시 하지 말고**, 아래만 수행한다:
1. \`gh pr view --json url,reviews,comments,statusCheckRollup\` 으로 이 브랜치 PR의 리뷰·코멘트·CI 상태를 읽는다.
2. **명시적 변경 요청만** 최소 diff로 반영한다. 질문·모호한 코멘트는 코드 수정 없이 PR 답글로만 응답한다(추측 구현 금지 — 뭘 원하는지 불분명하면 답글로 되묻고 그 항목은 건드리지 않는다).
3. CI 실패가 기계적으로 명백하면 함께 고친다.
4. 커밋 → \`git push\` (**non-force — force-push 절대 금지**). 반영한 각 리뷰 코멘트에 무엇을 어떻게 바꿨는지 답글을 남긴다.
5. Linear 이슈에 \"🔁 리뷰 반영 push: <요약>\" 코멘트. 상태는 In Review 유지.
6. **머지 금지.** push와 답글까지 끝나면 **위 절차 7의 무인 규칙 그대로 OMP 상주 감시로 복귀**한다 — 이 재작업 스폰은 죽어 있던 감시자를 재수립하는 경로이기도 하다. PR이 MERGED/CLOSED 되면 1줄 요약 후 정지."
fi
echo "════════ 🛠 $LOOP worker $ID 시작  $(date '+%F %T')  — 실시간 진행이 이 탭에 보입니다 ════════"
[[ -n "$DECISION" ]] && echo "⚖️  사람이 내린 결정 주입됨 (human-gate 해제)"
[[ -n "$REWORK_BLOCK" ]] && echo "🔁 리뷰 재작업 모드 (리뷰 피드백 반영만 수행)"
FINAL_PROMPT="$PROMPT

═══ 배정 이슈 ID: $ID ═══${REWORK_BLOCK:+

$REWORK_BLOCK}${DECISION:+

═══ ⚖️ 사람이 대시보드에서 내린 결정 (human-gate 해제됨) ═══
사용자가 이 이슈의 human-gate를 직접 해제하고 아래 결정을 내렸다. 이 결정을 **최우선 지침**으로 따르라 — 이슈 본문의 \"human-gate/사람 판단 필요\" 표시는 이 결정으로 해소된 것으로 간주하고, 절차 2의 human-gate 중단을 하지 말고 구현을 진행하라. 시작 시 이 이슈를 Linear에서 In Progress로 옮기고, 이 결정 내용을 이슈에 코멘트로 남겨 기록하라.

$DECISION}"
print -rn -- "$FINAL_PROMPT" | omp_live worker "$MODEL"
OMP_EXIT=$?
echo "════════ 🛠 $LOOP worker $ID 종료 (exit $OMP_EXIT)  $(date '+%F %T') ════════"
