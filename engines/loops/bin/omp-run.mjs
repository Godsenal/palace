#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

const BIN = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.LOOPS_HOME || dirname(BIN);
const [mode = 'run', role = 'orchestrator', model = ''] = process.argv.slice(2);
const command = String(process.env.OMP_COMMAND || process.env.OMP_BIN || 'omp').trim();
const timeoutSec = Math.max(1, Number(process.env.OMP_TIMEOUT_SEC || 1800));
const startedAt = Date.now();

function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
function commandLine(args) { return `${command} ${args.map(shellQuote).join(' ')}`; }
function classify(message, code) {
  const text = String(message || '');
  if (/not logged in|login required|unauthenticated|invalid api key|api key.*missing|credit|quota|usage limit|billing/i.test(text)) return 'account';
  if (code === 124 || /timed? out|timeout|temporar|connection|socket|network|429|rate.?limit|overload|\b5\d\d\b|econnreset|eai_again/i.test(text)) return 'transient';
  return 'fatal';
}
function asRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function numberAt(object, keys) {
  for (const key of keys) { const value = key.split('.').reduce((row, part) => asRecord(row)[part], object); if (Number.isFinite(value)) return Number(value); }
  return null;
}
function usageFrom(stats) {
  const row = asRecord(stats);
  return {
    usd: numberAt(row, ['cost', 'totalCost', 'totalCostUsd', 'usage.cost', 'usage.usd']),
    durationMs: Date.now() - startedAt,
    turns: numberAt(row, ['turns', 'turnCount', 'assistantMessages', 'usage.turns']),
    tokens: {
      in: numberAt(row, ['inputTokens', 'tokens.input', 'usage.inputTokens', 'usage.input']) || 0,
      out: numberAt(row, ['outputTokens', 'tokens.output', 'usage.outputTokens', 'usage.output']) || 0,
      cacheRead: numberAt(row, ['cacheReadTokens', 'tokens.cacheRead', 'usage.cacheReadTokens']) || 0,
      cacheWrite: numberAt(row, ['cacheWriteTokens', 'tokens.cacheWrite', 'usage.cacheWriteTokens']) || 0
    }
  };
}
async function readStdin() { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); }

const prompt = await readStdin();
if (!prompt.trim()) { console.error('omp-run: prompt가 비어 있습니다'); process.exit(2); }
const common = [];
if (process.env.LOOPS_OMP_CONFIG) common.push('--config', process.env.LOOPS_OMP_CONFIG);
// Git worktrees do not carry untracked, installed project skills. Preserve the
// same workspace + source-repository lookup used by Palace interactive sessions.
const projectSkillDirectories = [join(process.cwd(), '.agent', 'skills')];
const commonGit = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: process.cwd(), encoding: 'utf8' });
if (commonGit.status === 0 && basename(commonGit.stdout.trim()) === '.git') projectSkillDirectories.push(join(dirname(resolve(commonGit.stdout.trim())), '.agent', 'skills'));
const existingProjectSkills = [...new Set(projectSkillDirectories)].filter(existsSync);
if (existingProjectSkills.length) {
  const config = process.env.LOOPS_OMP_CONFIG ? JSON.parse(readFileSync(process.env.LOOPS_OMP_CONFIG, 'utf8')) : {};
  const configured = Array.isArray(config.skills?.customDirectories) ? config.skills.customDirectories : [];
  const runtimeRoot = join(ROOT, 'state', 'omp');
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const runtime = mkdtempSync(join(runtimeRoot, 'run-'));
  process.once('exit', () => rmSync(runtime, { recursive: true, force: true }));
  const configPath = join(runtime, 'config.json');
  writeFileSync(configPath, JSON.stringify({ skills: { customDirectories: [...new Set([...configured, ...existingProjectSkills])] } }), { mode: 0o600 });
  common.push('--config', configPath);
}
if (process.env.LOOPS_OMP_INSTRUCTIONS) common.push('--append-system-prompt', process.env.LOOPS_OMP_INSTRUCTIONS);
common.push('--trusted-extension', join(BIN, 'omp-policy.mjs'), '--yolo', '--no-title');
if (model.trim() && model.trim().toLowerCase() !== 'auto') common.push('--model', model.trim());

if (mode === 'live') {
  const args = [...common, '--', prompt];
  // Use the actual PTY device: Bun can leave input queued on macOS's /dev/tty alias.
  const terminal = spawnSync('/usr/bin/tty', [], { encoding: 'utf8', stdio: [process.stdout.fd, 'pipe', 'pipe'] });
  if (terminal.status !== 0) throw new Error('live OMP에는 연결된 터미널이 필요합니다.');
  const tty = openSync(terminal.stdout.trim(), 'r+');
  const child = spawn('/bin/zsh', ['-lc', `exec ${commandLine(args)}`], {
    cwd: process.cwd(), stdio: [tty, 'inherit', 'inherit'], env: { ...process.env, LOOPS_OMP_ROLE: role, LOOPS_HOME: ROOT }
  });
  closeSync(tty);
  child.on('error', (error) => { console.error(`OMP 시작 실패: ${error.message}`); process.exitCode = 1; });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
} else if (mode === 'run') {
  const args = ['--mode', 'rpc', ...common, '--max-time', `${timeoutSec}s`];
  const child = spawn('/bin/zsh', ['-lc', `exec ${commandLine(args)}`], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOOPS_OMP_ROLE: role, LOOPS_HOME: ROOT }
  });
  let stdout = '', stderr = '', result = '', summary = '', sessionFile = '', stats = {}, ready = false, done = false, acknowledged = false, sequence = 0;
  let statsId = '', stateId = '', summaryId = '', metadataResponses = 0, resolveMetadata;
  let resolveDone, rejectDone;
  const completed = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const metadata = new Promise((resolve) => { resolveMetadata = resolve; });
  const send = (type, fields = {}) => { const id = `loops-${++sequence}`; child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`); return id; };
  const finishIfReady = () => { if (done && acknowledged) resolveDone(); };
  const fail = (error) => { rejectDone(error instanceof Error ? error : new Error(String(error))); done = true; };
  child.stderr.on('data', (data) => { stderr = `${stderr}${data}`.slice(-65536); });
  child.stdout.on('data', (data) => {
    stdout += data.toString('utf8');
    const lines = stdout.split('\n'); stdout = lines.pop() || '';
    try {
      for (const line of lines) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.type === 'ready' && !ready) {
          ready = true;
          child.stdin.write(`${JSON.stringify({ id: 'loops-prompt', type: 'prompt', message: prompt })}\n`);
        } else if (frame.type === 'response' && frame.id === 'loops-prompt') {
          if (!frame.success) throw new Error(frame.error || 'OMP 프롬프트가 거부되었습니다');
          if (frame.data?.agentInvoked === false) throw new Error('OMP가 에이전트 턴을 시작하지 않았습니다');
          acknowledged = true; finishIfReady();
        } else if (frame.type === 'response' && frame.id === statsId) {
          stats = frame.data || {}; if (++metadataResponses >= 3) resolveMetadata();
        } else if (frame.type === 'response' && frame.id === stateId) {
          sessionFile = frame.data?.sessionFile || ''; if (++metadataResponses >= 3) resolveMetadata();
        } else if (frame.type === 'response' && frame.id === summaryId) {
          const data = frame.data;
          summary = typeof data === 'string' ? data : String(data?.text || data?.message || data?.content || '');
          if (++metadataResponses >= 3) resolveMetadata();
        } else if (frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta') {
          result += String(frame.assistantMessageEvent.delta || '');
        } else if (frame.type === 'message_end' && ['error', 'aborted'].includes(frame.message?.stopReason)) {
          throw new Error(frame.message.errorMessage || `OMP ${frame.message.stopReason}`);
        } else if (frame.type === 'agent_end' && frame.isTerminal !== false) {
          done = true; finishIfReady();
        } else if (frame.type === 'extension_ui_request' && frame.id) {
          child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: frame.id, cancelled: true })}\n`);
        } else if (frame.type === 'extension_error') throw new Error(frame.error || 'OMP 정책 확장 오류');
        else if (frame.type === 'host_tool_call' && frame.id) child.stdin.write(`${JSON.stringify({ type: 'host_tool_result', id: frame.id, isError: true, result: { content: [{ type: 'text', text: '엔진은 host tool을 제공하지 않습니다.' }] } })}\n`);
      }
    } catch (error) { fail(error); }
  });
  child.on('error', (error) => fail(new Error(`OMP 시작 실패: ${error.message}`)));
  child.on('exit', (code) => { if (!done || !acknowledged) fail(new Error(`OMP가 완료 전에 종료되었습니다 (code ${code ?? 'signal'}) ${stderr}`.trim())); });
  const timer = setTimeout(() => { try { send('abort'); } catch {} child.kill('SIGTERM'); fail(Object.assign(new Error(`OMP 실행 제한 시간 ${timeoutSec}초 초과`), { code: 124 })); }, timeoutSec * 1000);
  try {
    await completed;
    statsId = send('get_session_stats');
    stateId = send('get_state');
    summaryId = send('get_last_assistant_text');
    await Promise.race([metadata, new Promise((resolve) => setTimeout(resolve, 1000))]);
    clearTimeout(timer); child.stdin.end();
    process.stdout.write(JSON.stringify({ version: 1, ok: true, role, result: (summary || result).trim(), usage: usageFrom(stats), sessionFile }));
  } catch (error) {
    clearTimeout(timer); try { child.stdin.end(); } catch {}
    const code = Number(error?.code) || 1;
    const message = `${error?.message || error}${stderr ? `\n${stderr.trim()}` : ''}`.trim();
    process.stdout.write(JSON.stringify({ version: 1, ok: false, role, result: '', error: message, errorClass: classify(message, code), usage: usageFrom(stats), sessionFile }));
    process.exitCode = code === 124 ? 124 : 1;
  }
} else {
  console.error('usage: omp-run.mjs run|live <role> [model]'); process.exit(2);
}
