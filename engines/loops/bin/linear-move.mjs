#!/usr/bin/env node
// 이슈 1건을 팀의 <stateType> 상태(그 타입의 최저 position 상태)로 이동(멱등·best-effort). 호출처:
//   • cleanup-terminal.sh — 유령/잔재 회수 시 `backlog`.
//   • spawn-worker.sh — spawn 성공 직후 `started`(=In Progress) 선반영(dead-at-startup blind spot 차단).
// usage: linear-move.mjs <issueIdentifier> [stateType=backlog]   (env: LINEAR_API_KEY)
// 성공: stdout "moved <id> → <stateName>" (또는 이미 그 상태면 "already …") + exit 0.
// 실패(키없음·이슈없음·상태없음·네트워크·JSON): stderr 1줄 + 비0 종료 — 호출자는 비치명적으로 처리(리소스 회수는 계속).
import { linearGql } from './linear-gql.mjs';

const id = process.argv[2];
const wantType = process.argv[3] || 'backlog';
const key = process.env.LINEAR_API_KEY || '';
if (!id || !key) { console.error('linear-move: id/LINEAR_API_KEY 필요'); process.exit(1); }

try {
  const d = await linearGql(
    `query($id:String!){ issue(id:$id){ id identifier state{ type } team{ states(first:50){ nodes{ id name type position } } } } }`,
    { id }, key);
  const issue = d?.issue;
  if (!issue) { console.error(`linear-move: 이슈 ${id} 없음`); process.exit(1); }
  if (issue.state?.type === wantType) { console.log(`already ${wantType} ${id}`); process.exit(0); }   // 멱등 — 이미 목표 상태면 무동작
  const cands = (issue.team?.states?.nodes || []).filter(s => s.type === wantType).sort((a, b) => a.position - b.position);
  if (!cands.length) { console.error(`linear-move: 팀에 '${wantType}' 상태 없음`); process.exit(1); }
  const target = cands[0];
  const m = await linearGql(`mutation($id:String!,$sid:String!){ issueUpdate(id:$id, input:{stateId:$sid}){ success } }`,
    { id: issue.id, sid: target.id }, key);
  if (!m?.issueUpdate?.success) { console.error(`linear-move: issueUpdate 실패 ${id}`); process.exit(1); }
  console.log(`moved ${id} → ${target.name}`);
} catch (e) { console.error(`linear-move: ${e.message}`); process.exit(1); }
