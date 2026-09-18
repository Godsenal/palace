#!/usr/bin/env node
// 제품 inbox 조회: 프로젝트에서 **라우트 라벨이 하나도 없는** 미분류 이슈(backlog|triage|unstarted)를 나열한다.
// 라벨이 곧 루프 라우팅이므로(linearLabel) "라우트 라벨 부재 = 아직 어느 루프 소관도 아닌, 사람이 그냥 쌓은 이슈".
// triage.sh(제품 상위 분류기)가 소비. 상태를 따로 두지 않는 설계 — 라벨이 붙는 순간 이 목록에서 사라지는 것 자체가 dedup.
// usage: linear-inbox.mjs <projectId> <routeLabel1,routeLabel2,...>   (env: LINEAR_API_KEY)
// 출력: JSONL {"identifier","title","desc"(≤800자),"state"} — 키없음/실패: stderr 1줄 + 비0 종료(호출자는 이번 패스 skip).
import { linearGql } from './linear-gql.mjs';

const pid = process.argv[2];
const routes = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean);
const key = process.env.LINEAR_API_KEY || '';
if (!pid || !routes.length || !key) { console.error('linear-inbox: projectId/routeLabels/LINEAR_API_KEY 필요'); process.exit(1); }

try {
  const d = await linearGql(
    `query($id:String!){ project(id:$id){ issues(first:250){ nodes{ identifier title description state{ type } labels{ nodes{ name } } } } } }`,
    { id: pid }, key);
  const nodes = d?.project?.issues?.nodes;
  if (!Array.isArray(nodes)) { console.error('linear-inbox: 예상치 못한 응답'); process.exit(1); }
  const rset = new Set(routes);
  for (const n of nodes) {
    if (!['backlog', 'triage', 'unstarted'].includes(n.state?.type)) continue;   // 진행/종료 상태는 분류 대상 아님
    if ((n.labels?.nodes || []).some(l => rset.has(l.name))) continue;           // 이미 라우팅됨
    process.stdout.write(JSON.stringify({ identifier: n.identifier, title: n.title, desc: (n.description || '').slice(0, 800), state: n.state.type }) + '\n');
  }
} catch (e) { console.error(`linear-inbox: ${e.message}`); process.exit(1); }
