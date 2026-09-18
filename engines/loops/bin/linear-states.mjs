#!/usr/bin/env node
// Linear 프로젝트의 모든 이슈 상태를 출력한다(의존성 0, 공유 linearGql 헬퍼).
// usage: linear-states.mjs <projectId> [label]   (env: LINEAR_API_KEY)
//   [label] 지정 시 그 라벨을 가진 이슈만 (하나의 프로젝트를 라벨로 나눠 여러 루프가 공유할 때 — 예: bug / feature-request).
//   비면 프로젝트 전체(기존 동작 그대로, 하위호환).
// 출력: 한 줄에 "<identifier>\t<statusType>"  (statusType: backlog|unstarted|started|completed|canceled|triage)
// 키 없거나 실패하면 빈 stdout + 비0 종료 — 호출자(cleanup-terminal·watchdog·event-poll)가 폴백/보류 신호로 처리한다.
// 실패(응답 이상·JSON 오류·네트워크·타임아웃)는 stderr에 원인 1줄을 남긴다 — stdout 계약·비0 종료는 불변.
import { linearGql } from './linear-gql.mjs';

const projectId = process.argv[2];
const label = (process.argv[3] || '').trim();   // optional: 이 라벨 이슈만 (공유 프로젝트 라벨 분리). 비면 전체.
const key = process.env.LINEAR_API_KEY || '';
if (!projectId || !key) { process.exit(1); }

const query = label
  ? `query($id:String!,$label:String!){ project(id:$id){ issues(first:250, filter:{ labels:{ some:{ name:{ eq:$label } } } }){ nodes{ identifier state{ type } } } } }`
  : `query($id:String!){ project(id:$id){ issues(first:250){ nodes{ identifier state{ type } } } } }`;
const variables = label ? { id: projectId, label } : { id: projectId };

try {
  const d = await linearGql(query, variables, key);   // j.errors·JSON·네트워크·타임아웃(15s)은 여기서 reject → catch
  const nodes = d?.project?.issues?.nodes;
  if (!Array.isArray(nodes)) { console.error('linear-states: 예상치 못한 응답'); process.exit(1); }
  for (const n of nodes) if (n.identifier) process.stdout.write(n.identifier + '\t' + (n.state?.type || '') + '\n');
} catch (e) { console.error(`linear-states: ${e.message}`); process.exit(1); }
