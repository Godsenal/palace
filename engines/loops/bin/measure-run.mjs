#!/usr/bin/env node
// 루프 1회 실측 스윕 — config의 `measure` 블록대로 라우트를 돌며 브라우저·Lighthouse를 실행하고,
// **직전 스냅샷과 diff해서 결정론적 findings를 산출**한다. 이슈로 만들지는 않는다(그건 오케스트레이터 몫).
//
// 역할 분리(이 파일의 존재 이유): 무엇을 어떻게 쟀는지는 쉘이 고정하고, LLM은 findings를 읽고
// "이슈로 낼 가치가 있는가·중복인가"만 판단한다. LLM에게 측정을 맡기면 run마다 근거가 달라져 회귀 추적이 불가능하다.
//
// usage: measure-run.mjs <loop-id> [--base-url <url>] [--label <name>] [--no-lighthouse] [--print-only]
//   --base-url : config.measure.baseUrl override (PR preview A/B 검증에 사용)
//   --label    : 스냅샷 라벨(기본 "scheduled"). PR 검증은 --label pr-<ISSUE> 처럼 남겨 발굴 스냅샷과 섞이지 않게 한다.
//   --routes   : 측정할 라우트 id 부분집합(쉼표 구분). 미지정 시 전체.
//   --print-only : 스냅샷 파일을 쓰지 않는다(검증용 일회성 측정).
//
// PR A/B 검증 패턴 — 같은 label로 **기준선 → PR** 순서로 두 번 돌리면 두 번째 출력의 findings가 곧 "이 PR이 바꾼 것"이다:
//   measure-run.mjs <loop> --routes home --label pr-ABC-1 --base-url <develop preview>
//   measure-run.mjs <loop> --routes home --label pr-ABC-1 --base-url <PR preview>
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLoopConfig } from './loop-config.mjs';

const ROOT = process.env.LOOPS_HOME || dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const loopId = argv[0];
if (!loopId || loopId.startsWith('-')) {
  console.error('usage: measure-run.mjs <loop-id> [--base-url <url>] [--label <name>] [--no-lighthouse] [--print-only]');
  process.exit(2);
}
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const cfg = loadLoopConfig(ROOT, loopId);
const m = cfg.measure;
if (!m || !Array.isArray(m.routes) || m.routes.length === 0) {
  console.error(`measure-run: loops/${loopId}/config.json 에 measure.routes 가 없다 — 이 루프는 실측 대상이 아니다.`);
  process.exit(2);
}
// 라우트 부분집합 — PR 검증은 관련 화면만 재야 한다(전 라우트 A/B는 20~30분이라 무인 검증에 못 쓴다).
const routeFilter = flag('routes', '');
if (routeFilter) {
  const want = routeFilter.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = want.filter((w) => !m.routes.some((r) => r.id === w));
  if (unknown.length) { console.error(`measure-run: --routes 에 없는 id: ${unknown.join(', ')} (가능: ${m.routes.map((r) => r.id).join(', ')})`); process.exit(2); }
  m.routes = m.routes.filter((r) => want.includes(r.id));
}
const baseUrl = (flag('base-url', m.baseUrl) || '').replace(/\/$/, '');
if (!baseUrl) { console.error('measure-run: measure.baseUrl(또는 --base-url)이 비어 있다'); process.exit(2); }
const label = flag('label', 'scheduled');
const withLh = !has('no-lighthouse');
const stateDir = `${ROOT}/loops/${loopId}/state`;
const outDir = `${stateDir}/measure`;
const shotDir = `${outDir}/shots`;
mkdirSync(shotDir, { recursive: true });

// 로그인 파일은 루프 디렉터리 기준 상대경로 허용(loops/ 는 통째로 gitignore — 토큰이 레포에 들어가지 않는다).
const loginPath = m.login ? (isAbsolute(m.login) ? m.login : join(ROOT, 'loops', loopId, m.login)) : '';
if (loginPath && !existsSync(loginPath)) {
  console.error(`measure-run: login 파일이 없다 (${loginPath}) — 로그인 없이 재면 전 라우트가 "미렌더"로 잡혀 거짓 이슈가 쏟아진다. 중단.`);
  process.exit(1);
}

// ── 측정 직렬화 ──────────────────────────────────────────────
// 브라우저·Lighthouse를 동시에 여러 개 돌리면 서로의 CPU를 뺏어 타이밍이 무너지고 렌더 폴링이 타임아웃한다.
// 워커/검증자가 병렬로 도는 플랫폼이므로 전역 락으로 한 번에 하나만 재게 한다(레포 관례: mkdir lockdir).
// 락은 **라우트 단위**로 잡았다 푼다. 스윕 전체(8라우트 ≈ 25분)를 통째로 쥐면 그 사이 검증자의 PR A/B가
// 대기 한도를 넘겨 굶는다 — 스윕과 검증이 라우트 사이사이로 교대하되, 실제 측정은 항상 하나만 돈다.
const LOCK = '/tmp/loops-measure.lockdir';
const lockWaitSec = Number(m.lockWaitSec ?? 900);
let held = false;
const release = () => { if (held) { try { rmdirSync(LOCK) } catch {} held = false } };
const acquire = () => {
  for (let waited = 0; waited <= lockWaitSec; waited += 5) {
    try { mkdirSync(LOCK); held = true; return true } catch { spawnSync('sleep', ['5']) }
  }
  return false;
};
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130) });

const runNode = (script, args, timeoutSec) => {
  const r = spawnSync(process.execPath, [`${ROOT}/bin/${script}`, ...args], { encoding: 'utf8', timeout: timeoutSec * 1000 });
  if (r.status !== 0) return { error: `${script} 실패(exit ${r.status}): ${`${r.stderr || r.stdout || ''}`.trim().slice(-800)}` };
  try { return JSON.parse(r.stdout) } catch (e) { return { error: `${script} 출력 파싱 실패: ${e.message} / ${`${r.stdout}`.slice(0, 400)}` } };
};

const results = [];
for (const route of m.routes) {
  const url = `${baseUrl}${route.path}`;
  process.stderr.write(`▶ ${route.id} ${url}\n`);
  if (!acquire()) {
    console.error(`measure-run: 측정 락(${LOCK})을 ${lockWaitSec}s 안에 못 잡았다 (route=${route.id}) — 다른 측정이 진행 중. 중단(무음 통과 금지).`);
    process.exit(1);
  }
  const bArgs = [url, '--wait', String(m.waitSec ?? 40), '--min-root', String(route.minRoot ?? m.minRoot ?? 20000), // 태스크 스페이스는 **라우트마다** 분리한다 — 하나를 공유하면 직전 라우트의 SPA 스택/스토리지 상태를
// 물려받아 앱이 홈으로 되돌아가고(실측: search-region·faq가 둘 다 홈을 측정), 서로의 결과를 오염시킨다.
'--space', `loops-${loopId}-${route.id}`];
  if (loginPath) bArgs.push('--login', loginPath);
  if (m.viewport) bArgs.push('--viewport', m.viewport);
  if (route.selector) bArgs.push('--selector', route.selector);
  bArgs.push('--screenshot', `${shotDir}/${route.id}.png`);
  const browser = runNode('measure-browser.mjs', bArgs, (m.waitSec ?? 40) + 120);

  let lighthouse = null;
  if (withLh && route.lighthouse !== false) {
    lighthouse = runNode('measure-lighthouse.mjs', [
      url, '--runs', String(m.lighthouse?.runs ?? 1), '--preset', String(m.lighthouse?.preset ?? 'mobile'),
    ], 400);
  }
  release();
  results.push({ route: route.id, path: route.path, url, browser, lighthouse });
}

// ── diff: 직전 같은 label 스냅샷과 비교해 결정론적 findings 산출 ──────────
const prevFile = `${outDir}/latest-${label}.json`;
const prev = existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, 'utf8')) : null;
const prevOf = (id) => prev?.results?.find((r) => r.route === id) || null;
const pct = (now, before) => (before ? ((now - before) / before) * 100 : null);
const th = { bytesPct: m.thresholds?.bytesPct ?? 5, requests: m.thresholds?.requests ?? 10, ...(m.thresholds || {}) };

const findings = [];
const add = (severity, type, route, summary, evidence) => findings.push({ severity, type, route, summary, evidence });

for (const r of results) {
  const p = prevOf(r.route);
  if (r.browser.error) { add('blocker', 'measure-failed', r.route, `브라우저 측정 실패`, r.browser.error); continue }

  if (!r.browser.rendered) {
    add('blocker', 'not-rendered', r.route,
      `${r.browser.readyTimeoutSec}초 안에 렌더되지 않음 (root ${r.browser.page.rootLen}자 < 기준 ${r.browser.minRoot})`,
      `화면 텍스트: "${r.browser.page.text.slice(0, 120)}" / 요청 ${r.browser.requests}건 · HTTP에러 ${r.browser.httpErrors.length} · API에러 ${r.browser.apiErrors.length} · JS에러 ${r.browser.jsErrors.length} / 스크린샷 ${shotDir}/${r.route}.png`);
  }
  for (const h of r.browser.httpErrors) add(h.status >= 500 ? 'high' : 'medium', 'http-error', r.route, `HTTP ${h.status} — ${h.url}`, `type=${h.type}`);
  for (const a of r.browser.apiErrors) add('high', 'api-error', r.route, `API 응답에 errors[] — ${a.url}`, a.messages.join(' | '));
  for (const e of r.browser.jsErrors) add('high', 'js-error', r.route, `JS 예외 — ${e}`, `URL ${r.url}`);
  // console.error 는 개발용 경고가 섞이므로 새로 생긴 것만 올린다(기존 소음으로 이슈를 만들지 않는다).
  const prevCons = new Set(p?.browser?.consoleErrors || []);
  for (const c of r.browser.consoleErrors) if (!prevCons.has(c)) add('medium', 'console-error', r.route, `새 console.error — ${c}`, `URL ${r.url}`);

  const lh = r.lighthouse;
  if (lh?.error) { add('medium', 'measure-failed', r.route, 'Lighthouse 측정 실패', lh.error); continue }
  if (!lh) continue;
  const plh = p?.lighthouse && !p.lighthouse.error ? p.lighthouse : null;

  for (const f of lh.stable.failedAudits) {
    const was = plh?.stable.failedAudits.find((x) => x.id === f.id);
    const isNew = plh && !was;
    add(isNew ? 'high' : 'low', isNew ? 'audit-regression' : 'audit-failing', r.route,
      `[${f.category}] ${f.id} — ${f.title}${f.displayValue ? ` (${f.displayValue})` : ''}${isNew ? ' ← 직전 스냅샷엔 없던 신규' : ''}`,
      `score=${f.score}${f.savingsBytes ? ` · 절감가능 ${Math.round(f.savingsBytes / 1024)}KB` : ''}${f.itemCount ? ` · 대상 ${f.itemCount}건` : ''}${f.sample.length ? `\n  ${f.sample.join('\n  ')}` : ''}`);
  }
  if (plh) {
    const dBytes = pct(lh.stable.totalBytes, plh.stable.totalBytes);
    if (dBytes != null && dBytes > th.bytesPct) {
      add('high', 'bytes-regression', r.route, `전송 바이트 ${dBytes.toFixed(1)}% 증가`,
        `${Math.round(plh.stable.totalBytes / 1024)}KB → ${Math.round(lh.stable.totalBytes / 1024)}KB (임계 ${th.bytesPct}%)`);
    }
    const dReq = lh.stable.requests - plh.stable.requests;
    if (dReq > th.requests) add('medium', 'requests-regression', r.route, `요청 수 +${dReq}건`, `${plh.stable.requests} → ${lh.stable.requests} (임계 +${th.requests})`);
    for (const [k, v] of Object.entries(lh.stable.scores)) {
      const before = plh.stable.scores[k];
      if (before != null && v != null && v < before) add('high', 'score-regression', r.route, `Lighthouse ${k} 점수 하락 ${before} → ${v}`, `preset=${lh.preset}`);
    }
  }
}

const snapshot = { loop: loopId, label, baseUrl, ts: Math.floor(Date.now() / 1000), results, findings };
if (!has('print-only')) {
  writeFileSync(`${outDir}/${snapshot.ts}-${label}.json`, JSON.stringify(snapshot, null, 2));
  writeFileSync(prevFile, JSON.stringify(snapshot, null, 2));
  // 히스토리는 label별 최근 20개만 — 스냅샷 하나가 수백 KB라 무한 누적은 상태 디렉터리를 삼킨다.
  const olds = readdirSync(outDir).filter((f) => f.endsWith(`-${label}.json`) && f !== `latest-${label}.json`).sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - 20))) unlinkSync(`${outDir}/${f}`);
}

// ── LLM이 읽을 요약(stdout) ──────────────────────────────────
const bySev = (s) => findings.filter((f) => f.severity === s);
const lines = [];
lines.push(`# 실측 스윕 — ${loopId} / label=${label} / base=${baseUrl}`);
lines.push(`라우트 ${results.length}개 · findings ${findings.length}건 (blocker ${bySev('blocker').length} · high ${bySev('high').length} · medium ${bySev('medium').length} · low ${bySev('low').length})`);
lines.push(prev ? `직전 스냅샷: ${new Date(prev.ts * 1000).toISOString()} (회귀 판정은 이 스냅샷 대비)` : `직전 스냅샷 없음 — 이번이 기준선(회귀 판정 불가, audit-failing만 나온다)`);
lines.push('');
for (const r of results) {
  const b = r.browser;
  const head = b.error ? `측정실패` : `${b.rendered ? '렌더 OK' : '미렌더'} · ready ${b.readyMs ?? '—'}ms · 요청 ${b.requests} · HTTP에러 ${b.httpErrors.length} · API에러 ${b.apiErrors.length} · JS에러 ${b.jsErrors.length}`;
  const lhs = r.lighthouse && !r.lighthouse.error
    ? ` · LH a11y ${r.lighthouse.stable.scores.accessibility}/bp ${r.lighthouse.stable.scores.bestPractices}/seo ${r.lighthouse.stable.scores.seo} · ${Math.round(r.lighthouse.stable.totalBytes / 1024)}KB/${r.lighthouse.stable.requests}req`
    : r.lighthouse?.error ? ' · LH 측정실패' : '';
  lines.push(`- **${r.route}** (${r.path}): ${head}${lhs}`);
}
lines.push('');
lines.push('## findings');
for (const f of findings.sort((a, b) => ['blocker', 'high', 'medium', 'low'].indexOf(a.severity) - ['blocker', 'high', 'medium', 'low'].indexOf(b.severity))) {
  lines.push(`### [${f.severity}] ${f.type} · ${f.route}\n${f.summary}\n\`\`\`\n${f.evidence}\n\`\`\``);
}
if (!has('print-only')) lines.push(`\n스냅샷: ${outDir}/${snapshot.ts}-${label}.json · 스크린샷: ${shotDir}/`);
process.stdout.write(`${lines.join('\n')}\n`);
