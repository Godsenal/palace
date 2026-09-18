#!/usr/bin/env node
// 한 이슈의 PR에 붙은 **preview URL**을 찾아 stdout으로. 실측 검증(A/B)의 대상 URL을 정하는 결정론 층.
//
// ⚠️ URL을 브랜치명으로 **조합하지 않는다**. PR 코멘트(배포 봇이 남긴 것)가 유일한 출처다 —
//    레포 관례("PR URL은 gh pr view에서만")와 같은 이유: 배포 규칙이 바뀌어도 조합식은 조용히 틀린 URL을 낸다.
//    못 찾으면 비0 종료 + 사유. 빈 URL로 "검증 통과"가 되는 경로를 만들지 않는다.
//
// usage: preview-url.mjs <loop-id> <issue-id> [--base]
//   --base : PR preview 대신 config.measure.baseUrl(비교 기준선)을 출력
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLoopConfig } from './loop-config.mjs';

const ROOT = process.env.LOOPS_HOME || dirname(dirname(fileURLToPath(import.meta.url)));
const [, , loopId, issueId, ...rest] = process.argv;
if (!loopId || !issueId) { console.error('usage: preview-url.mjs <loop-id> <issue-id> [--base]'); process.exit(2); }

const cfg = loadLoopConfig(ROOT, loopId);
const m = cfg.measure || {};
if (rest.includes('--base')) {
  if (!m.baseUrl) { console.error(`preview-url: ${loopId} config에 measure.baseUrl이 없다`); process.exit(2); }
  process.stdout.write(`${m.baseUrl}\n`);
  process.exit(0);
}
if (!m.previewUrlRegex) {
  console.error(`preview-url: ${loopId} config에 measure.previewUrlRegex가 없다 — PR 코멘트에서 preview URL을 뽑을 규칙이 필요하다`);
  process.exit(2);
}

// 브랜치 규칙은 spawn-worker/spawn-verifier와 동일(slugof: 소문자 + 비영숫자→'-' + trailing '-' 제거).
const slug = issueId.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-*$/, '');
const branch = `${cfg.branchPrefix || `loop-${loopId}`}/${slug}`;
const gh = process.env.GH_BIN || 'gh';
// 대상 레포는 cwd로 정한다(gh 규약). 브랜치명으로 PR을 지목 — 워커가 연 PR이 없으면 여기서 실패한다.
const r = spawnSync(gh, ['pr', 'view', branch, '--json', 'comments,url,headRefName'], { cwd: cfg.repo, encoding: 'utf8' });
if (r.status !== 0 || !r.stdout) {
  console.error(`preview-url: ${branch} 의 PR을 못 찾았다 (repo=${cfg.repo})\n${`${r.stderr || ''}`.trim().slice(-500)}`);
  process.exit(1);
}
const pr = JSON.parse(r.stdout);

const re = new RegExp(m.previewUrlRegex, 'g');
const hits = [];
for (const c of pr.comments || []) for (const hit of `${c.body || ''}`.match(re) || []) if (!hits.includes(hit)) hits.push(hit);
if (hits.length === 0) {
  console.error(`preview-url: PR ${pr.url} 코멘트에서 preview URL(${m.previewUrlRegex})을 못 찾았다 — 배포 대기 중이거나 규칙이 바뀌었다`);
  process.exit(1);
}
// 여러 개면 브랜치명이 들어간 것을 우선(같은 코멘트에 base/prod 링크가 섞여 나오는 배포 봇이 있다).
const branchToken = branch.replace(/\//g, '-');
process.stdout.write(`${hits.find((h) => h.includes(branchToken)) || hits[0]}\n`);
