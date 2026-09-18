#!/usr/bin/env node
// Loops — Telegram 원격 알림·제어 브리지. 의존성 0 (Node 내장 http/https).
// 밖(Telegram) ↔ 안(대시보드 127.0.0.1:PORT /api/status·/api/control)을 잇는 다리.
//   · 아웃바운드: /api/status 를 주기적으로 diff → human-gate/PR/CI/사이클오류를 폰으로 push
//   · 인바운드: getUpdates long-poll → 버튼 탭·답장·슬래시 명령 → /api/control
// cmux 소켓은 제어에 쓰지 않는다(HTTP만; 유일 예외 = boot 시 1회 `cmux identify`로 자기 탭 기록). 모든 제어는 서버가 대신 수행 → 엔진 변경 0.
// 안전 불변식: 봇은 merge/deploy/force-push 하지 않는다. 노출 파괴적 액션은 cancel/cleanup뿐이며 2탭 확인.
import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadEnv, setEnvVar } from './env-file.mjs';

const ROOT = process.env.LOOPS_HOME || dirname(dirname(fileURLToPath(import.meta.url)));

// 이중 기동 가드: getUpdates는 단일 소비자 전제(중복 인스턴스 = 409 Conflict + 중복 발송). 자기 자신과
// node --watch 워처(부모)는 제외. pgrep 자체가 실패하면 가드 없이 진행(가용성 우선 — 가드는 best-effort).
try {
  const others = execFileSync('/usr/bin/pgrep', ['-f', 'bin/notify-bot.mjs'], { encoding: 'utf8', timeout: 3000 })
    .split('\n').filter(x => x && +x !== process.pid && +x !== (process.ppid || -1));
  if (others.length) { console.error(`notify-bot: 이미 실행 중(pid ${others.join(',')}) — 중복 인스턴스 종료`); process.exit(0); }
} catch { /* pgrep 실패/무매치 — 가드 스킵하고 기동 */ }
const ENV = loadEnv(ROOT);
// 자기 탭 기록(state/panel.bot.ref) — supervisor panels sweep이 "진짜 봇 탭"을 식별해 🤖 잔재(cmux 재시작 복원 셸)를
// 회수하는 근거. identify 실패(비 cmux 컨텍스트·플레이크) → 파일 제거 + 로그 — sweep은 파일 없으면 🤖 정리 skip.
try {
  const cmuxBin = ENV.CMUX_BIN || process.env.CMUX_BIN || 'cmux';
  const j = JSON.parse(execFileSync(cmuxBin, ['identify'], { encoding: 'utf8', timeout: 4000 }));
  const ref = j && j.caller && j.caller.workspace_ref;
  if (!/^workspace:\d+$/.test(ref || '')) throw new Error('caller.workspace_ref 없음');
  writeFileSync(`${ROOT}/state/panel.bot.ref`, ref);
} catch (e) {
  try { execFileSync('/bin/rm', ['-f', `${ROOT}/state/panel.bot.ref`]); } catch {}
  console.error('panel.bot.ref 기록 실패(sweep은 🤖 정리 skip):', e.message);
}
const PORT = +(process.env.PALACE_LOOPS_PORT || ENV.LOOPS_PORT || process.env.LOOPS_PORT || 8422);
const TOKEN = ENV.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
let CHAT = ENV.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';   // 런타임 갱신(페어링) → loops.env 영속화
const NOTIFY_FILE = `${ROOT}/state/notify.json`;
const POLL_SEC = +(ENV.LOOPS_BOT_POLL_SEC || process.env.LOOPS_BOT_POLL_SEC || 45);
const OMP_COMMAND = process.env.OMP_COMMAND || process.env.OMP_BIN || ENV.OMP_COMMAND || ENV.OMP_BIN || 'omp';
const AGENT_MODEL = ENV.LOOPS_BOT_AGENT_MODEL || process.env.LOOPS_BOT_AGENT_MODEL || '';
const SAFE_ACTIONS = new Set(['create_issue', 'run_now', 'reconcile', 'resolve_gate', 'loop_pause', 'loop_resume', 'toggle_enabled', 'dispatcher', 'awake']);
const AGENT_SYSTEM = [
  '너는 Loops 자율 에이전트 플랫폼의 Telegram 자연어 controller다.',
  '제공된 실제 status와 log만 근거로 판단하고 id를 추측하지 않는다.',
  '출력은 JSON 한 줄: {\"reply\":\"사용자에게 보낼 짧은 한국어\",\"actions\":[{\"name\":\"...\",\"args\":{...}}]}.',
  '허용 name: create_issue(loop,title,description?,start?), run_now(loop), reconcile(loop), resolve_gate(loop,issue,decision), loop_pause(loop), loop_resume(loop), toggle_enabled(loop), dispatcher(action=start|stop|pause|resume), awake(state=on|off).',
  '추가만/등록만은 create_issue start=false, 바로 작업/시작은 start=true. 모호하면 actions=[]로 두고 reply에서 되묻는다.',
  'merge/deploy/force-push/cancel/cleanup은 금지이며 action도 없다.'
].join('\\n');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── notify.json: 이미 보낸 신호(seen) + 답장용 pending(msgId→{loop,issue}) 영속 ──
function loadNotify() { return readJSON(NOTIFY_FILE) || { seen: {}, pending: {} }; }
function saveNotify(n) { try { writeFileSync(NOTIFY_FILE, JSON.stringify(n, null, 2)); } catch (e) { log('notify.json 저장 실패:', e.message); } }
// 대시보드에서 볼 수 있게 주고받은 로그를 state/bot-log.jsonl 에 append (최근 200줄 유지). dir: 'in'=사용자→봇, 'out'=봇→사용자.
const BOTLOG_FILE = `${ROOT}/state/bot-log.jsonl`;
function botlog(dir, text) {
  try {
    let lines = []; try { lines = readFileSync(BOTLOG_FILE, 'utf8').split('\n').filter(Boolean); } catch {}
    lines.push(JSON.stringify({ ts: Math.floor(Date.now() / 1000), dir, text: String(text).slice(0, 300) }));
    if (lines.length > 200) lines = lines.slice(-200);
    writeFileSync(BOTLOG_FILE, lines.join('\n') + '\n');
  } catch (e) { log('bot-log 저장 실패:', e.message); }
}

// ── Telegram Bot API (node:https, zero-dep) ──
function tg(method, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = https.request(`https://api.telegram.org/bot${TOKEN}/${method}`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 40000 },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve(j); }); });
    req.on('error', (e) => { log('tg', method, 'err:', e.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data); req.end();
  });
}
const send = (text, keyboard) => tg('sendMessage', { chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
const answerCb = (id, text) => tg('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
const editMarkup = (mid, keyboard) => tg('editMessageReplyMarkup', { chat_id: CHAT, message_id: mid, reply_markup: { inline_keyboard: keyboard } });
const editText = (mid, text, keyboard) => tg('editMessageText', { chat_id: CHAT, message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });

// ── 로컬 대시보드 HTTP (127.0.0.1 → basic-auth 자동 통과) ──
function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, timeout: 15000, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data); req.end();
  });
}
const getStatus = () => api('GET', '/api/status');
const ctrl = (action, params) => api('POST', '/api/control', { action, ...params });

// ── 신호 → 사람이 읽을 문구/이모지 ──
const ATT = {
  'human-gate': { emoji: '🔴', label: '사람 판단 필요' },
  'merge-ready': { emoji: '🟢', label: '리뷰 승인 · 머지 준비 (GitHub에서 머지)' },
  'ci-failed': { emoji: '❌', label: 'CI 실패' },
  'changes': { emoji: '✍️', label: '변경 요청됨' },
  'pr-closed': { emoji: '🚪', label: 'PR 닫힘 (정리 대상)' },
  'stuck': { emoji: '🧟', label: '워커 멈춤 — 자가복구 실패 (재시도/버리기 필요)' },
  'rework-exhausted': { emoji: '🔁', label: '리뷰 재작업 상한 도달 — 자동 반영 중단, 사람 확인 필요' },
};
const STATE_EMOJI = { 'In Progress': '🔨', 'In Review': '👀', 'Backlog': '📋', 'Done': '✅', 'Canceled': '🚫' };

// 한 (loop,issue,attention) → 알림 메시지 {text, keyboard}
function messageFor(loop, issue, att) {
  const head = `${loop.emoji} <b>${esc(loop.name)}</b>`;
  const line = `${ATT[att].emoji} <b>${esc(issue.id)}</b> ${esc(issue.title)}`;
  const kb = [];
  if (att === 'human-gate') {
    const ask = issue.gate && issue.gate.ask ? `\n⚖️ ${esc(issue.gate.ask)}` : '';
    // 제안 검증자(validator) 판정 병기 — validate 켜진 제안형 루프만 존재. 게이트 결정을 30초로 만드는 독립 의견.
    const V_EMOJI = { strengthen: '🟢 강화', narrow: '🟡 축소 권고', reject: '🔴 기각 권고' };
    const v = issue.validate ? `\n🧪 ${V_EMOJI[issue.validate.verdict] || esc(issue.validate.verdict)} — ${esc(issue.validate.askNote || issue.validate.summary || '')}${issue.validate.alternative && issue.validate.alternative !== '없음' ? `\n   ↳ 축소안: ${esc(issue.validate.alternative)}` : ''}` : '';
    kb.push([{ text: '✅ 그대로 진행', callback_data: `ok|${loop.id}|${issue.id}` }, { text: '🗑 취소', callback_data: `cxl|${loop.id}|${issue.id}` }]);
    if (issue.url) kb.push([{ text: '🔗 이슈', url: issue.url }]);
    return { text: `${head}\n${line}${ask}${v}\n\n💬 이 메시지에 <b>답장</b>으로 결정을 적어 보내면 그대로 워커에 전달됩니다.`, keyboard: kb };
  }
  if (att === 'pr-closed') kb.push([{ text: '🧹 정리', callback_data: `cln|${loop.id}|${issue.id}` }]);
  if (att === 'stuck') kb.push([{ text: '↻ 재시도', callback_data: `heal|${loop.id}|${issue.id}` }, { text: '🗑 버리기', callback_data: `cxl|${loop.id}|${issue.id}` }]);
  if (issue.pr) kb.push([{ text: '🔗 PR 열기', url: issue.pr }]);
  else if (issue.url) kb.push([{ text: '🔗 이슈', url: issue.url }]);
  return { text: `${head}\n${line}\n${ATT[att].emoji} ${ATT[att].label}`, keyboard: kb.length ? kb : null };
}

// ── 아웃바운드: /api/status diff → 새 신호만 push ──
let seeded = existsSync(NOTIFY_FILE);   // notify.json 이미 있으면 diff, 없으면 첫 폴링은 조용히 시드(과거분 폭탄 방지)
async function pollStatus() {
  if (!CHAT) return;   // 페어링 전엔 diff/시드 안 함 — 안 그러면 미전송 신호를 seen 처리해 페어링 후 놓친다
  let st; try { st = await getStatus(); } catch (e) { log('대시보드 미응답(스킵):', e.message); return; }
  if (!st || !Array.isArray(st.loops)) return;
  const n = loadNotify();
  const cur = {};   // 이번에 살아있는 신호 키 집합
  const fresh = [];
  for (const loop of st.loops) {
    for (const issue of (loop.issues || [])) {
      if (!issue.attention || !ATT[issue.attention]) continue;
      const key = `${loop.id}|${issue.id}|${issue.attention}`;
      cur[key] = true;
      if (!n.seen[key]) fresh.push({ loop, issue, att: issue.attention, key });
    }
    if (loop.lastRun && loop.lastRun.exit && loop.lastRun.exit !== 0) {
      const key = `${loop.id}||run-error@${loop.lastRun.ts || 0}`;
      cur[key] = true;
      if (!n.seen[key]) fresh.push({ loop, att: 'run-error', key });
    }
    // 일일 예산 소프트 캡 도달 — exceeded가 유지되는 동안 키가 살아있어 하루 1회만 알림, 자정 리셋 후 재발 시 다시 알림.
    if (loop.economics && loop.economics.budgetExceeded) {
      const key = `${loop.id}||budget`;
      cur[key] = true;
      if (!n.seen[key]) fresh.push({ loop, att: 'budget', key });
    }
    // 인프라 wedge로 사이클이 반복 실패 중 (snapshot blocked.streak) — 이유가 바뀌면 새 알림.
    if (loop.blocked && loop.blocked.reason) {
      const key = `${loop.id}||blocked@${loop.blocked.reason}`;
      cur[key] = true;
      if (!n.seen[key]) fresh.push({ loop, att: 'blocked', key });
    }
    // retro가 learnings.md를 갱신함 (mtime 변화) — 사람이 뭘 학습했는지 항상 볼 수 있어야 한다(comprehension debt 방지).
    if (loop.learningsTs) {
      const key = `${loop.id}||learnings@${loop.learningsTs}`;
      cur[key] = true;
      if (!n.seen[key]) fresh.push({ loop, att: 'learnings', key });
    }
  }
  n.seen = cur;   // 사라진 신호는 seen에서 제거 → 재발생 시 다시 알림
  if (!seeded) { seeded = true; saveNotify(n); log(`시드 완료 — 현재 신호 ${Object.keys(cur).length}개는 알림 없이 봄 처리`); return; }
  for (const f of fresh) {
    if (f.att === 'run-error') { await send(`${f.loop.emoji} <b>${esc(f.loop.name)}</b>\n⚠️ 오케스트레이터 사이클 오류 (exit ${f.loop.lastRun.exit}) — 대시보드에서 run.log 확인`); botlog('out', `⚠️ ${f.loop.id} 사이클오류 exit ${f.loop.lastRun.exit}`); continue; }
    if (f.att === 'budget') { const ec = f.loop.economics; await send(`${f.loop.emoji} <b>${esc(f.loop.name)}</b>\n💰 일일 예산 초과 ($${ec.todayUsd}/$${ec.budgetDailyUsd}) — 오늘 남은 사이클 자동 skip, 자정 재개`); botlog('out', `💰 ${f.loop.id} 예산 초과`); continue; }
    if (f.att === 'blocked') { await send(`${f.loop.emoji} <b>${esc(f.loop.name)}</b>\n⛔ 사이클 막힘${f.loop.blocked.streak ? ` ×${f.loop.blocked.streak}` : ''} — ${esc(f.loop.blocked.reason)}`); botlog('out', `⛔ ${f.loop.id} 사이클 막힘`); continue; }
    if (f.att === 'learnings') { await send(`${f.loop.emoji} <b>${esc(f.loop.name)}</b>\n🧠 learnings 갱신됨 — 대시보드 ⚙️ 설정에서 내용을 확인하세요 (다음 run부터 프롬프트에 주입)`); botlog('out', `🧠 ${f.loop.id} learnings 갱신`); continue; }
    const m = messageFor(f.loop, f.issue, f.att);
    botlog('out', `🔔 ${ATT[f.att].emoji} ${f.issue.id} ${f.att} (${f.loop.id})`);
    const r = await send(m.text, m.keyboard);
    const mid = r && r.ok && r.result && r.result.message_id;
    if (mid && f.att === 'human-gate') { n.pending[mid] = { loop: f.loop.id, issue: f.issue.id }; }
  }
  // pending 맵이 너무 커지지 않게 최근 50개만 유지
  const keys = Object.keys(n.pending); if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete n.pending[k];
  saveNotify(n);
  if (fresh.length) log(`알림 ${fresh.length}건 발송`);
}

// ── 인터랙티브 메뉴: 탭만으로 전 loop·태스크·제어 ──
// 루트: 디스패처/awake 전역 제어 + 루프 목록 버튼
async function menuView() {
  const st = await getStatus().catch(() => null);
  if (!st) return { text: '⚠️ 대시보드 미응답 — loopctl dashboard 확인', keyboard: [[{ text: '🔄 다시', callback_data: 'menu' }]] };
  const d = st.dispatcher;
  const head = `🕹 <b>Loops 컨트롤</b>\n디스패처: ${d.running ? (d.paused ? '⏸ 일시정지' : '● 실행중') : '○ 정지'} · 잠자기방지 ${st.awake ? '☕ ON' : 'off'}`;
  const kb = [];
  kb.push(d.running ? [{ text: d.paused ? '▶ 재개' : '⏸ 일시정지', callback_data: d.paused ? 'g-resume' : 'g-pause' }, { text: '⏹ 중지', callback_data: 'g-stop' }] : [{ text: '▶ 디스패처 시작', callback_data: 'g-start' }]);
  kb.push([{ text: st.awake ? '☕ 잠자기방지 끄기' : '☕ 잠자기방지 켜기', callback_data: st.awake ? 'g-awakeoff' : 'g-awakeon' }]);
  for (const l of st.loops) { const a = l.issues.filter(i => i.attention).length; const ip = l.counts['In Progress'] + l.counts['In Review']; kb.push([{ text: `${l.emoji} ${l.name}${a ? ` 🔴${a}` : ''}${ip ? ` · ${ip}건` : ''}${l.paused ? ' ⏸' : (l.enabled ? '' : ' (off)')}`, callback_data: `L|${l.id}` }]); }
  kb.push([{ text: '🔄 새로고침', callback_data: 'menu' }]);
  return { text: head + '\n\n루프를 눌러 상세·제어 →', keyboard: kb };
}
// 루프 상세: counts + run-now/reconcile/pause/enable + 작업 보기
async function loopView(id) {
  const st = await getStatus().catch(() => null); const l = (st?.loops || []).find(x => x.id === id);
  if (!l) return { text: '루프 없음', keyboard: [[{ text: '◀ 메뉴', callback_data: 'menu' }]] };
  const c = l.counts;
  const text = `${l.emoji} <b>${esc(l.name)}</b> ${l.paused ? '⏸ 정지' : (l.enabled ? '' : '(off)')}\n📋 ${c.Backlog} · 🔨 ${c['In Progress']} · 👀 ${c['In Review']} · ✅ ${c.Done}${l.attentionCount ? `\n🔴 주의 ${l.attentionCount}건` : ''}`;
  const kb = [
    [{ text: '⚡ 실행', callback_data: `runnow|${id}` }, { text: '🧹 PR정리', callback_data: `recon|${id}` }],
    [{ text: l.paused ? '▶ 재개' : '⏸ 정지', callback_data: (l.paused ? 'lresume' : 'lpause') + '|' + id }, { text: l.enabled ? '🔀 끄기' : '🔀 켜기', callback_data: `enable|${id}` }],
    [{ text: '📋 작업 보기', callback_data: `T|${id}` }],
    [{ text: '◀ 메뉴', callback_data: 'menu' }],
  ];
  return { text, keyboard: kb };
}
// 작업 목록: 진행 중(In Progress/In Review) + 주의 이슈를 각각 액션 버튼과 함께 보냄
async function sendTasks(id) {
  const st = await getStatus().catch(() => null); const l = (st?.loops || []).find(x => x.id === id);
  if (!l) return send('루프 없음');
  const act = l.issues.filter(i => i.state === 'In Progress' || i.state === 'In Review' || i.attention);
  if (!act.length) return send(`${l.emoji} ${esc(l.name)} — 진행 중 작업 없음`);
  await send(`${l.emoji} <b>${esc(l.name)}</b> — 진행 중 ${act.length}건`);
  const n = loadNotify();
  for (const i of act) {
    const em = STATE_EMOJI[i.state] || '•';
    const kb = [];
    if (i.attention === 'human-gate') kb.push([{ text: '✅ 진행', callback_data: `ok|${id}|${i.id}` }, { text: '🗑 취소', callback_data: `cxl|${id}|${i.id}` }]);
    else kb.push([{ text: '🗑 취소', callback_data: `cxl|${id}|${i.id}` }, { text: '🧹 정리', callback_data: `cln|${id}|${i.id}` }]);
    if (i.pr) kb.push([{ text: '🔗 PR', url: i.pr }]); else if (i.url) kb.push([{ text: '🔗 이슈', url: i.url }]);
    const att = i.attention ? `\n${ATT[i.attention]?.emoji || '⚠️'} ${ATT[i.attention]?.label || i.attention}${i.gate?.ask ? ' — ' + esc(i.gate.ask) : ''}` : '';
    const r = await send(`${em} <b>${esc(i.id)}</b> ${esc(i.title)}${att}`, kb);
    const mid = r && r.ok && r.result && r.result.message_id;
    if (mid && i.attention === 'human-gate') n.pending[mid] = { loop: id, issue: i.id };
  }
  saveNotify(n);
}

// ── issue id → 그 이슈가 속한 loop id 찾기 ──
async function loopOfIssue(issueId) {
  const st = await getStatus().catch(() => null);
  const want = String(issueId).toUpperCase();
  for (const loop of (st?.loops || [])) for (const i of (loop.issues || [])) if (String(i.id).toUpperCase() === want) return { loopId: loop.id, issue: i };
  return null;
}

// ── 인바운드: 버튼 탭 ──
async function onCallback(cb) {
  const [act, loop, issue] = String(cb.data || '').split('|');
  const reply = (t) => answerCb(cb.id, t);
  const mid = cb.message && cb.message.message_id;
  // 내비게이션 (메시지를 그 자리에서 갱신)
  if (act === 'menu') { const v = await menuView(); await editText(mid, v.text, v.keyboard); return reply(); }
  if (act === 'L') { const v = await loopView(loop); await editText(mid, v.text, v.keyboard); return reply(); }
  if (act === 'T') { await reply(); return sendTasks(loop); }
  // 전역 디스패처·잠자기방지 → 실행 후 메뉴 갱신
  if (act[0] === 'g' && act[1] === '-') {
    const map = { 'g-start': 'start', 'g-pause': 'pause', 'g-resume': 'resume', 'g-stop': 'stop', 'g-awakeon': 'awake-on', 'g-awakeoff': 'awake-off' };
    const r = await ctrl(map[act], {}); await reply(r && r.ok ? '완료' : (r?.out || '실패'));
    const v = await menuView(); return editText(mid, v.text, v.keyboard);
  }
  // 루프 단위 액션 → 실행 후 루프 상세 갱신
  if (['runnow', 'recon', 'lpause', 'lresume', 'enable'].includes(act)) {
    const map = { runnow: 'run-now', recon: 'reconcile', lpause: 'loop-pause', lresume: 'loop-resume', enable: 'toggle-enabled' };
    const r = await ctrl(map[act], { loop }); await reply(r && r.ok ? '완료' : (r?.out || '실패'));
    const v = await loopView(loop); return editText(mid, v.text, v.keyboard);
  }
  if (act === 'nop') return reply('취소됨');
  if (act === 'ok') { const r = await ctrl('resolve-gate', { loop, issue, decision: '✅ 승인 — 이슈 계획대로 그대로 진행하라. (텔레그램에서 승인됨)' }); return reply(r && r.ok ? `${issue} 진행` : (r?.out || '실패')); }
  if (act === 'heal') { const r = await ctrl('heal-issue', { loop, issue }); return reply(r && r.ok ? `${issue} 재시도` : (r?.out || '실패')); }
  // 파괴적 액션: 1탭 → 확인 버튼으로 교체, 2탭(C) → 실행
  if (act === 'cxl') { await editMarkup(cb.message.message_id, [[{ text: '⚠️ 정말 취소?', callback_data: `cxlC|${loop}|${issue}` }, { text: '아니오', callback_data: 'nop' }]]); return reply(); }
  if (act === 'cln') { await editMarkup(cb.message.message_id, [[{ text: '⚠️ 정말 정리?', callback_data: `clnC|${loop}|${issue}` }, { text: '아니오', callback_data: 'nop' }]]); return reply(); }
  if (act === 'cxlC') { const r = await ctrl('cancel-issue', { loop, issue }); await editMarkup(cb.message.message_id, [[{ text: `🗑 ${issue} 취소됨`, callback_data: 'nop' }]]); return reply(r && r.ok ? '취소됨' : (r?.out || '실패')); }
  if (act === 'clnC') { const r = await ctrl('cleanup-issue', { loop, issue }); await editMarkup(cb.message.message_id, [[{ text: `🧹 ${issue} 정리됨`, callback_data: 'nop' }]]); return reply(r && r.ok ? '정리됨' : (r?.out || '실패')); }
  return reply('알 수 없는 동작');
}

// ── 자연어 채팅: OMP controller는 상태를 읽고 안전 action plan만 만든다. 실행은 이 프로세스가
// schema/id를 검증한 뒤 dashboard control API로 결정론적으로 수행한다. OMP에는 도구가 전혀 노출되지 않는다.
function runAgent(userText, status, evidence) {
  const prompt = `${AGENT_SYSTEM}

실제 status(JSON):
${JSON.stringify(status)}

관련 로그(없을 수 있음):
${evidence || '(없음)'}

사용자 요청:
${userText}`;
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [`${ROOT}/bin/omp-run.mjs`, 'run', 'controller', AGENT_MODEL], {
      cwd: ROOT, timeout: 150000, maxBuffer: 8 << 20,
      env: { ...process.env, LOOPS_HOME: ROOT, OMP_COMMAND, OMP_TIMEOUT_SEC: '140' }
    }, (err, stdout, stderr) => {
      if (err) log('OMP controller 실패:', err.message, (stderr || '').slice(0, 300));
      try {
        const run = JSON.parse(stdout || '{}');
        const text = String(run.result || '').trim().replace(/^```(?:json)?\\s*/i, '').replace(/\\s*```$/, '');
        const plan = JSON.parse(text);
        resolve(plan && typeof plan === 'object' ? plan : null);
      } catch { resolve(null); }
    });
    child.stdin?.end(prompt);
  });
}
function actualLoop(status, id) { return (status?.loops || []).find((loop) => loop.id === id); }
function actualIssue(loop, id) { return (loop?.issues || []).find((issue) => String(issue.id).toUpperCase() === String(id || '').toUpperCase()); }
async function executeSafeAction(action, status) {
  if (!action || !SAFE_ACTIONS.has(action.name) || !action.args || typeof action.args !== 'object') throw new Error('허용되지 않은 action');
  const a = action.args;
  if (!['dispatcher', 'awake'].includes(action.name) && !actualLoop(status, a.loop)) throw new Error(`실제 loop id가 아님: ${a.loop}`);
  if (action.name === 'resolve_gate' && !actualIssue(actualLoop(status, a.loop), a.issue)) throw new Error(`실제 issue id가 아님: ${a.issue}`);
  const map = { run_now: 'run-now', reconcile: 'reconcile', resolve_gate: 'resolve-gate', loop_pause: 'loop-pause', loop_resume: 'loop-resume', toggle_enabled: 'toggle-enabled', create_issue: 'create-issue' };
  if (action.name === 'dispatcher') {
    if (!['start', 'stop', 'pause', 'resume'].includes(a.action)) throw new Error('dispatcher action 오류');
    return ctrl(a.action, {});
  }
  if (action.name === 'awake') {
    if (!['on', 'off'].includes(a.state)) throw new Error('awake state 오류');
    return ctrl(`awake-${a.state}`, {});
  }
  return ctrl(map[action.name], a);
}
async function onNaturalLanguage(text) {
  tg('sendChatAction', { chat_id: CHAT, action: 'typing' });
  const interim = await send('🤖 처리 중…');
  const imid = interim && interim.ok && interim.result && interim.result.message_id;
  let status, evidence = '';
  try {
    status = await getStatus();
    const matched = (status?.loops || []).find((loop) => text.includes(loop.id) || (loop.name && text.includes(loop.name)));
    if (matched) evidence = String(await api('GET', `/api/session?loop=${encodeURIComponent(matched.id)}`) || '').slice(-12000);
  } catch (error) { log('controller 상태 조회 실패:', error.message); }
  const plan = status && await runAgent(text, status, evidence);
  const results = [];
  if (plan && Array.isArray(plan.actions)) {
    for (const action of plan.actions.slice(0, 8)) {
      try { results.push(await executeSafeAction(action, status)); }
      catch (error) { results.push({ ok: false, out: error.message }); }
    }
  }
  if (imid) tg('deleteMessage', { chat_id: CHAT, message_id: imid });
  if (!plan) { botlog('out', '(OMP controller 무응답)'); const v = await menuView(); return send('처리 중 문제가 있었어요. OMP 로그인과 대시보드를 확인하거나 탭으로 실행해주세요.', v.keyboard); }
  const failed = results.filter((row) => !row || row.ok === false).map((row) => row?.out || '실행 실패');
  const out = [String(plan.reply || '처리했습니다.'), failed.length ? `실패: ${failed.join(' · ')}` : ''].filter(Boolean).join('\\n');
  botlog('out', out.slice(0, 300));
  return send(esc(out));
}

// ── 인바운드: 슬래시 명령 ──
async function onCommand(text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case '/start': case '/menu': { const v = await menuView(); return send(v.text, v.keyboard); }
    case '/help':
      return send([
        '<b>Loops 원격 제어</b>',
        '/menu — 🕹 탭으로 전부 제어(루프·작업·디스패처)',
        '/status — 전 loop + 진행 중 작업 요약',
        '/gates — 열린 human-gate',
        '/resolve &lt;ISSUE&gt; &lt;결정&gt; · /cancel &lt;ISSUE&gt; · /cleanup &lt;ISSUE&gt;',
        '/runnow &lt;loop&gt; · /reconcile &lt;loop&gt; · /enable &lt;loop&gt;',
        '/pause &lt;loop&gt; · /resume &lt;loop&gt;',
        '/dispatcher &lt;start|stop|pause|resume&gt; · /awake &lt;on|off&gt;',
        '',
        '💬 <b>그냥 말로 하면 진짜 에이전트가 멀티스텝으로 처리합니다</b> — "지금 뭐 돌아가?", "seo에 \'OG태그 누락 점검\' 태스크 추가해", "그거 추가하고 바로 작업 시작해줘", "요즘 CI 왜 깨져? 원인 보고 고칠 태스크 만들어". 태스크 생성·작업 시작까지 알아서. 탭이 편하면 <b>/menu</b>. 게이트 알림엔 <b>답장</b>으로 결정.',
        '⚠️ 이슈 취소·정리(파괴적)는 에이전트가 직접 안 함 — /menu 버튼(2탭) 또는 /cancel 로.',
      ].join('\n'));
    case '/status': {
      const st = await getStatus().catch(() => null);
      if (!st) return send('⚠️ 대시보드 미응답 — loopctl dashboard 확인');
      const lines = [`🕹 dispatcher: ${st.dispatcher.running ? (st.dispatcher.paused ? '⏸ paused' : '● running') : '○ stopped'} · awake ${st.awake ? '☕' : 'off'}`];
      for (const l of st.loops) {
        const c = l.counts;
        lines.push(`\n${l.emoji} <b>${esc(l.name)}</b> ${l.paused ? '⏸' : (l.enabled ? '' : '(off)')}`);
        lines.push(`  📋 ${c.Backlog} · 🔨 ${c['In Progress']} · 👀 ${c['In Review']} · ✅ ${c.Done}`);
        // 진행 중(In Progress/In Review) + 주의 이슈를 실제로 나열
        for (const i of l.issues.filter(x => x.state === 'In Progress' || x.state === 'In Review' || x.attention))
          lines.push(`  ${STATE_EMOJI[i.state] || '•'} ${esc(i.id)} ${esc(i.title)}${i.attention ? ` ${ATT[i.attention]?.emoji || '⚠️'}` : ''}`);
      }
      lines.push('\n🕹 /menu 로 탭 제어');
      return send(lines.join('\n'));
    }
    case '/gates': {
      const st = await getStatus().catch(() => null);
      if (!st) return send('⚠️ 대시보드 미응답');
      let any = false;
      for (const l of st.loops) for (const i of l.issues) if (i.attention === 'human-gate') {
        any = true; const m = messageFor(l, i, 'human-gate'); const r = await send(m.text, m.keyboard);
        const mid = r && r.ok && r.result && r.result.message_id;
        if (mid) { const n = loadNotify(); n.pending[mid] = { loop: l.id, issue: i.id }; saveNotify(n); }
      }
      return any ? null : send('열린 human-gate 없음 ✅');
    }
    case '/resolve': {
      const [issue, ...d] = rest; const decision = d.join(' ').trim();
      if (!issue || !decision) return send('사용법: /resolve &lt;ISSUE&gt; &lt;결정 내용&gt;');
      const hit = await loopOfIssue(issue); if (!hit) return send(`${esc(issue)} 못 찾음`);
      const r = await ctrl('resolve-gate', { loop: hit.loopId, issue: hit.issue.id, decision });
      return send(r && r.ok ? `⚖️ ${hit.issue.id} 결정 전달 + 워커 시작` : `실패: ${esc(r?.out || '')}`);
    }
    case '/cancel': case '/cleanup': {
      if (!arg) return send(`사용법: ${cmd} &lt;ISSUE&gt;`);
      const hit = await loopOfIssue(arg); if (!hit) return send(`${esc(arg)} 못 찾음`);
      const action = cmd === '/cancel' ? 'cancel-issue' : 'cleanup-issue';
      const r = await ctrl(action, { loop: hit.loopId, issue: hit.issue.id });
      return send(r && r.ok ? `${cmd === '/cancel' ? '🗑' : '🧹'} ${hit.issue.id} 완료` : `실패: ${esc(r?.out || '')}`);
    }
    case '/runnow': case '/pause': case '/resume': case '/reconcile': case '/enable': {
      if (!arg) return send(`사용법: ${cmd} &lt;loop-id&gt;`);
      const action = { '/runnow': 'run-now', '/pause': 'loop-pause', '/resume': 'loop-resume', '/reconcile': 'reconcile', '/enable': 'toggle-enabled' }[cmd];
      const r = await ctrl(action, { loop: arg });
      return send(r && r.ok ? `${cmd} ${esc(arg)} ✅ ${esc(r.out || '')}` : `실패: ${esc(r?.out || '')}`);
    }
    case '/dispatcher': {
      const sub = (rest[0] || '').toLowerCase();
      if (!['start', 'stop', 'pause', 'resume'].includes(sub)) return send('사용법: /dispatcher &lt;start|stop|pause|resume&gt;');
      const r = await ctrl(sub, {});
      return send(r && r.ok ? `🕹 dispatcher ${sub} ✅` : `실패: ${esc(r?.out || '')}`);
    }
    case '/awake': {
      const sub = (rest[0] || '').toLowerCase();
      if (!['on', 'off'].includes(sub)) return send('사용법: /awake &lt;on|off&gt;');
      const r = await ctrl(sub === 'on' ? 'awake-on' : 'awake-off', {});
      return send(r && r.ok ? `☕ 잠자기방지 ${sub} ✅` : `실패: ${esc(r?.out || '')}`);
    }
    default: { const v = await menuView(); return send(v.text, v.keyboard); }
  }
}

// ── 인바운드: 게이트 알림에 대한 답장 → 그 이슈의 결정으로 ──
async function onReply(msg) {
  const mid = msg.reply_to_message.message_id;
  const n = loadNotify(); const p = n.pending[mid];
  if (!p) return send('이 메시지는 게이트 알림이 아니거나 오래돼 매핑이 없어요. /resolve &lt;ISSUE&gt; &lt;결정&gt; 을 쓰세요.');
  const r = await ctrl('resolve-gate', { loop: p.loop, issue: p.issue, decision: msg.text });
  return send(r && r.ok ? `⚖️ ${p.issue} 결정 전달 + 워커 시작` : `실패: ${esc(r?.out || '')}`);
}

// ── 인바운드 루프: getUpdates long-poll ──
let offset = 0;
async function pollUpdates() {
  const r = await tg('getUpdates', { timeout: 30, offset, allowed_updates: ['message', 'callback_query'] });
  if (!r || !r.ok) return;
  for (const u of r.result) {
    offset = u.update_id + 1;
    try { await handleUpdate(u); } catch (e) { log('update 처리 오류:', e.message); }
  }
}
async function handleUpdate(u) {
  const chatId = u.callback_query ? u.callback_query.message?.chat?.id : u.message?.chat?.id;
  // 페어링: chat-id 미설정이면 첫 메시지의 chat을 캡처·영속화
  if (!CHAT) {
    if (u.message && chatId != null) { CHAT = String(chatId); setEnvVar(ROOT, 'TELEGRAM_CHAT_ID', CHAT); log('페어링 완료 → chat', CHAT); await send('✅ 연결됨! 이제 이 대화로 알림이 오고, 여기서 전부 제어할 수 있어요.\n💬 그냥 말로 하세요 — 진짜 에이전트가 멀티스텝으로 처리해요: "지금 뭐 돌아가?", "seo에 태스크 추가하고 바로 작업 시작해". 탭이 편하면 🕹 /menu. (/help)'); }
    return;
  }
  // chat-id 잠금(인증): 등록된 chat 외의 요청은 무시
  if (String(chatId) !== String(CHAT)) { if (u.callback_query) answerCb(u.callback_query.id, '권한 없음'); return; }
  if (u.callback_query) { botlog('in', '👆 ' + u.callback_query.data); return onCallback(u.callback_query); }
  const msg = u.message; if (!msg || typeof msg.text !== 'string') return;
  botlog('in', (msg.reply_to_message ? '↩ ' : '') + msg.text);
  if (msg.reply_to_message) return onReply(msg);
  if (msg.text.startsWith('/')) return onCommand(msg.text);
  return onNaturalLanguage(msg.text);   // 그냥 말로 → OMP가 의도 파악해 실행 (게이트 알림엔 답장으로 결정)
}

async function updatesForever() { for (;;) { try { await pollUpdates(); } catch (e) { log('getUpdates 오류:', e.message); await new Promise(r => setTimeout(r, 3000)); } } }

// ── 부팅 ──
async function main() {
  if (!TOKEN) {
    console.error([
      '❌ TELEGRAM_BOT_TOKEN 없음.',
      '  1) 텔레그램에서 @BotFather → /newbot → 토큰 복사',
      `  2) loops.env 에 추가:  TELEGRAM_BOT_TOKEN=<토큰>`,
      '  3) loopctl bot 재실행 → 새 봇에게 아무 메시지 전송 (chat-id 자동 페어링)',
    ].join('\n'));
    process.exit(1);
  }
  const me = await tg('getMe', {});
  if (!me || !me.ok) { console.error('❌ 봇 토큰이 유효하지 않음 (getMe 실패). loops.env 의 TELEGRAM_BOT_TOKEN 확인.'); process.exit(1); }
  log(`🤖 @${me.result.username} 기동 · 대시보드 127.0.0.1:${PORT} · 폴링 ${POLL_SEC}s`);
  // 재시작 시 밀린 업데이트는 버리고 이후 것만 처리(오래된 명령 재실행 방지) — 페어링 대기 메시지는 이후 새로 옴
  const drain = await tg('getUpdates', { timeout: 0, offset: -1 });
  if (drain && drain.ok && drain.result.length) offset = drain.result[drain.result.length - 1].update_id + 1;
  if (!CHAT) log('⏳ 페어링 대기 — 텔레그램에서 이 봇에게 아무 메시지나 보내세요.');
  else send('🔄 봇 재시작 — 알림·제어 재개').catch(() => {});
  updatesForever();
  await pollStatus();
  setInterval(() => { pollStatus().catch(e => log('poll 오류:', e.message)); }, POLL_SEC * 1000);
}
main();
