#!/usr/bin/env node
// 유령 탭 스윕 — "발화하지 못한 채 이름도 못 받은 워크스페이스"를 주기적으로 회수하는 자가치유 층.
//
// ⚠️ 왜 필요한가(실측 2026-08-01·08-03, 두 번의 사고): cmux는 부하를 받으면 소켓 RPC가 타임아웃한다.
//   `workspace create`가 타임아웃하면 CLI는 ref를 못 돌려주는데 **워크스페이스는 실제로 생성돼 있고**,
//   같은 이유로 rename도 실패해 탭이 이름 없는 "Terminal"로 남는다. 엔진의 모든 회수 경로(watchdog·리퍼·
//   cleanup-issue·sweep_panels)는 타이틀 정규식(🛠|↩|🔎|🧪|🔁|📊|🤖)에 걸려 있어서, **이름 없는 탭은
//   어떤 리퍼에도 안 걸린다.** 탭이 쌓일수록 cmux가 느려져 타임아웃이 더 잦아지는 폭주 루프가 된다
//   (실측: 이틀 만에 66개, 그전 이틀에 93개 — 두 번 다 spawn-failed 건수와 1:1).
//   spawn-panel이 생성-실패 시 diff로 회수하도록 고쳤지만(11b5f40), 그 회수 자체도 같은 RPC를 타므로
//   부하가 심하면 또 샌다. 그래서 "누가 흘렸든 주기적으로 걷는" 층을 따로 둔다 — 타이틀에 의존하지 않는
//   유일한 리퍼다.
//
// 판정(전부 만족해야 후보 — 사용자 탭 불가침이 최우선):
//   ① 커스텀 타이틀 없음 — 엔진이 만든 탭은 spawn-panel이 타이틀을 재확정까지 하므로, 이름 없음 = 잔해.
//   ② cwd가 루프 worktree 접두사(config.worktreePrefix) 아래 — 사용자 디렉터리는 애초에 후보가 아니다.
//   ③ 대화 흔적 없음(latest_conversation_message·latest_submitted_message) — 있으면 사용자 세션.
//   ④ PTY 없음(read-screen 실패) — 살아있는 셸/워커는 건드리지 않는다.
//   ⑤ 그 이슈의 워커 pidfile이 살아있지 않음 — 리네임만 실패한 정상 워커를 죽이지 않기 위한 최종 방어.
//   ⑥ 연속 2회 관찰 — 방금 만들어져 아직 렌더 전인 정상 탭을 오폐기하지 않는다(watchdog CORPSE_PASSES와 동일 관용구).
// 안전: 탭 close만 한다. 프로세스 kill·Linear 이동·worktree 삭제·머지/배포/force-push 전부 없음.
//   목록을 못 얻으면(빈 응답·파싱 실패) 판정불가로 skip한다(플레이크 원칙 — sweep_panels와 동일).
// usage: CMUX_BIN=... node bin/phantom-sweep.mjs        (supervisor.sh panels 스코프가 호출)
//        --dry-run 으로 판정만 출력(닫지 않음)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.LOOPS_HOME || path.resolve(import.meta.dirname, '..');
const CMUX = process.env.CMUX_BIN || '';
const DRY = process.argv.includes('--dry-run');
const STATEF = `${ROOT}/state/phantom-sweep.json`;
const MAX_CLOSE = +(process.env.LOOPS_PHANTOM_MAX || 10);   // 한 패스 상한 — 디스패처 housekeeping을 오래 붙잡지 않기 위함
const now = Math.floor(Date.now() / 1000);

if (!CMUX) { console.log('phantom-sweep: CMUX_BIN 없음 — skip'); process.exit(0); }

const cmux = (args, timeout = 15000) =>
  execFileSync(CMUX, args, { encoding: 'utf8', timeout, env: { ...process.env, CMUX_QUIET: '1' } });
const tryCmux = (args, timeout) => { try { return cmux(args, timeout) } catch { return null } };

// ── 목록 ──
let workspaces;
try { workspaces = JSON.parse(cmux(['workspace', 'list', '--json'])).workspaces } catch { workspaces = null }
if (!Array.isArray(workspaces) || !workspaces.length) {
  console.log('phantom-sweep: workspace list 빈 응답/파싱 실패 — 판정불가 skip');
  process.exit(0);
}

// ── ② 루프 worktree 접두사 ──
const prefixes = [];
for (const id of fs.readdirSync(`${ROOT}/loops`, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
  let cfg; try { cfg = JSON.parse(fs.readFileSync(`${ROOT}/loops/${id}/config.json`, 'utf8')) } catch { continue }
  if (cfg.worktreePrefix) prefixes.push(cfg.worktreePrefix);
}
if (!prefixes.length) { console.log('phantom-sweep: worktreePrefix를 가진 루프 없음 — skip'); process.exit(0) }
const underLoopWorktree = cwd => prefixes.some(p => cwd === p || cwd.startsWith(p + '-'));

// ── ⑤ 살아있는 워커 pid ──
const alive = new Set();
for (const id of fs.readdirSync(`${ROOT}/loops`)) {
  const dir = `${ROOT}/loops/${id}/state/live`;
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    const pid = +fs.readFileSync(`${dir}/${f}`, 'utf8').trim();
    try { process.kill(pid, 0); alive.add(f.replace(/\.pid$/, '').toLowerCase()) } catch {}
  }
}
// cwd(…-realty-1234 / -vf / -vd) → 이슈 slug. 워커 pidfile은 이슈 ID(REALTY-1234)로 기록된다.
const issueOf = cwd => (cwd.match(/([a-z]+-\d+)(?:-vf|-vd)?$/) || [])[1] || '';

// ── 후보 판정 ──
const cand = workspaces.filter(w => {
  const cwd = w.current_directory || '';
  if (w.has_custom_title) return false;                                     // ①
  if (!underLoopWorktree(cwd)) return false;                                // ②
  if (w.latest_conversation_message || w.latest_submitted_message) return false;  // ③
  if (alive.has(issueOf(cwd))) return false;                                // ⑤
  return true;
}).filter(w => tryCmux(['read-screen', '--workspace', w.ref, '--lines', '1'], 8000) === null);  // ④

// ── ⑥ 연속 2회 관찰 ──
let seen = {}; try { seen = JSON.parse(fs.readFileSync(STATEF, 'utf8')) } catch {}
const key = w => `${w.ref}|${w.current_directory}`;
const nextSeen = {}, confirmed = [];
for (const w of cand) {
  const k = key(w);
  nextSeen[k] = seen[k] || now;
  if (seen[k]) confirmed.push(w);
}

// ── 회수 ──
// close-workspace는 PTY 없는 워크스페이스에서 타임아웃한다(실측). select로 한 번 깨우면 즉시 성공하므로
// 실패 시 select 후 재시도하고, 원래 선택 탭을 되돌린다. 결과는 목록으로 검증한다 — 무소음 실패 금지.
const listRefs = () => {
  const out = tryCmux(['list-workspaces'], 10000) || '';
  return new Set([...out.matchAll(/workspace:\d+/g)].map(m => m[0]));
};
const selectedRef = () => {
  const out = tryCmux(['list-workspaces'], 10000) || '';
  const line = out.split('\n').find(l => l.includes('[selected]')) || '';
  return (line.match(/workspace:\d+/) || [])[0] || '';
};

let closed = 0, failed = 0;
const batch = confirmed.slice(0, MAX_CLOSE);
if (confirmed.length > batch.length)
  console.log(`phantom-sweep: 확정 ${confirmed.length}개 중 이번 패스는 ${batch.length}개만 회수(상한 ${MAX_CLOSE}) — 나머지는 다음 패스`);

for (const w of batch) {
  if (DRY) { console.log(`phantom-sweep: [dry-run] ${w.ref} ${w.current_directory}`); continue }
  tryCmux(['close-workspace', '--workspace', w.ref], 10000);
  if (!listRefs().has(w.ref)) { closed++; delete nextSeen[key(w)]; console.log(`phantom-sweep: 유령 탭 ${w.ref} (${w.current_directory}) 회수`); continue }
  const prev = selectedRef();
  tryCmux(['select-workspace', '--workspace', w.ref], 10000);
  tryCmux(['close-workspace', '--workspace', w.ref], 10000);
  if (prev) tryCmux(['select-workspace', '--workspace', prev], 10000);
  if (!listRefs().has(w.ref)) { closed++; delete nextSeen[key(w)]; console.log(`phantom-sweep: 유령 탭 ${w.ref} (${w.current_directory}) 회수(select 경유)`) }
  else { failed++; console.log(`phantom-sweep: 회수 실패 ${w.ref} — 다음 패스 재시도`) }
}

try { fs.mkdirSync(path.dirname(STATEF), { recursive: true }); fs.writeFileSync(STATEF, JSON.stringify(nextSeen)) } catch (e) {
  console.log(`phantom-sweep: 상태 파일 기록 실패(${STATEF}) — ${e.message}`);
}
// 요약은 회수/후보가 있을 때만(조용한 패스는 디스패처 로그를 더럽히지 않는다).
if (closed || failed || cand.length)
  console.log(`phantom-sweep: 후보 ${cand.length} · 확정 ${confirmed.length} · 회수 ${closed}${failed ? ` · 실패 ${failed}` : ''}`);
process.exit(0);
