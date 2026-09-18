#!/bin/zsh
# 리뷰 재작업 워커: 열린 PR에 사람 리뷰어가 CHANGES_REQUESTED를 남기거나 검증자(verifier)가 ❌ fail verdict를
# 남기면, 그 이슈의 보존된 worktree에서 워커를 재스폰해 피드백만 반영(push)하게 한다.
# orchestrator STEP 1이 OPEN PR마다 무조건 호출해도 안전 — 실제 트리거 판정은 여기의 결정론적 가드 3중이 담당:
#   ① 새 피드백 게이트 — 마지막 재작업 spawn 이후의 CHANGES_REQUESTED 리뷰 또는 fail verdict가 없으면 no-op.
#      (reviewDecision은 리뷰어가 재리뷰할 때까지 CHANGES_REQUESTED로 남으므로, 이 게이트 없이는 사이클마다 재스폰된다.)
#   ② 상한 — 이슈당 LOOP_REWORK_MAX(기본 2)회. 초과 시 rework.json에 exhausted 기록 → 대시보드/봇 표면화, 이후는 사람 몫.
#   ③ live 탭 dedup — 이미 워커/재작업 탭이 살아있으면 skip (heal-worker.sh와 동일 패턴).
# worktree가 정리됐으면 PR 브랜치(origin) 기준으로 재생성한다 — BASE_REF가 아니라 브랜치가 진실(진행분=push된 커밋).
# 머지/배포/force-push 없음 — 재작업 워커도 non-force push만.
# usage: rework-worker.sh <loop-id> <issue-id>
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: rework-worker.sh <loop-id> <issue-id>}"
ID="${2:?usage: rework-worker.sh <loop-id> <issue-id>}"
ROOT="$LOOPS_HOME"; LOOPDIR=$ROOT/loops/$LOOP; STATE=$LOOPDIR/state; CFG=$LOOPDIR/config.json
CMUX="$CMUX_BIN"; GH="$GH_BIN"
RUNNER=$ROOT/bin/worker-run.sh
[[ -f "$CFG" ]] || { echo "loop '$LOOP' config 없음 — skip"; exit 0; }
REPO="$(cfgval "$CFG" repo)"; PREFIX="$(cfgval "$CFG" worktreePrefix)"
BRPFX="$(cfgval "$CFG" branchPrefix)"; [[ -z "$BRPFX" ]] && BRPFX="loop-$LOOP"
DELIVERY="$(cfgval "$CFG" delivery)"; [[ -z "$DELIVERY" ]] && DELIVERY=pr
[[ "$DELIVERY" == "direct" ]] && { echo "rework $LOOP/$ID: delivery=direct(PR 없음) — 해당 없음"; exit 0; }
REWORK_MAX=${LOOP_REWORK_MAX:-2}
RW="$STATE/rework.json"

slug="$(slugof "$ID")"
WT="${PREFIX}-${slug}"; BR="${BRPFX}/${slug}"

# ③ live 탭 dedup — 워커(🛠)/재작업·복구(↩) 탭이 이미 있으면 이중 스폰 방지.
# ⚠️ cmux 빈 응답(플레이크)을 "탭 없음"으로 믿으면 dedup이 뚫려 이중 스폰된다 — 판정 불가 = 보류.
if [[ -n "$CMUX" ]]; then
  tabs="$("$CMUX" list-workspaces 2>/dev/null)"
  [[ -z "$tabs" ]] && { echo "rework $LOOP/$ID: cmux list-workspaces 빈 응답(플레이크?) — 보류(중복 spawn 방지)"; exit 0; }
  live="$(print -r -- "$tabs" | grep -iE "(🛠|↩)[[:space:]]+${LOOP}[[:space:]]+${ID}([[:space:]]|\$)" | head -1)"
  [[ -n "$live" ]] && { echo "rework $LOOP/$ID: 이미 live 탭 있음 — skip"; exit 0; }
fi

# PR 상태 + 가장 최근 피드백 시각(사람의 CHANGES_REQUESTED 리뷰 ∪ 검증자 fail verdict)을 계산 (cwd=레포 — URL/org 추측 금지 원칙).
prjson="$(cd "$REPO" && "$GH" pr view "$BR" --json state,reviewDecision,reviews 2>/dev/null)"
[[ -z "$prjson" ]] && { echo "rework $LOOP/$ID: 브랜치 $BR 의 PR 없음 — skip"; exit 0; }
fail_ts="$(node -e 'try{const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(v.verdict==="fail"&&v.ts)process.stdout.write(String(Math.floor(+v.ts)))}catch{}' "$STATE/verify/$ID.json" 2>/dev/null)"
latest_epoch="$(node -e '
  const j=JSON.parse(process.argv[1]); const failTs=+process.argv[2]||0;
  if(j.state!=="OPEN"){process.stdout.write("");process.exit(0)}   // 피드백 반영은 열린 PR에만 의미 있음
  let m=failTs;
  if(j.reviewDecision==="CHANGES_REQUESTED"){
    const ts=(j.reviews||[]).filter(r=>r.state==="CHANGES_REQUESTED"&&r.submittedAt).map(r=>Math.floor(new Date(r.submittedAt).getTime()/1000));
    if(ts.length)m=Math.max(m,...ts);
  }
  process.stdout.write(m?String(m):"")' "$prjson" "${fail_ts:-0}")"
[[ -z "$latest_epoch" ]] && { echo "rework $LOOP/$ID: OPEN PR에 변경요청 리뷰/❌ verdict 없음 — skip"; exit 0; }

# rework.json 원자적 read-modify-write 헬퍼 (watchdog liveness.json과 동일 패턴).
rw_get(){ node -e 'const fs=require("fs"),[f,id,k]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}const e=o[id]||{};process.stdout.write(e[k]!=null?String(e[k]):"")' "$RW" "$1" "$2"; }
rw_set(){ node -e 'const fs=require("fs"),[f,id,p]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}o[id]=Object.assign({},o[id]||{},JSON.parse(p));fs.writeFileSync(f,JSON.stringify(o))' "$RW" "$1" "$2"; }

# ① 새 피드백 게이트 — 마지막 spawn 시점(lastAt) 이후의 변경요청 리뷰/fail verdict가 없으면 이미 처리(중)인 것.
lastAt="$(rw_get "$ID" lastAt)"; [[ -z "$lastAt" ]] && lastAt=0
(( latest_epoch <= lastAt )) && { echo "rework $LOOP/$ID: 마지막 재작업 이후 새 피드백 없음 — skip"; exit 0; }

# ② 상한 — 초과 시 exhausted 기록(대시보드/봇이 rework-exhausted로 표면화)하고 사람에게 넘긴다.
count="$(rw_get "$ID" count)"; [[ -z "$count" ]] && count=0
ts=$(date '+%s')
if (( count >= REWORK_MAX )); then
  rw_set "$ID" "{\"exhausted\":true}"
  print -r -- "{\"ts\":$ts,\"type\":\"worker\",\"event\":\"rework-exhausted\",\"issue\":\"$ID\",\"count\":$count}" >> "$STATE/runs.jsonl"
  echo "REWORK_EXHAUSTED $LOOP/$ID: 재작업 ${count}회 상한(${REWORK_MAX}) 도달 — 사람 확인 필요"
  exit 0
fi

# worktree 보장 — 없으면 PR 브랜치 기준으로 재생성 (push된 커밋이 진실이므로 origin/$BR 우선).
if [[ ! -d "$WT" ]]; then
  git -C "$REPO" fetch origin -q
  git -C "$REPO" worktree add "$WT" "$BR" 2>/dev/null \
    || git -C "$REPO" worktree add -b "$BR" "$WT" "origin/$BR" \
    || { echo "ERROR: rework worktree 재생성 실패 $WT"; exit 1; }
fi

out="$("$CMUX" new-workspace --cwd "$WT" --command "LOOP_ID=$LOOP LOOP_ISSUE=$ID LOOP_REWORK=1 $RUNNER" 2>&1)"
ref="$(echo "$out" | grep -oE 'workspace:[0-9]+' | head -1)"
if [[ -n "$ref" ]]; then
  "$CMUX" rename-workspace --workspace "$ref" "↩ $LOOP $ID" 2>/dev/null
  cnt=$("$CMUX" list-workspaces 2>/dev/null | grep -c 'workspace:')   # 맨 밑에 추가
  "$CMUX" reorder-workspace --workspace "$ref" --index "$cnt" >/dev/null 2>&1
fi
rw_set "$ID" "{\"count\":$(( count + 1 )),\"lastAt\":$latest_epoch,\"at\":$ts}"
print -r -- "{\"ts\":$ts,\"type\":\"worker\",\"event\":\"rework\",\"issue\":\"$ID\",\"attempt\":$(( count + 1 )),\"workspace\":\"$ref\"}" >> "$STATE/runs.jsonl"
[[ -z "$ref" ]] && echo "[$(date '+%F %T')] WARN rework $ID: cmux 응답=[$out] (detach된 컨텍스트?)" >> "$STATE/dispatcher.log"
echo "rework spawned $LOOP/$ID (attempt $(( count + 1 ))/$REWORK_MAX) → worktree=$WT tab=$ref"
