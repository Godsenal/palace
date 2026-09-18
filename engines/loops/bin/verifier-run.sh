#!/bin/zsh
# 검증자 탭 본체: 검증 전용 worktree(cwd)에서 headless OMP로 PR을 채점하고, 판정을 남긴 뒤 worktree를 스스로 걷는다.
# maker/checker 분리의 checker 쪽 — OMP 역할 정책이 코드 수정 도구와 Git 변경을 구조적으로 차단한다.
set -u
source "${0:A:h}/_common.sh"
LOOP="${LOOP_ID:?LOOP_ID 미설정}"
ID="${LOOP_ISSUE:?LOOP_ISSUE 미설정}"
ROOT="$LOOPS_HOME"; STATE=$ROOT/loops/$LOOP/state; CFG=$ROOT/loops/$LOOP/config.json
WTV="$PWD"
REPO="$(cfgval "$CFG" repo)"
PIDF="$STATE/verify/$ID.pid"
mkdir -p "$STATE/verify"; echo $$ > "$PIDF"   # 생존 신호(worker state/live/*.pid와 동형): cmux 재시작 등으로 트랩 없이 죽으면 cleanup-terminal의 vv-리퍼가 시체로 감지해 탭·worktree를 회수한다.
# 종료 시(성공/실패 무관) 검증 worktree 자가 정리 — 크래시로 남으면 cleanup-issue.sh가 -vf도 함께 걷는다(2중 안전망).
# 탭 타이틀도 ⏹로 — 끝난 탭이 🔎 dedup(spawn-verifier 중복 방지)을 막지 않게.
cleanup(){
  rm -f "$PIDF"
  cd "$REPO" 2>/dev/null && git worktree remove --force "$WTV" 2>/dev/null
  if [[ -n "${CMUX_BIN:-}" ]]; then
    local wref="$("$CMUX_BIN" list-workspaces 2>/dev/null | grep -iE "🔎[[:space:]]+${LOOP}[[:space:]]+${ID}([[:space:]]|\$)" | grep -oE 'workspace:[0-9]+' | head -1)"
    [[ -n "$wref" ]] && "$CMUX_BIN" rename-workspace --workspace "$wref" "⏹ $LOOP $ID" 2>/dev/null
  fi
}
trap cleanup EXIT

LOOP_OMP="$(cfgval "$CFG" ompCommand)"; [[ -n "$LOOP_OMP" ]] && export OMP_COMMAND="$LOOP_OMP"
MODEL="$(cfgval "$CFG" verifier.model)"; [[ -z "$MODEL" ]] && MODEL="$(cfgval "$CFG" model)"
mkdir -p "$STATE/verify"
echo "════════ 🔎 $LOOP verifier $ID 시작  $(date '+%F %T') ════════"

# ═══ Tier 2 — 결정론 체크 (config `checks`; 없으면 이 블록 통째 skip = 기존 동작 그대로) ═══
# 왜 쉘이 돌리나: 검증자 LLM은 "돌렸다"고 주장할 수 있고 실제로 그랬다 — 실측 pass 299건 중 25건이 본문에
# "실행 불가"를 달고 통과했다(프롬프트의 '안 돌리고 통과 금지' 규칙 위반). 프롬프트로 못 막으니 쉘이 돌린다.
# 결과는 verdict의 **하한**이다: LLM은 더 나쁘게만 바꿀 수 있고 더 좋게는 못 바꾼다(아래 하한 강제 참조).
# ⚠️ "못 돌림"과 "실패"를 반드시 구분한다 — 검증 worktree는 새 체크아웃이라 node_modules가 없어 setup이 없으면
#    tsc가 "실패"가 아니라 "실행 불가"로 죽는다. 이걸 fail로 접으면 전 PR이 fail이 되어 rework 폭풍이 난다
#    (지금의 '항상 pass'와 정확히 대칭인 반대편 사고).
CHK_WORST=none          # none(체크 없음) | ok | unrunnable | fail
CHK_REPORT=""
CHK_SETUP="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).checks;if(c&&!Array.isArray(c)&&c.setup)process.stdout.write(String(c.setup))}catch{}' "$CFG" 2>/dev/null)"
CHK_TMO="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).checks;process.stdout.write(String((c&&!Array.isArray(c)&&c.timeoutSec)||900))}catch{process.stdout.write("900")}' "$CFG" 2>/dev/null)"
typeset -a CHK_CMDS; CHK_CMDS=()
while IFS= read -r c; do [[ -n "$c" ]] && CHK_CMDS+=("$c"); done < <(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).checks;const r=Array.isArray(c)?c:((c&&c.run)||[]);for(const x of r)console.log(String(x))}catch{}' "$CFG" 2>/dev/null)

if (( ${#CHK_CMDS} > 0 )); then
  TMO_BIN=""
  if command -v timeout >/dev/null 2>&1; then TMO_BIN="timeout $CHK_TMO"
  elif command -v gtimeout >/dev/null 2>&1; then TMO_BIN="gtimeout $CHK_TMO"; fi
  CHK_WORST=ok
  setup_ok=1
  if [[ -n "$CHK_SETUP" ]]; then
    echo "──── ⚙️ setup: $CHK_SETUP"
    sout="$( ( cd "$WTV" && ${=TMO_BIN} zsh -c "$CHK_SETUP" ) 2>&1 )"; src=$?
    print -r -- "$sout" | tail -15
    if (( src != 0 )); then
      setup_ok=0; CHK_WORST=unrunnable
      CHK_REPORT+="- setup 실패(\`$CHK_SETUP\`, exit $src) → 이하 체크 전부 **실행 불가**"$'\n'
    fi
  fi
  for c in "${CHK_CMDS[@]}"; do
    if (( ! setup_ok )); then CHK_REPORT+="- \`$c\` → 실행 불가(setup 실패)"$'\n'; continue; fi
    echo "──── ▶ check: $c"
    out="$( ( cd "$WTV" && ${=TMO_BIN} zsh -c "$c" ) 2>&1 )"; rc=$?
    print -r -- "$out" | tail -20
    if (( rc == 0 )); then
      CHK_REPORT+="- \`$c\` → ✅ 통과(exit 0)"$'\n'
    elif (( rc == 127 )); then
      CHK_REPORT+="- \`$c\` → ⚠️ **실행 불가**(exit 127 command not found)"$'\n'
      [[ "$CHK_WORST" == "fail" ]] || CHK_WORST=unrunnable
    elif (( rc == 124 )); then
      CHK_REPORT+="- \`$c\` → ⚠️ **실행 불가**(${CHK_TMO}s 타임아웃)"$'\n'
      [[ "$CHK_WORST" == "fail" ]] || CHK_WORST=unrunnable
    else
      CHK_REPORT+="- \`$c\` → ❌ **실패**(exit $rc)"$'\n'"  \`\`\`"$'\n'"$(print -r -- "$out" | tail -12)"$'\n'"  \`\`\`"$'\n'
      CHK_WORST=fail
    fi
  done
  echo "──── Tier2 결과: $CHK_WORST"
fi

PROMPT="$(node "$ROOT/bin/render-prompt.mjs" "$LOOP" verifier)"
# 체크 결과는 렌더 이후에 붙인다(render-prompt는 실행 전에 호출되므로 결과를 모른다).
if [[ "$CHK_WORST" != "none" ]]; then
  PROMPT="$PROMPT

═══ 결정론 체크 결과 (엔진이 이미 실행함 — 네가 다시 돌릴 필요 없다) ═══
종합: **$CHK_WORST** (ok=전부통과 · unrunnable=일부 실행불가 · fail=하나 이상 실패)
$(print -r -- "$CHK_REPORT")
이 결과는 **verdict의 하한**이다. 엔진이 판정 후 강제 적용하므로 네가 뒤집을 수 없다:
- fail → 최종 verdict는 무조건 ❌ fail. 너는 **무엇이 왜 깨졌는지**를 근거로 적어라.
- unrunnable → pass 금지(최소 ⚠️ concerns). 무엇을 못 돌렸는지 명시하라.
- ok → 하한 없음. 이건 \"기계 체크가 통과했다\"는 뜻일 뿐 **수용 기준 충족이 아니다** — 의미 판정은 네 몫이다."
fi
OUTJSON="$STATE/verify/.last_out_$ID.json"
FINAL_PROMPT="$PROMPT

═══ 배정 이슈 ID: $ID ═══"
export OMP_TIMEOUT_SEC="${LOOP_VERIFY_TIMEOUT:-1800}"
print -rn -- "$FINAL_PROMPT" | omp_run verifier "$MODEL" > "$OUTJSON"
code=$?
node "$ROOT/bin/record-cost.mjs" "$LOOP" "$OUTJSON" verify
echo
# verdict 파일에서 판정을 읽어 피드에 남긴다(검증자 LLM이 기록; 없으면 실패로 크게 표시 — 조용히 넘어가지 않음).
VF="$STATE/verify/$ID.json"

# ── Tier 2 하한 강제 ──
# LLM 판정 위에 결정론 결과를 덮어쓴다. 방향은 **한쪽뿐** — 나쁘게만 바꾼다.
# fail 체크를 LLM이 pass로 덮을 수 있으면 Tier 2는 자문이 되고, 자문 검증이 어떻게 saturate되는지는 이미 실측됐다
# (329건 중 fail 1건). 반대로 ok를 pass로 승격하지도 않는다 — 기계 통과는 수용 기준 충족이 아니다.
# LLM이 verdict 파일을 아예 안 남긴 경우(실측 spawn 602 → verdict 302, 절반이 무음 증발)에도
# 체크가 fail이면 엔진이 직접 verdict를 쓴다 — 근거가 결정론이라 LLM 없이도 판정이 성립한다.
if [[ "$CHK_WORST" != "none" ]]; then
  node -e '
const fs=require("fs"),[f,worst,rep]=process.argv.slice(1);
let v=null; try{v=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
const had=!!(v&&v.verdict);
if(!v||typeof v!=="object")v={};
if(worst==="fail"){
  if(v.verdict!=="fail")v.forcedFrom=v.verdict||null;
  v.verdict="fail";
}else if(worst==="unrunnable"&&v.verdict==="pass"){
  v.forcedFrom="pass"; v.verdict="concerns";
}
if(!v.verdict&&worst==="fail")v.verdict="fail";
if(!v.ts)v.ts=Math.floor(Date.now()/1000);
v.checks={worst,report:rep};
if(!had&&v.verdict)v.summary=(v.summary||"")+"[엔진] LLM verdict 없음 — 결정론 체크 결과로 판정.";
if(v.verdict)fs.writeFileSync(f,JSON.stringify(v));
' "$VF" "$CHK_WORST" "$CHK_REPORT" 2>/dev/null
fi

verdict="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1])).verdict||""))}catch{}' "$VF" 2>/dev/null)"
forced="$(node -e 'try{const v=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(v.forcedFrom?String(v.forcedFrom):"")}catch{}' "$VF" 2>/dev/null)"
ts=$(date '+%s')
if [[ -n "$verdict" ]]; then
  print -r -- "{\"ts\":$ts,\"type\":\"verify\",\"event\":\"verdict\",\"issue\":\"$ID\",\"verdict\":\"$verdict\",\"checks\":\"$CHK_WORST\"}" >> "$STATE/runs.jsonl"
  if [[ -n "$forced" ]]; then
    echo "════════ 🔎 verdict: $verdict  ⚙️ Tier2가 '$forced'에서 강등 (checks=$CHK_WORST, exit $code) ════════"
  else
    echo "════════ 🔎 verdict: $verdict  (checks=$CHK_WORST, exit $code) ════════"
  fi
else
  # verdict 없음 = 게이트가 통째로 빈 채 PR이 사람 앞에 놓인다. 조용히 넘기면 '검증했다'로 오인되므로 알린다.
  print -r -- "{\"ts\":$ts,\"type\":\"verify\",\"event\":\"error\",\"issue\":\"$ID\",\"note\":\"verdict 파일 없음 (exit $code)\"}" >> "$STATE/runs.jsonl"
  echo "⚠️ verifier가 verdict 파일($VF)을 남기지 않음 (exit $code) — $OUTJSON 확인"
  node "$ROOT/bin/tg-notify.mjs" "⚠️ $LOOP $ID — verifier가 verdict 없이 종료(exit $code). 이 PR은 검증 게이트가 비어 있다." >/dev/null 2>&1
fi
