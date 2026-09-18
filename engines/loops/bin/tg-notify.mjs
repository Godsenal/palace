#!/usr/bin/env node
// 결정론 레이어(supervisor·incident-bridge)용 Telegram 직송. notify-bot 프로세스를 경유하지 않는 이유:
// 감독자가 알리는 대상이 바로 "죽은 봇/디스패처"일 수 있어서 — 알림 경로가 감시 대상과 독립이어야 한다.
// usage: tg-notify.mjs <text...>   (env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — 호출자가 _common.sh로 loops.env를 source)
// Telegram은 선택 채널: 토큰/chat 미설정이면 스킵(exit 0, stderr 1줄) — fallback이 아니라 미개통 채널의 정상 경로.
// 전송 실패(네트워크·API)는 stderr + exit 1 — 호출자는 비치명적으로 처리(감독 동작 자체는 계속).
import https from 'node:https';

const text = process.argv.slice(2).join(' ').trim();
const token = process.env.TELEGRAM_BOT_TOKEN || '';
const chat = process.env.TELEGRAM_CHAT_ID || '';
if (!text) { console.error('tg-notify: text 필요'); process.exit(1); }
if (!token || !chat) { console.error('tg-notify: TELEGRAM_BOT_TOKEN/CHAT_ID 미설정 — 알림 스킵'); process.exit(0); }

const body = JSON.stringify({ chat_id: chat, text });   // parse_mode 없음(플레인 텍스트) — 이스케이프 사고 원천 차단
const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  timeout: 10000,
}, (r) => {
  let d = ''; r.on('data', c => d += c); r.on('end', () => {
    try {
      const j = JSON.parse(d);
      if (!j.ok) { console.error(`tg-notify: API 실패 — ${j.description || d}`); process.exit(1); }
      process.exit(0);
    } catch { console.error(`tg-notify: HTTP ${r.statusCode} — JSON 파싱 실패`); process.exit(1); }
  });
});
req.on('error', e => { console.error(`tg-notify: ${e.message}`); process.exit(1); });
req.on('timeout', () => { req.destroy(); console.error('tg-notify: 타임아웃(10s)'); process.exit(1); });
req.end(body);
