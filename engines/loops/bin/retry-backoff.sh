#!/bin/zsh
# 오케스트레이터 사이클의 일시적 실패를 백오프로 재발사한다 — 체인에서 유일하게 재시도가 없던 링크.
# dispatch.sh가 ≤60s 케이던스로 호출. event-poll.sh와 **같은 메커니즘**(next_fire를 당긴다)이라 새 실행 경로가
# 없다: 발사는 여전히 dispatcher 본 루프가 하고 cap·예산·drain·PAUSED/enabled 가드를 전부 그대로 통과한다.
#
# run-once.sh의 OMP runner가 실패를 transient|account|fatal로 정규화한다.
# transient만 백오프 재시도한다. account는 사람이 인증/한도를 해소해야 하고,
# fatal은 엔진 결함일 수 있어 incident-bridge로 넘긴다.
#
# 백오프 LOOPS_RETRY_BACKOFF("60 300 900") · 상한 LOOPS_RETRY_MAX(3). 성공(exit 0) 사이클이 카운터를 리셋한다.
# 커서는 state/retry.json의 lastRunDone — **끝난 run 하나를 한 번만** 판정한다(60s 폴링 중복 방지).
# 안전: next_fire 쓰기 + runs.jsonl append 뿐 — 머지/배포/force-push/Linear 상태 변경 없음.
# usage: retry-backoff.sh <loop-id>
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: retry-backoff.sh <loop-id>}"
ROOT="$LOOPS_HOME"; LOOPDIR=$ROOT/loops/$LOOP; STATE=$LOOPDIR/state; CFG=$LOOPDIR/config.json
[[ -f "$CFG" ]] || exit 0
[[ "$(cfgval "$CFG" enabled 2>/dev/null)" == "false" ]] && exit 0
[[ -f "$STATE/PAUSED" ]] && exit 0
[[ -d /tmp/loop-$LOOP.lockdir ]] && exit 0   # run 진행 중 — 판정은 그 run이 끝난 뒤에

RETRY_MAX=${LOOPS_RETRY_MAX:-3}
typeset -a BACKOFF; BACKOFF=(${=LOOPS_RETRY_BACKOFF:-60 300 900})

# run.log의 OMP_ERROR_CLASS marker가 runner와 유일한 분류 계약이다.

now=$(date +%s)
ec="$(cat "$STATE/.last_run_exit" 2>/dev/null)"; dt="$(cat "$STATE/.last_run_done" 2>/dev/null)"
[[ "$ec" == <-> && "$dt" == <-> ]] || exit 0

RJ="$STATE/retry.json"
rj_get(){ node -e 'const fs=require("fs"),[f,k]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}process.stdout.write(o[k]==null?"":String(o[k]))' "$RJ" "$1"; }
rj_set(){ node -e 'const fs=require("fs"),[f,p]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}Object.assign(o,JSON.parse(p));fs.writeFileSync(f,JSON.stringify(o))' "$RJ" "$1"; }

seen="$(rj_get lastRunDone)"; [[ "$seen" == <-> ]] || seen=0
(( dt > seen )) || exit 0            # 이미 판정한 run — 폴링 중복 없음
rj_set "{\"lastRunDone\":$dt}"

if (( ec == 0 )); then               # 성공 사이클이 재시도 예산을 되돌린다
  [[ "$(rj_get attempts)" == 0 ]] || rj_set '{"attempts":0}'
  exit 0
fi

# signal/timeout은 runner marker를 못 남길 수 있어 exit 코드로 transient 판정한다.
if (( ec == 137 || ec == 143 || ec == 124 )); then
  kind=transient; why="타임아웃/강제종료(exit $ec)"
else
  tail60="$(tail -60 "$STATE/run.log" 2>/dev/null)"
  marker="$(print -r -- "$tail60" | grep -aoE 'OMP_ERROR_CLASS:(transient|account|fatal)' | tail -1)"
  case "${marker#OMP_ERROR_CLASS:}" in
    transient) kind=transient; why="일시적 OMP/provider 오류" ;;
    account) kind=account; why="OMP/provider 인증·한도 문제" ;;
    *) kind=fatal; why="OMP fatal 또는 분류 불가(exit $ec)" ;;
  esac
fi

if [[ "$kind" != transient ]]; then
  # account/fatal은 자동 반복하지 않는다. incident bridge와 Telegram이 사람에게 표면화한다.
  [[ "$(rj_get attempts)" == 0 ]] || rj_set '{"attempts":0}'
  exit 0
fi

att="$(rj_get attempts)"; [[ "$att" == <-> ]] || att=0
if (( att >= RETRY_MAX )); then
  echo "⏸ retry $LOOP: ${RETRY_MAX}회 재시도 소진 — 정규 스케줄로 복귀 ($why)"
  rj_set '{"attempts":0}'
  exit 0
fi

delay=${BACKOFF[$((att+1))]:-${BACKOFF[-1]}}
target=$(( now + delay ))
nf="$(cat "$STATE/next_fire" 2>/dev/null || echo 0)"
if (( nf <= target )); then
  # 정규 스케줄이 이미 더 이르다 — 당길 게 없다. 시도 횟수도 안 쓴다(재시도가 일어나지 않았으므로).
  exit 0
fi
att=$((att+1)); rj_set "{\"attempts\":$att}"
echo "$target" > "$STATE/next_fire"
print -r -- "{\"ts\":$now,\"type\":\"cycle\",\"event\":\"trigger\",\"trigger\":\"retry\",\"note\":\"$kind ${att}/${RETRY_MAX} +${delay}s — $why\"}" >> "$STATE/runs.jsonl"
echo "🔁 retry $LOOP: $kind ${att}/${RETRY_MAX} → ${delay}s 뒤 재발사 ($why)"
