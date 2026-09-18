#!/bin/zsh
# 한 루프의 orchestrator 본체. render된 프롬프트로 OMP RPC run 실행. lock per-loop.
# usage: run-once.sh <loop-id>   (env: LOOP_MODE=full|audit_only|reconcile|retro, LOOP_MAX_WORKERS 선택)
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: run-once.sh <loop-id>}"
ROOT="$LOOPS_HOME"; LOOPDIR=$ROOT/loops/$LOOP; STATE=$LOOPDIR/state; CFG=$LOOPDIR/config.json
export LOOP_MODE="${LOOP_MODE:-full}"
[[ -n "${LOOP_MAX_WORKERS:-}" ]] && export LOOP_MAX_WORKERS
mkdir -p "$STATE"
LOCKDIR=/tmp/loop-$LOOP.lockdir
# 죽은 owner(재부팅/kill -9/OOM/OMP hang로 EXIT trap 미실행)면 stale로 보고 회수·재획득한다.
if mkdir "$LOCKDIR" 2>/dev/null; then
  echo $$ > "$LOCKDIR/owner.pid"
else
  owner="$(cat "$LOCKDIR/owner.pid" 2>/dev/null)"
  # mkdir 성공 직후 owner.pid 기록 전의 짧은 경합 창일 수 있어, 비었으면 1회만 유예 후 재확인.
  [[ -z "$owner" ]] && sleep 1 && owner="$(cat "$LOCKDIR/owner.pid" 2>/dev/null)"
  if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
    echo "⏭ SKIP $LOOP: 이전 run 진행중(lock, pid=$owner)"; exit 0
  fi
  echo "[$(date '+%F %T')] ⚠️ stale lock 회수(이전 pid=${owner:-unknown} 사망) $LOOP" >> "$STATE/run.log"
  rm -rf "$LOCKDIR" 2>/dev/null
  if mkdir "$LOCKDIR" 2>/dev/null; then
    echo $$ > "$LOCKDIR/owner.pid"
  else
    echo "⏭ SKIP $LOOP: stale lock 회수 경합 — 다음 스케줄에 재시도"; exit 0
  fi
fi
# lockdir 안에 owner.pid가 있으므로 rmdir 대신 rm -rf로 해제.
trap 'rm -rf "$LOCKDIR" 2>/dev/null' EXIT

REPO="$(cfgval "$CFG" repo)"; ORCHWT="$(cfgval "$CFG" orchestratorWorktree)"; BASEREF="$(cfgval "$CFG" baseRef)"; [[ -z "$BASEREF" ]] && BASEREF=origin/develop
# 루프/제품별 OMP 실행 커맨드. 비면 loops.env/Palace가 주입한 OMP_COMMAND, 최종 기본은 `omp`.
LOOP_OMP="$(cfgval "$CFG" ompCommand)"; [[ -n "$LOOP_OMP" ]] && export OMP_COMMAND="$LOOP_OMP"
MODEL="$(cfgval "$CFG" model)"

# hung run 상한: OMP 인증/네트워크 대기가 lock을 무한 점유하지 않게 runner에 전달한다.
RUN_TIMEOUT="${LOOP_RUN_TIMEOUT:-1800}"
export OMP_TIMEOUT_SEC="$RUN_TIMEOUT"

# 매 run 최신 기준 보장: 항상 fetch → worktree를 BASE_REF 최신으로 (LLM STEP0 fetch에 의존하지 않음).
# 유저의 로컬 working tree는 절대 쓰지 않는다 — 근거/구현은 fetch 직후의 origin 기준.
git -C "$REPO" fetch origin -q 2>/dev/null
if [[ ! -d "$ORCHWT" ]]; then
  git -C "$REPO" worktree add --detach "$ORCHWT" "$BASEREF" 2>&1 | tail -1
else
  git -C "$ORCHWT" reset --hard "$BASEREF" -q 2>/dev/null
  git -C "$ORCHWT" clean -fd -q 2>/dev/null
fi

TPL=orchestrator; [[ "$LOOP_MODE" == "retro" ]] && TPL=retro   # retro = 성과 분석→learnings.md 갱신 전용 프롬프트(발굴/fan-out 없음)
# retro는 learnings.md를 통으로 다시 쓴다 = 매 run 프롬프트에 주입되는 글을 LLM이 자유 편집한다는 뜻이다.
# 갱신 전 원본을 떠둔다 — 아래 learnings-guard가 불변식 위반을 잡으면 되돌려야 하는데, 그때는 원본이 이미 없다.
LEARN="$STATE/learnings.md"; LEARN_BAK="$STATE/.learnings.bak"
if [[ "$LOOP_MODE" == "retro" ]]; then
  if [[ -f "$LEARN" ]]; then cp "$LEARN" "$LEARN_BAK" 2>/dev/null; else rm -f "$LEARN_BAK" 2>/dev/null; fi
fi
PROMPT="$(node "$ROOT/bin/render-prompt.mjs" "$LOOP" "$TPL")"
echo "[$(date '+%F %T')] ===== $LOOP OMP orchestrator start (mode=$LOOP_MODE, timeout=${RUN_TIMEOUT}s) =====" >> "$STATE/run.log"
# OMP RPC runner의 명시적 JSON record를 사용량/사람 로그로 나눈다.
OUTJSON="$STATE/.last_run_out.json"
ROLE=orchestrator; [[ "$LOOP_MODE" == "retro" ]] && ROLE=retro
( cd "$ORCHWT" && print -rn -- "$PROMPT" | omp_run "$ROLE" "$MODEL" ) > "$OUTJSON" 2>> "$STATE/run.log"
code=$?
node "$ROOT/bin/record-cost.mjs" "$LOOP" "$OUTJSON" cycle "$LOOP_MODE" >> "$STATE/run.log" 2>&1
[[ $code -eq 124 ]] && echo "[$(date '+%F %T')] ⏱ run timeout(${RUN_TIMEOUT}s) 초과 — OMP 강제종료(exit 124)" >> "$STATE/run.log"
echo "[$(date '+%F %T')] ===== $LOOP orchestrator end (exit $code) =====" >> "$STATE/run.log"
echo "$code" > "$STATE/.last_run_exit"   # 최신 run의 exit (성공 run이 0으로 덮어 배너 자동해제)
date '+%s' > "$STATE/.last_run_done"

# retro 갱신 재검사 (결정론 게이트) — retro-base.md의 ⛔ 금지는 프롬프트라 LLM이 "근거가 충분하다"고 판단하면 뚫린다.
# 실제로 뚫렸다: no-merge 불변식을 해제하는 교훈이 기록돼 매 run 주입됐고 한 구간 머지 11건 중 8건이 그 경로였다.
# 그래서 같은 규칙을 쉘 층에 한 번 더 걸고, 위반이면 **갱신을 통째로 롤백**한다(부분 수정은 하지 않는다 —
# 어느 줄이 오염됐는지 판정하는 건 다시 LLM 일이고, 그게 뚫린 층이다). 사람에게는 반드시 알린다.
if [[ "$LOOP_MODE" == "retro" && -f "$LEARN" ]]; then
  if guard_out="$(node "$ROOT/bin/learnings-guard.mjs" "$LOOP" 2>&1)"; then
    [[ -n "$guard_out" ]] && echo "$guard_out" >> "$STATE/run.log"
  else
    if [[ -f "$LEARN_BAK" ]]; then cp "$LEARN_BAK" "$LEARN"; else rm -f "$LEARN"; fi
    {
      echo "[$(date '+%F %T')] ⛔ learnings 불변식 위반 — 갱신 롤백(이전 내용 복원)"
      echo "$guard_out"
    } >> "$STATE/run.log"
    print -r -- "{\"ts\":$(date +%s),\"type\":\"retro\",\"event\":\"rolled-back\",\"note\":\"learnings 불변식 위반\"}" >> "$STATE/runs.jsonl"
    node "$ROOT/bin/tg-notify.mjs" "⛔ $LOOP retro — learnings.md 불변식 위반으로 갱신 롤백. run.log 확인 필요." >/dev/null 2>&1
  fi
fi

# 종료 상태(Linear completed/canceled) worker worktree·탭·브랜치 자동 정리(결정론적 쉘 — LLM 안 거침).
# cleanup-terminal.sh가 실제 worktree를 열거하고 Linear(권위 ledger) 상태로 종료 판정한다(snapshot은 폴백).
"$ROOT/bin/cleanup-terminal.sh" "$LOOP" >> "$STATE/run.log" 2>&1

# 제안 검증(validator, opt-in config `"validate": true`): snapshot의 미판정 human-gate Backlog 제안마다
# fresh-context 검증자를 결정론적으로 스폰(LLM 안 거침). 멱등 — 판정 파일·사람 결정·live 탭 존재 시 spawn-validator가 skip.
if [[ "$(cfgval "$CFG" validate)" == "true" ]]; then
  for vid in $(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const i of s.issues||[])if(i.flag==="human-gate"&&i.state==="Backlog")console.log(i.id)}catch{}' "$STATE/snapshot.json"); do
    [[ -f "$STATE/validate/$vid.json" ]] && continue
    "$ROOT/bin/spawn-validator.sh" "$LOOP" "$vid" >> "$STATE/run.log" 2>&1
  done
fi
