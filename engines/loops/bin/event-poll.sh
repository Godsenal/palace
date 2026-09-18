#!/bin/zsh
# 이벤트 기반 트리거 폴러: 시간 스케줄만이던 루프에 "세상에 반응하는" 트리거를 얹는다.
# dispatch.sh가 ≤60s 케이던스로 호출. config `on:{}` 의 이벤트 소스를 폴링해 조건 충족 시 **next_fire를 now로 당긴다**
# — 새 실행 경로 없음(발사는 여전히 dispatcher의 기존 run-now 메커니즘·PAUSED/enabled 가드 그대로).
#   • on.ciFailure=true  → 대상 레포 prBase 브랜치에 **새** CI 실패 run 등장 시 즉시 사이클 (그 사이클이 triage).
#   • on.prReview=true   → 이 루프의 열린 PR에 **새** 사람 리뷰 제출 시 즉시 사이클 (STEP1이 rework/머지정리를 interval 대기 없이 처리).
#   • on.linearNew=true  → Linear 프로젝트에 **새** Backlog 이슈 등장 시 즉시 사이클 (사람이 Linear에서 이슈만 만들면 곧 착수).
# 커서(마지막 확인 지점)는 state/events.json. 첫 폴링은 조용히 시드(과거분 폭탄 방지). 발화는 runs.jsonl에 trigger로 기록
# — "왜 지금 돌았는지" 항상 추적 가능. 폴링 read-only + next_fire 쓰기뿐 — 머지/배포/Linear 변경 없음.
# usage: event-poll.sh <loop-id>
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: event-poll.sh <loop-id>}"
ROOT="$LOOPS_HOME"; LOOPDIR=$ROOT/loops/$LOOP; STATE=$LOOPDIR/state; CFG=$LOOPDIR/config.json
GH="$GH_BIN"
[[ -f "$CFG" ]] || exit 0
[[ "$(cfgval "$CFG" enabled 2>/dev/null)" == "false" ]] && exit 0
[[ -f "$STATE/PAUSED" ]] && exit 0
[[ -d /tmp/loop-$LOOP.lockdir ]] && exit 0   # run 진행 중 — 어차피 그 run이 최신 상태를 처리한다
ON_CI="$(cfgval "$CFG" on.ciFailure 2>/dev/null)"
ON_REVIEW="$(cfgval "$CFG" on.prReview 2>/dev/null)"
ON_LNEW="$(cfgval "$CFG" on.linearNew 2>/dev/null)"
[[ "$ON_CI" != "true" && "$ON_REVIEW" != "true" && "$ON_LNEW" != "true" ]] && exit 0
REPO="$(cfgval "$CFG" repo)"; PRBASE="$(cfgval "$CFG" prBase)"; [[ -z "$PRBASE" ]] && PRBASE=develop
BRPFX="$(cfgval "$CFG" branchPrefix)"; [[ -z "$BRPFX" ]] && BRPFX="loop-$LOOP"
PID="$(cfgval "$CFG" linearProjectId)"
LABEL="$(cfgval "$CFG" linearLabel)"   # 공유 프로젝트 라벨 분리 — 비면 전체. linear-new 는 이 라벨의 신규 Backlog만 감지.
EV="$STATE/events.json"

# events.json 커서 read-modify-write: 새 값을 쓰고 **이전 값**을 출력 (빈 출력 = 첫 시드).
ev_rmw(){ node -e 'const fs=require("fs"),[f,k,v]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}const prev=o[k]==null?"":String(o[k]);o[k]=v;fs.writeFileSync(f,JSON.stringify(o));process.stdout.write(prev)' "$EV" "$1" "$2"; }

now=$(date +%s)
fire(){ # $1=trigger $2=note — next_fire를 당긴다(이미 임박하면 no-op). 발사 자체는 dispatcher 본 루프가 한다.
  nf="$(cat "$STATE/next_fire" 2>/dev/null || echo 0)"
  (( nf <= now + 30 )) && return
  echo "$now" > "$STATE/next_fire"
  print -r -- "{\"ts\":$now,\"type\":\"cycle\",\"event\":\"trigger\",\"trigger\":\"$1\",\"note\":\"$2\"}" >> "$STATE/runs.jsonl"
  echo "⚡ event $LOOP: $1 → 즉시 사이클 ($2)"
}

# ── CI 실패 (prBase 브랜치의 최신 failure run이 바뀌었는가) ──
if [[ "$ON_CI" == "true" && -n "$GH" && -n "$REPO" ]]; then
  latest="$(cd "$REPO" && "$GH" run list -b "$PRBASE" --status failure -L 1 --json databaseId -q '.[0].databaseId // empty' 2>/dev/null)"
  if [[ -n "$latest" ]]; then
    prev="$(ev_rmw ciLastId "$latest")"
    if [[ -n "$prev" && "$prev" != "$latest" ]]; then fire ci-failure "CI run $latest 실패 ($PRBASE)"; fi
  fi
fi

# ── 새 PR 리뷰 (이 루프 열린 PR들의 최신 리뷰 제출 시각이 전진했는가) ──
if [[ "$ON_REVIEW" == "true" && -n "$GH" && -n "$REPO" ]]; then
  maxAt="$(cd "$REPO" && "$GH" pr list --search "head:${BRPFX}/" --state open --json reviews -q '[.[].reviews[].submittedAt | select(.)] | max // empty' 2>/dev/null)"
  if [[ -n "$maxAt" ]]; then
    ep="$(node -e 'const t=Math.floor(new Date(process.argv[1]).getTime()/1000);process.stdout.write(Number.isFinite(t)?String(t):"")' "$maxAt")"
    if [[ -n "$ep" ]]; then
      prev="$(ev_rmw reviewLastAt "$ep")"
      if [[ -n "$prev" ]] && (( ep > prev )); then fire pr-review "새 리뷰 제출됨"; fi
    fi
  fi
fi

# ── Linear 신규 Backlog 이슈 (프로젝트 backlog 집합에 새 ID 등장) ──
if [[ "$ON_LNEW" == "true" && -n "$PID" && -n "${LINEAR_API_KEY:-}" ]]; then
  # Linear 응답 자체가 비면(키 만료/네트워크) 커서를 건드리지 않는다 — 다음 성공 폴링 때 전부 "신규"로 오폭하는 것 방지.
  lsout="$(LINEAR_API_KEY="${LINEAR_API_KEY:-}" node "$ROOT/bin/linear-states.mjs" "$PID" "$LABEL" 2>/dev/null)"
  if [[ -n "$lsout" ]]; then
    # 방금 받은 상태표를 그대로 남긴다 — 대시보드가 이걸 재사용해 같은 질의를 중복하지 않는다(Linear rate-limit 절약).
    # 소비자: dashboard-server.mjs refreshLinear(). 신선도(mtime)로만 판단하므로 형식은 linear-states.mjs 출력 그대로.
    # 비어있을 땐 절대 안 쓴다(위 -n 가드) — 빈 파일을 "이슈 전멸"로 읽히면 표시가 통째로 뒤집힌다.
    print -r -- "$lsout" > "$STATE/linear-states.tsv.tmp" && mv -f "$STATE/linear-states.tsv.tmp" "$STATE/linear-states.tsv"
    blist="$(print -r -- "$lsout" | awk -F'\t' '$2=="backlog"{print $1}')"
    fresh="$(print -r -- "$blist" | node -e '
      const fs=require("fs"),f=process.argv[1];let d="";
      process.stdin.on("data",c=>d+=c).on("end",()=>{
        const cur=d.split("\n").filter(Boolean).sort();
        let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}
        const prev=o.backlogIds;
        o.backlogIds=cur;fs.writeFileSync(f,JSON.stringify(o));
        if(!Array.isArray(prev)){process.stdout.write("");return}   // 첫 시드 — 조용히
        const p=new Set(prev);process.stdout.write(cur.filter(x=>!p.has(x)).join(","));
      })' "$EV")"
    [[ -n "$fresh" ]] && fire linear-new "새 Backlog: $fresh"
  fi
fi
exit 0
