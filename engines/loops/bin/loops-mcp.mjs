#!/usr/bin/env node
// Loops 제어 MCP 서버 (stdio, JSON-RPC 2.0). 의존성 0 (Node 내장 http만).
// 선택형 stdio 게이트웨이가 OMP에 이 서버의 안전 툴만 노출할 때 멀티스텝으로 Loops를 조작한다.
// 대시보드 서버(127.0.0.1:PORT)의 /api/status·/api/session·/api/control 을 얇게 중계할 뿐 —
// cmux·git·gh 는 만지지 않는다. 노출 툴은 안전 면(읽기 + 안전 쓰기)뿐:
//   · 파괴적(cancel-issue/cleanup-issue)·merge/deploy/force-push 는 툴 자체를 두지 않아 구조적으로 불가능.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadEnv } from './env-file.mjs';

const ROOT = process.env.LOOPS_HOME || dirname(dirname(fileURLToPath(import.meta.url)));
const ENV = loadEnv(ROOT);
const PORT = +(process.env.PALACE_LOOPS_PORT || ENV.LOOPS_PORT || process.env.LOOPS_PORT || 8422);

// ── 로컬 대시보드 HTTP (127.0.0.1 → basic-auth 자동 통과, notify-bot.api 와 동일) ──
function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, timeout: 30000, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('대시보드 응답 타임아웃(30s) — loopctl dashboard 확인')); });
    if (data) req.write(data); req.end();
  });
}
const getStatus = async () => { const r = await api('GET', '/api/status'); try { return JSON.parse(r.body); } catch { return null; } };
const ctrl = (action, params) => api('POST', '/api/control', { action, ...params });

// ── 툴 정의 (name → {description, inputSchema, run}) ──
// run(args) → 문자열(사람이 읽을 결과) 반환. 던지면 isError 로 감싸 반환.
const S = (props = {}, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const loopArg = { loop: { type: 'string', description: 'loop id (예: seo, loops-improve). get_status 로 실제 id 확인.' } };
const issueArg = { issue: { type: 'string', description: 'Linear 이슈 식별자 (예: ABC-123)' } };

const TOOLS = {
  get_status: {
    description: '모든 loop 와 이슈의 현재 상태(id·이름·state·attention·counts·디스패처)를 JSON 으로 반환. 어떤 loop/issue 를 다룰지 정하기 전에 항상 먼저 호출하라.',
    inputSchema: S(),
    run: async () => { const r = await api('GET', '/api/status'); return r.body; },
  },
  get_run_log: {
    description: '한 loop 오케스트레이터의 run.log 최근 300줄. 사이클 오류·왜 안 도는지 진단용.',
    inputSchema: S({ ...loopArg }, ['loop']),
    run: async (a) => { const r = await api('GET', `/api/session?loop=${encodeURIComponent(a.loop)}`); return r.body || '(로그 없음)'; },
  },
  get_worker_screen: {
    description: '진행 중 워커(cmux 탭)의 화면 최근 300줄. 워커가 뭘 하고 있는지·막혔는지 확인용. 탭이 없으면 그 사실을 알림.',
    inputSchema: S({ ...loopArg, ...issueArg }, ['loop', 'issue']),
    run: async (a) => {
      const st = await getStatus(); const l = (st?.loops || []).find(x => x.id === a.loop);
      const i = l && (l.issues || []).find(x => String(x.id).toUpperCase() === String(a.issue).toUpperCase());
      if (!i) return `${a.issue} 를 ${a.loop} 에서 못 찾음`;
      if (!i.workspace) return `${a.issue} 에 살아있는 워커 탭이 없음 (state=${i.state})`;
      const r = await api('GET', `/api/session?ref=${encodeURIComponent(i.workspace)}`); return r.body || '(화면 없음)';
    },
  },
  create_issue: {
    description: 'Linear 이슈를 loop 프로젝트 Backlog 에 생성. start:true 면 즉시 워커를 띄워 작업 시작(사용자가 "작업까지/바로 해줘"라고 할 때만). start 없으면 Backlog 에만 넣고 다음 사이클이 픽업. 이슈 식별자·URL 을 돌려줌.',
    inputSchema: S({ ...loopArg, title: { type: 'string', description: '이슈 제목(한 줄, 구체적으로)' }, description: { type: 'string', description: '이슈 본문(선택) — 무엇을·왜·어떻게' }, start: { type: 'boolean', description: 'true 면 생성 직후 워커 spawn (사용자가 명시적으로 작업 시작을 원할 때만)' } }, ['loop', 'title']),
    run: async (a) => { const r = await ctrl('create-issue', { loop: a.loop, title: a.title, description: a.description, start: !!a.start }); return r.body; },
  },
  run_now: { description: 'loop 오케스트레이터 1사이클 즉시 실행(새 작업 발굴·팬아웃).', inputSchema: S({ ...loopArg }, ['loop']), run: async (a) => (await ctrl('run-now', { loop: a.loop })).body },
  reconcile: { description: 'loop 의 머지/닫힌 PR 정리(머지→Done, 닫힘→Canceled). 빠름.', inputSchema: S({ ...loopArg }, ['loop']), run: async (a) => (await ctrl('reconcile', { loop: a.loop })).body },
  resolve_gate: {
    description: 'human-gate(사람 판단 필요) 이슈에 사람의 결정을 전달하고 워커를 시작. decision 은 워커에 줄 권위있는 지시문.',
    inputSchema: S({ ...loopArg, ...issueArg, decision: { type: 'string', description: '워커에게 줄 결정/지시 (예: "그대로 진행", "A안 대신 B안으로")' } }, ['loop', 'issue', 'decision']),
    run: async (a) => (await ctrl('resolve-gate', { loop: a.loop, issue: a.issue, decision: a.decision })).body,
  },
  loop_pause: { description: 'loop 일시정지(스케줄 발화 중단).', inputSchema: S({ ...loopArg }, ['loop']), run: async (a) => (await ctrl('loop-pause', { loop: a.loop })).body },
  loop_resume: { description: 'loop 재개.', inputSchema: S({ ...loopArg }, ['loop']), run: async (a) => (await ctrl('loop-resume', { loop: a.loop })).body },
  toggle_enabled: { description: 'loop enabled 토글(켜기/끄기).', inputSchema: S({ ...loopArg }, ['loop']), run: async (a) => (await ctrl('toggle-enabled', { loop: a.loop })).body },
  dispatcher: {
    description: '전역 디스패처 제어. action: start|stop|pause|resume.',
    inputSchema: S({ action: { type: 'string', enum: ['start', 'stop', 'pause', 'resume'] } }, ['action']),
    run: async (a) => { if (!['start', 'stop', 'pause', 'resume'].includes(a.action)) throw new Error('action 은 start|stop|pause|resume'); return (await ctrl(a.action, {})).body; },
  },
  awake: {
    description: '잠자기 방지 토글. state: on|off.',
    inputSchema: S({ state: { type: 'string', enum: ['on', 'off'] } }, ['state']),
    run: async (a) => (await ctrl(a.state === 'on' ? 'awake-on' : 'awake-off', {})).body,
  },
};

// ── JSON-RPC over stdio (newline-delimited) ──
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { write({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'loops', version: '1.0.0' } });
  }
  if (method === 'tools/list') {
    return reply(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const t = TOOLS[params?.name];
    if (!t) return reply(id, { content: [{ type: 'text', text: `알 수 없는 툴: ${params?.name}` }], isError: true });
    try { const out = await t.run(params.arguments || {}); return reply(id, { content: [{ type: 'text', text: String(out ?? '') }] }); }
    catch (e) { return reply(id, { content: [{ type: 'text', text: '오류: ' + (e?.message || e) }], isError: true }); }
  }
  if (method === 'ping') return reply(id, {});
  if (id !== undefined) return replyErr(id, -32601, 'method not found: ' + method);
  // id 없는 알림(notifications/initialized 등)은 응답하지 않음
}

// stdin 이 닫혀도 진행 중인 tools/call(비동기 HTTP)이 끝날 때까지 종료를 미룬다 — 안 그러면 응답을 흘린다.
let buf = '', inflight = 0, stdinEnded = false;
const maybeExit = () => { if (stdinEnded && inflight === 0) process.exit(0); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    inflight++;
    Promise.resolve(handle(msg))
      .catch((e) => { if (msg && msg.id !== undefined) replyErr(msg.id, -32603, String(e?.message || e)); })
      .finally(() => { inflight--; maybeExit(); });
  }
});
process.stdin.on('end', () => { stdinEnded = true; maybeExit(); });
