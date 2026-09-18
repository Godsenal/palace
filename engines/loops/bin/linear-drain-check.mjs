#!/usr/bin/env node
// drain 게이트 전용 카운트: "<드레인가능 backlog 수>\t<started 수>" 를 출력한다. 호출처: dispatch.sh drain_should_fire.
// 드레인 가능 = stateType backlog 중에서 **워커가 실제로 집어갈 수 있는 것만**:
//   • run-log 추적 이슈 제외(제목 "… — run log") — 항상 Backlog에 상주해서 게이트를 영구로 열어버림(120s마다 무의미 사이클).
//   • 본문에 human-gate 명시된 이슈 제외 — STEP3 fan-out 대상이 아니므로(사람 결정 대기) 드레인할 일이 아님.
// linear-states.mjs 를 확장하지 않는 이유: 그 출력(2필드 TSV)은 watchdog/cleanup/event-poll이 파싱하는 계약이라
// 필드 추가가 파괴적이다 — 게이트는 목적이 달라 전용 조회가 맞다.
// usage: linear-drain-check.mjs <projectId> [label]   (env: LINEAR_API_KEY)
// 실패: stderr 1줄 + 비0 종료 — 호출자(drain_should_fire)는 보수적으로 발사한다.
import { linearGql } from './linear-gql.mjs';

const projectId = process.argv[2];
const label = (process.argv[3] || '').trim();
const key = process.env.LINEAR_API_KEY || '';
if (!projectId || !key) { process.exit(1); }

const query = label
  ? `query($id:String!,$label:String!){ project(id:$id){ issues(first:250, filter:{ labels:{ some:{ name:{ eq:$label } } } }){ nodes{ title description state{ type } } } } }`
  : `query($id:String!){ project(id:$id){ issues(first:250){ nodes{ title description state{ type } } } } }`;

try {
  const d = await linearGql(query, label ? { id: projectId, label } : { id: projectId }, key);
  const nodes = d?.project?.issues?.nodes;
  if (!Array.isArray(nodes)) { console.error('linear-drain-check: 예상치 못한 응답'); process.exit(1); }
  const drainable = nodes.filter(n =>
    n.state?.type === 'backlog' &&
    !/run log/i.test(n.title || '') &&
    !/human-gate/.test(n.description || '')
  ).length;
  const started = nodes.filter(n => n.state?.type === 'started').length;
  process.stdout.write(`${drainable}\t${started}`);
} catch (e) { console.error(`linear-drain-check: ${e.message}`); process.exit(1); }
