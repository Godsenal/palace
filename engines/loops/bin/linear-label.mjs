#!/usr/bin/env node
// 이슈에 팀 라벨 1개를 부착(기존 라벨 보존 · 멱등) + 선택 코멘트. 호출처: triage.sh(제품 분류 라우팅).
// 안전 설계: LLM 분류기는 라벨 '이름 선택'만 하고, Linear 변경(부착·코멘트)은 이 결정론 스크립트가 한다 —
// 팀에 없는 라벨명이면 여기서 비0 종료로 거부되므로 분류기 오출력이 Linear를 오염시킬 수 없다.
// usage: linear-label.mjs <issueIdentifier> <labelName|-> [comment]   (env: LINEAR_API_KEY)
//   labelName '-' = 라벨 없이 코멘트만 (분류 포기 안내 등).
// 성공: "labeled <id> +<label>" / "already <id> <label>" / "commented <id>". 실패: stderr 1줄 + 비0 종료.
import { linearGql } from './linear-gql.mjs';

const [, , id, labelName, comment] = process.argv;
const key = process.env.LINEAR_API_KEY || '';
if (!id || !labelName || !key) { console.error('linear-label: id/labelName/LINEAR_API_KEY 필요'); process.exit(1); }

try {
  const d = await linearGql(
    `query($id:String!){ issue(id:$id){ id labels{ nodes{ id name } } team{ labels(first:100){ nodes{ id name } } } } }`,
    { id }, key);
  const iss = d?.issue;
  if (!iss) { console.error(`linear-label: 이슈 ${id} 없음`); process.exit(1); }
  if (labelName !== '-') {
    const cur = iss.labels.nodes;
    if (cur.some(l => l.name === labelName)) { console.log(`already ${id} ${labelName}`); }
    else {
      const t = iss.team.labels.nodes.find(l => l.name === labelName);
      if (!t) { console.error(`linear-label: 팀에 '${labelName}' 라벨 없음`); process.exit(1); }
      const m = await linearGql(`mutation($id:String!,$l:[String!]){ issueUpdate(id:$id,input:{labelIds:$l}){ success } }`,
        { id: iss.id, l: [...cur.map(l => l.id), t.id] }, key);
      if (!m?.issueUpdate?.success) { console.error(`linear-label: issueUpdate 실패 ${id}`); process.exit(1); }
      console.log(`labeled ${id} +${labelName}`);
    }
  }
  if (comment) {
    const c = await linearGql(`mutation($id:String!,$b:String!){ commentCreate(input:{issueId:$id,body:$b}){ success } }`,
      { id: iss.id, b: comment }, key);
    if (!c?.commentCreate?.success) { console.error(`linear-label: commentCreate 실패 ${id}`); process.exit(1); }
    if (labelName === '-') console.log(`commented ${id}`);
  }
} catch (e) { console.error(`linear-label: ${e.message}`); process.exit(1); }
