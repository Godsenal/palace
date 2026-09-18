#!/usr/bin/env node
// 프로젝트의 Backlog에 이슈 1건 생성. 호출처: incident-bridge.sh(엔진 장애 자동 발제).
// project → team + backlog 상태(최저 position) 해석은 dashboard-server의 create-issue와 동일 패턴.
// usage: linear-create.mjs <projectId> <title>   (description은 stdin — 코드블록/따옴표 인용 지옥 회피, env: LINEAR_API_KEY)
// 성공: stdout "<identifier>\t<url>" + exit 0. 실패: stderr 1줄 + 비0 종료 — 호출자는 비치명적으로 처리.
import { readFileSync } from 'node:fs';
import { linearGql } from './linear-gql.mjs';

const pid = process.argv[2];
const title = process.argv[3];
const key = process.env.LINEAR_API_KEY || '';
if (!pid || !title || !key) { console.error('linear-create: projectId/title/LINEAR_API_KEY 필요'); process.exit(1); }

let description = '';
try { description = readFileSync(0, 'utf8'); } catch { description = ''; }   // stdin 미연결(TTY 직호출)이면 빈 본문

try {
  const q = await linearGql(
    `query($pid:String!){ project(id:$pid){ teams(first:1){ nodes{ id states(first:50){ nodes{ id type position } } } } } }`,
    { pid }, key);
  const team = q?.project?.teams?.nodes?.[0];
  if (!team) { console.error(`linear-create: project ${pid}의 team을 못 찾음`); process.exit(1); }
  const bl = (team.states?.nodes || []).filter(s => s.type === 'backlog').sort((a, b) => a.position - b.position)[0];
  const input = { teamId: team.id, projectId: pid, title, description, ...(bl ? { stateId: bl.id } : {}) };
  const m = await linearGql(`mutation($in:IssueCreateInput!){ issueCreate(input:$in){ success issue{ identifier url } } }`, { in: input }, key);
  const iss = m?.issueCreate?.issue;
  if (!(m?.issueCreate?.success && iss)) { console.error('linear-create: issueCreate 실패'); process.exit(1); }
  process.stdout.write(`${iss.identifier}\t${iss.url}`);
} catch (e) { console.error(`linear-create: ${e.message}`); process.exit(1); }
