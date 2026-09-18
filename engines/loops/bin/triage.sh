#!/bin/zsh
# 제품(products/<id>) 상위 분류기: 공유 Linear 프로젝트에 사람이 **라벨 없이 그냥 쌓은** 이슈(inbox)를 읽어
# product.json `triage.routes` 중 하나로 분류해 라벨을 붙인다. 라벨이 붙는 순간 그 라벨을 linearLabel로 가진
# 루프의 event-poll(on.linearNew)이 잡아 즉시 사이클로 이어진다 — **새 실행 경로 없음**(발사는 기존 dispatcher 레일).
# dispatch.sh가 ≤60s 케이던스로 호출(제품별). 멱등·중복 안전.
#
# 구조 안전(분류기의 비결정성 방어):
#   • LLM은 {"label","reason"} **선택만** 한다 — Linear 변경(라벨·코멘트)은 결정론 스크립트(linear-label.mjs)가 하고,
#     routes에 없는 라벨명은 셸에서 버려진다. OMP triage 역할은 도구를 전부 차단한 순수 텍스트 분류다.
#   • 이슈당 attempts 캡(3): 분류 불능 이슈로 무한 재시도하지 않는다 — 캡 도달 시 "라벨 직접 지정" 코멘트 1회 + 포기(gaveUp).
#   • "무엇이 미분류인가"는 Linear 자신이 답한다(라우트 라벨 부재 = 미분류) — 로컬 상태(state/triage.json)는 attempts dedup 최소만.
#   • 머지/배포/상태전이/이슈 생성 없음 — 라벨 부착 + 코멘트뿐.
# usage: triage.sh <product-id>   (env: TRIAGE_DRY_RUN=1 → 분류 결과만 출력, Linear 안 만짐)
set -u
source "${0:A:h}/_common.sh"
P="${1:?usage: triage.sh <product-id>}"
ROOT="$LOOPS_HOME"; PDIR=$ROOT/products/$P; PJ=$PDIR/product.json; STATE=$PDIR/state
[[ -f "$PJ" ]] || exit 0
[[ -n "${LINEAR_API_KEY:-}" ]] || exit 0            # 분류 채널 미개통 — 스킵(미설정의 정상 경로)
mkdir -p "$STATE"
ROUTE_NAMES="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(Object.keys((c.triage||{}).routes||{}).join(","))' "$PJ")"
[[ -z "$ROUTE_NAMES" ]] && exit 0                    # triage 미설정 제품(그룹핑·상속만 쓰는 경우) — 무음 스킵이 정상 경로
PID="$(cfgval "$PJ" linearProjectId)"; [[ -z "$PID" ]] && { echo "⚠️ triage $P: routes는 있는데 linearProjectId 없음 — skip"; exit 0; }
PRODUCT_OMP="$(cfgval "$PJ" ompCommand)"; [[ -n "$PRODUCT_OMP" ]] && export OMP_COMMAND="$PRODUCT_OMP"
MODEL="$(cfgval "$PJ" triage.model)"
MAXPASS="$(cfgval "$PJ" triage.maxPerPass)"; [[ -z "$MAXPASS" ]] && MAXPASS=5

# 겹침 방지: 분류 호출(LLM)이 60s 케이던스보다 길 수 있다 — 진행 중이면 이번 패스는 조용히 넘어간다.
LOCK=/tmp/triage-$P.lockdir
mkdir "$LOCK" 2>/dev/null || exit 0
trap "rmdir '$LOCK' 2>/dev/null" EXIT

# 분류 호출 타임아웃은 OMP runner가 직접 강제하고 normalized errorClass를 기록한다.
export OMP_TIMEOUT_SEC=120

# 라우트 소비자 확인(경고만): 각 라우트 라벨을 linearLabel로 가진 enabled 루프가 있는가 — 없으면 라벨을 붙여도
# 아무 루프도 안 집어간다(사람이 수동 소비할 수는 있으니 라벨링은 계속하되 loud하게 알림).
for rn in ${(s:,:)ROUTE_NAMES}; do
  found=""
  for LC in $ROOT/loops/*/config.json(N); do
    [[ "$(cfgval "$LC" linearProjectId 2>/dev/null)" == "$PID" ]] || continue
    [[ "$(cfgval "$LC" linearLabel 2>/dev/null)" == "$rn" ]] || continue
    [[ "$(cfgval "$LC" enabled 2>/dev/null)" == "false" ]] && continue
    found=1; break
  done
  [[ -z "$found" ]] && echo "⚠️ triage $P: 라우트 '$rn' 을 소비하는 enabled 루프 없음 — 라벨은 붙이지만 자동 처리되지 않는다"
done

# triage.json helpers (liveness.json과 동일 패턴)
tj_get(){ node -e 'const fs=require("fs"),[f,id,k]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}const e=(o.issues||{})[id]||{};process.stdout.write(e[k]!=null?String(e[k]):"")' "$STATE/triage.json" "$1" "$2"; }
tj_set(){ node -e 'const fs=require("fs"),[f,id,p]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f))}catch{}o.issues=o.issues||{};o.issues[id]=Object.assign({},o.issues[id]||{},JSON.parse(p));fs.writeFileSync(f,JSON.stringify(o))' "$STATE/triage.json" "$1" "$2"; }

now=$(date +%s); n=0
inbox="$(LINEAR_API_KEY="${LINEAR_API_KEY:-}" node "$ROOT/bin/linear-inbox.mjs" "$PID" "$ROUTE_NAMES")" || exit 0   # 조회 실패 = 이번 패스 skip(비치명)
[[ -z "$inbox" ]] && exit 0
print -r -- "$inbox" | while IFS= read -r line; do
  (( n >= MAXPASS )) && break
  ident="$(print -r -- "$line" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).identifier||"")}catch{}})')"
  [[ -z "$ident" ]] && continue
  [[ "$(tj_get "$ident" gaveUp)" == "true" ]] && continue
  at="$(tj_get "$ident" attempts)"; [[ -z "$at" ]] && at=0
  if (( at >= 3 )); then
    LINEAR_API_KEY="${LINEAR_API_KEY:-}" node "$ROOT/bin/linear-label.mjs" "$ident" - "🏷 triage 3회 실패 — 자동 분류를 포기합니다. \`${ROUTE_NAMES}\` 중 라벨을 직접 지정해주세요." >/dev/null 2>&1
    tj_set "$ident" "{\"gaveUp\":true}"
    echo "🏷 triage $P/$ident — 분류 ${at}회 실패 → 포기(사람 라벨 지정 안내 코멘트)"
    continue
  fi

  # 분류 프롬프트 구성(node가 이슈 JSON + routes로 전체 프롬프트를 만든다 — 셸 인용 지옥 회피)
  PROMPT="$(print -r -- "$line" | node -e '
    const fs=require("fs");let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const i=JSON.parse(d);const c=JSON.parse(fs.readFileSync(process.argv[1]));
      const routes=Object.entries((c.triage||{}).routes||{}).map(([k,v])=>`- ${k}: ${v}`).join("\n");
      process.stdout.write(`너는 이슈 라우터다. 아래 Linear 이슈를 읽고 라벨 중 정확히 하나로 분류하라.\n\n라벨:\n${routes}\n\n이슈 제목: ${i.title}\n이슈 본문:\n${i.desc||"(없음)"}\n\n출력: JSON 한 줄만 — {"label":"<위 라벨 중 하나>","reason":"<근거 한 문장>"}. 다른 텍스트·마크다운·코드펜스 금지.`);
    });' "$PJ")"

  out="$(print -rn -- "$PROMPT" | omp_run triage "$MODEL" 2>>"$STATE/triage.log")"
  # envelope 파싱 + routes 검증: 실패/미검증 라벨 → 빈 출력(비0) → attempts++
  res="$(print -r -- "$out" | node -e '
    const fs=require("fs");let d="";process.stdin.on("data",c=>c&&(d+=c)).on("end",()=>{
      let j;try{j=JSON.parse(d)}catch{process.exit(1)}
      let r=String(j.result??"").trim().replace(/^```(json)?\s*/i,"").replace(/\s*```$/,"").trim();
      let o;try{o=JSON.parse(r)}catch{process.exit(1)}
      const routes=Object.keys((JSON.parse(fs.readFileSync(process.argv[1])).triage||{}).routes||{});
      if(!routes.includes(o.label))process.exit(1);
      const reason=String(o.reason||"").replace(/[\n\t]/g," ").slice(0,200);
      process.stdout.write(o.label+"\t"+reason+"\t"+(j.usage?.usd??""));
    });' "$PJ")"
  if [[ -z "$res" ]]; then
    tj_set "$ident" "{\"attempts\":$(( at + 1 )),\"lastAt\":$now}"
    echo "⚠️ triage $P/$ident — 분류 출력 파싱/검증 실패 (attempt $(( at + 1 ))/3)"
    continue
  fi
  label="${res%%$'\t'*}"; rest="${res#*$'\t'}"; reason="${rest%%$'\t'*}"; usd="${rest##*$'\t'}"

  if [[ -n "${TRIAGE_DRY_RUN:-}" ]]; then
    echo "🏷 [dry-run] $P/$ident → $label ($reason)"
    continue
  fi

  if LINEAR_API_KEY="${LINEAR_API_KEY:-}" node "$ROOT/bin/linear-label.mjs" "$ident" "$label" "🏷 triage: **$label** — $reason  _(product \`$P\` 자동 분류 · 오분류면 라벨을 직접 바꿔주세요)_"; then
    tj_set "$ident" "{\"attempts\":0,\"labeled\":\"$label\",\"lastAt\":$now}"
    print -r -- "{\"ts\":$now,\"type\":\"triage\",\"event\":\"labeled\",\"issue\":\"$ident\",\"label\":\"$label\"}" >> "$STATE/runs.jsonl"
    [[ -n "$usd" ]] && print -r -- "{\"ts\":$now,\"kind\":\"triage\",\"usd\":$usd}" >> "$STATE/costs.jsonl"
    echo "🏷 triage $P/$ident → $label ($reason)"
    (( n++ ))
  else
    tj_set "$ident" "{\"attempts\":$(( at + 1 )),\"lastAt\":$now}"
    echo "⚠️ triage $P/$ident — 라벨 부착 실패 (attempt $(( at + 1 ))/3)"
  fi
done
exit 0
