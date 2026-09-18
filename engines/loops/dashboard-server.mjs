#!/usr/bin/env node
// Loops 플랫폼 대시보드 — 멀티 루프 관리 UI + 제어. 의존성 0 (Node 내장 http).
// ⚠️ cmux 패널 안에서 실행해야 함(제어가 cmux 소켓 접근). loopctl dashboard 로 띄움.
import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadEnv, setEnvVar } from './bin/env-file.mjs';
import { mergeProduct } from './bin/loop-config.mjs';
import { generateVapidKeys, sendNotification } from './bin/webpush.mjs';

const ROOT = process.env.LOOPS_HOME || dirname(fileURLToPath(import.meta.url));
const ENV = loadEnv(ROOT);
const LOOPS = `${ROOT}/loops`;
const GSTATE = `${ROOT}/state`;
const CMUX = ENV.CMUX_BIN || process.env.CMUX_BIN || 'cmux';
const GH = ENV.GH_BIN || process.env.GH_BIN || 'gh';
const CMUX_BUNDLE = ENV.CMUX_BUNDLE_ID || process.env.CMUX_BUNDLE_ID || 'com.cmuxterm.app';
const WORKTREE_BASE = process.env.PALACE_WORKTREE_BASE || ENV.WORKTREE_BASE || process.env.WORKTREE_BASE || `${process.env.HOME}/LTH`;
const PORT = +(process.env.PALACE_LOOPS_PORT || ENV.LOOPS_PORT || process.env.LOOPS_PORT || 8422);
const HOST_TOKEN = process.env.LOOPS_HOST_TOKEN || '';
const GPID = `${GSTATE}/dispatcher.pid`;
const GPAUSED = `${GSTATE}/PAUSED`;
const GAWAKE = `${GSTATE}/awake.pid`;   // caffeinate 프로세스 pid (잠자기 방지 토글)

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const slugOf = (id) => String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
// ⚠️ worktree 경로 규칙 = bin/spawn-worker.sh의 WT="${PREFIX}-${slug}" 와 일치해야 함(source of truth). 이미 파싱된 cfg를 받는 순수 함수 — config 재-read 없음.
const wtPath = (cfg, id) => `${cfg.worktreePrefix || ''}-${slugOf(id)}`;
let LINEAR_KEY = ENV.LINEAR_API_KEY || process.env.LINEAR_API_KEY || '';   // 런타임 보유 — UI에서 즉시 갱신, loops.env에 영속화. status는 boolean만 노출.

function listLoopIds() { try { return readdirSync(LOOPS).filter(d => existsSync(`${LOOPS}/${d}/config.json`)); } catch { return []; } }
// 루프 config 읽기(제품 상속 머지 포함). 읽기 전용 표시/조회용 — 쓰기(save-config 등)는 여전히 루프 파일만 만진다.
// product 링크가 깨져도 UI는 루프 자체 필드로 계속 뜬다(loud 로그 + 미상속) — 대시보드는 관측 도구라 죽지 않는 게 우선.
function loopCfg(lid) {
  const c = readJSON(cfgPath(lid)) || {};
  try { return mergeProduct(ROOT, c); }
  catch (e) { console.error(`[config] ${lid}: product '${c.product}' 머지 실패 — ${e.message}`); return c; }
}
/* 짧은 TTL 메모. 감싸는 대상은 execFileSync — 하위 프로세스를 통째로 띄우는 동안 이벤트
   루프가 그대로 멈춘다. /api/status는 2초마다(클라이언트가 여럿이면 더 자주) 불리는데
   답은 그 사이 거의 안 바뀌므로, 매번 새로 spawn할 이유가 없다. */
function memo(ms, fn) {
  let at = 0, val;
  return () => {
    const now = Date.now();
    if (now - at < ms) return val;
    at = now; val = fn();
    return val;
  };
}
const tabsAll = memo(1500, () => {
  try {
    return execFileSync(CMUX, ['list-workspaces'], { encoding: 'utf8', timeout: 4000 })
      .split('\n').map(l => { const m = l.match(/workspace:\d+/); const title = l.replace(/^\s*\*?\s*workspace:\d+\s*/, '').trim(); return m ? { ref: m[0], title } : null; })
      .filter(Boolean);
  } catch { return []; }
});
function globalDispatcher() {
  const t = readText(GPID).trim(); const pid = t ? +t : null; const running = pid ? pidAlive(pid) : false;
  return { running, paused: existsSync(GPAUSED), pid: running ? pid : null };
}
// caffeinate(잠자기 방지) 살아있는 pid 또는 null. detached로 떠서 대시보드 서버 재시작과 무관하게 유지된다.
function awakeStatus() { const t = readText(GAWAKE).trim(); const pid = t ? +t : null; return pid && pidAlive(pid) ? pid : null; }
// Telegram 브리지(notify-bot) 상태 — 토큰/chat은 loops.env를 live로 다시 읽어 페어링을 즉시 반영, running은 pgrep. 비밀값은 노출 안 하고 boolean만.
const botRunning = memo(1500, () => { try { execFileSync('/usr/bin/pgrep', ['-f', `${ROOT}/bin/notify-bot.mjs`], { timeout: 2000 }); return true; } catch { return false; } });
function telegramStatus() { const e = loadEnv(ROOT); return { configured: !!(e.TELEGRAM_BOT_TOKEN || ''), paired: !!(e.TELEGRAM_CHAT_ID || ''), running: botRunning() }; }
function feedOf(st) { return readText(`${st}/runs.jsonl`).trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
// 루프 경제성 집계 — costs.jsonl(run-once가 사이클마다 append) + 파생 counts + rework.json.
// perMergedUsd = "머지된 변경 1건당 오케스트레이션 비용" (측정 범위는 headless 오케스트레이터 사이클 — 라이브 TUI 워커 비용은 미측정).
function economicsOf(st, cfg, counts, rework) {
  const lines = readText(`${st}/costs.jsonl`).trim().split('\n').filter(Boolean).slice(-5000);
  const d = new Date(); d.setHours(0, 0, 0, 0); const t0 = Math.floor(d.getTime() / 1000);
  let todayUsd = 0, totalUsd = 0, cycles = 0;
  for (const l of lines) { try { const e = JSON.parse(l); if (e.usd) { totalUsd += e.usd; if (e.ts >= t0) todayUsd += e.usd; } if (e.kind === 'cycle') cycles++; } catch {} }
  const merged = counts.Done || 0, canceled = counts.Canceled || 0;
  const budgetDailyUsd = (cfg.budget && cfg.budget.dailyUsd) || null;
  return {
    todayUsd: +todayUsd.toFixed(4), totalUsd: +totalUsd.toFixed(4), cycles,
    perMergedUsd: merged ? +(totalUsd / merged).toFixed(4) : null,
    mergeRate: (merged + canceled) ? +(merged / (merged + canceled)).toFixed(3) : null,
    reworkTotal: Object.values(rework).reduce((s, r) => s + (r.count || 0), 0),
    budgetDailyUsd, budgetExceeded: !!(budgetDailyUsd && todayUsd >= budgetDailyUsd),
  };
}

// PR 상태 캐시 — 이슈 브랜치(branchPrefix/slug)로 라이브 조회. 60초마다 백그라운드 갱신(status 요청을 막지 않음).
// snapshot.json(orchestrator가 시간당 1회 기록)에 의존하지 않으므로, worker가 방금 연 PR·방금 닫힌/머지된 PR도 즉시 반영된다.
// repo당 `gh pr list` 1회 → headRefName으로 우리 브랜치만 매칭. (PR URL은 gh가 돌려준 j.url만 신뢰 — origin이 mirror일 수 있음)
const prByBranch = {};
function branchOf(cfg, lid, id) { return `${cfg.branchPrefix || ('loop-' + lid)}/${slugOf(id)}`; }
function prDataFromJson(j) {
  const ch = j.statusCheckRollup || [];
  const ciFail = ch.filter(c => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'].includes(c.conclusion)).length;
  const ciPend = ch.filter(c => c.status && c.status !== 'COMPLETED').length;
  const ciPass = ch.filter(c => c.conclusion === 'SUCCESS').length;
  const cs = ciFail ? 'fail' : (ciPend ? 'pending' : 'pass');
  let att = null;
  if (j.state === 'OPEN') { if (cs === 'fail') att = 'ci-failed'; else if (j.reviewDecision === 'APPROVED') att = 'merge-ready'; else if (j.reviewDecision === 'CHANGES_REQUESTED') att = 'changes'; }
  else if (j.state === 'CLOSED' && !j.mergedAt) att = 'pr-closed';
  return { url: j.url, merged: !!j.mergedAt, state: j.state, review: j.reviewDecision, checks: cs, ci: { pass: ciPass, fail: ciFail, pending: ciPend }, reviewCount: (j.reviews || []).length, commentCount: (j.comments || []).length, attention: att };
}
function refreshPRs() {
  const byRepo = {};   // repo 경로 → 우리가 관심있는 브랜치 Set
  for (const lid of listLoopIds()) {
    const cfg = loopCfg(lid); const repo = cfg.repo; if (!repo) continue;
    const snap = readJSON(`${LOOPS}/${lid}/state/snapshot.json`);
    (byRepo[repo] ||= new Set());
    (snap?.issues || []).forEach(i => byRepo[repo].add(branchOf(cfg, lid, i.id)));
  }
  for (const [repo, branches] of Object.entries(byRepo)) {
    if (!branches.size) continue;
    // ⚠️ reviews/comments 필드는 제외 — coderabbit 등이 다는 거대 코멘트 본문이 섞여 200건이면 응답이 수 MB → execFile 기본 maxBuffer(1MB) 초과로 통째 실패한다. reviewDecision으로 충분. maxBuffer도 여유있게.
    execFile(GH, ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'url,state,mergedAt,headRefName,statusCheckRollup,reviewDecision'], { cwd: repo, timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, (e, so) => {
      if (e) return; try {
        const seen = new Set();   // gh는 최신순 → 브랜치별 첫(=최신) PR만 채택(reopen 대비)
        for (const j of JSON.parse(so)) {
          if (!branches.has(j.headRefName) || seen.has(j.headRefName)) continue;
          seen.add(j.headRefName); prByBranch[j.headRefName] = prDataFromJson(j);
        }
      } catch {}
    });
  }
}

// Linear 상태 캐시 — 이슈별 statusType(backlog|unstarted|started|completed|canceled|triage)을 60초마다 백그라운드 갱신.
// ⚠️ 왜 필요한가: 이슈 표시 상태의 "라이브" 신호가 PR(gh) 하나뿐이었다. delivery=direct 루프는 PR을 아예 안 열어
//    live가 상시 null이고, 워커의 OMP TUI는 일이 끝나도 idle 프로세스로 남아 탭(=alive)이 계속 살아있다
//    (worker-run.sh의 종료 훅은 프로세스가 죽어야 탄다 — 검토용 탭 유지 설계). 그래서 "push+Done까지 끝난 이슈"가
//    stale snapshot(사이클당 1회 기록) + alive 탭 조합으로 다음 사이클이 끝날 때까지 "작업중"으로 박제됐다.
//    탭을 닫아줄 리퍼는 /tmp/loop-<id>.lockdir 점유 중엔 skip하므로(dispatch.sh:165) 사이클이 길면 그 창이 수 분+.
//    리퍼(cleanup-terminal)가 쓰는 것과 동일한 권위 신호를 대시보드도 직접 읽어 그 창을 없앤다. 읽기 전용 — 상태 이동 없음.
// 프로젝트+라벨 단위 1회 조회(제품 공유 프로젝트는 중복 제거). 이슈 식별자는 전역 유일이라 플랫 맵으로 충분.
// ⚠️ Linear rate-limit(개인키 시간당 한도) 절약: on.linearNew 루프는 event-poll.sh가 이미 60초마다 같은 질의를 하고
//    결과를 state/linear-states.tsv 로 남긴다 → 신선하면(≤LINEAR_TSV_FRESH) 그걸 재사용하고 질의를 건너뛴다.
//    파일이 없거나(=on.linearNew 미설정) 오래됐으면(=디스패처 정지) 대시보드가 직접 조회한다 —
//    관측 도구는 디스패처가 죽어도 살아있어야 하므로 폴백을 없애지 않는다.
const LINEAR_TSV_FRESH = 90;   // 초. event-poll 주기(60s)보다 여유 있게.
const linearByIssue = {};
function ingestLinearRows(rows) { for (const r of rows) { const [id, t] = r.split('\t'); if (id && t) linearByIssue[id.toUpperCase()] = t; } }
function refreshLinear() {
  if (!LINEAR_KEY) return;   // 키 없음 = 조회 불가 → 캐시 손대지 않고 snapshot 폴백(cleanup-terminal과 같은 강등 경로)
  const seen = new Set();
  for (const lid of listLoopIds()) {
    const cfg = loopCfg(lid); const pid = cfg.linearProjectId; if (!pid) continue;
    const label = cfg.linearLabel || '';
    const k = `${pid}\t${label}`; if (seen.has(k)) continue;
    // event-poll이 방금 받아둔 게 있으면 재사용 (같은 pid+label 질의라 내용이 동일하다).
    const tsv = `${LOOPS}/${lid}/state/linear-states.tsv`;
    try {
      if ((Date.now() - statSync(tsv).mtimeMs) / 1000 <= LINEAR_TSV_FRESH) {
        const rows = readText(tsv).trim().split('\n').filter(Boolean);
        if (rows.length) { ingestLinearRows(rows); seen.add(k); continue; }
      }
    } catch {}   // 파일 없음/stat 실패 = 재사용 불가 → 아래에서 직접 조회 (무음 폴백이 아니라 명시적 대체 경로)
    seen.add(k);
    const argv = [`${ROOT}/bin/linear-states.mjs`, pid]; if (label) argv.push(label);
    execFile(process.execPath, argv, { env: { ...process.env, LINEAR_API_KEY: LINEAR_KEY }, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (e, so) => {
      const rows = String(so || '').trim().split('\n').filter(Boolean);
      // 실패/0건(키 만료·네트워크)이면 캐시를 비우지 않는다 — 빈 응답을 "이슈 전멸"로 믿으면 표시가 통째로 뒤집힌다
      // (리퍼의 TAB_TRUTH와 같은 원칙). 원인은 loud하게 남긴다.
      if (e || !rows.length) { console.error(`[linear] ${pid}${label ? ' #' + label : ''} 조회 실패/0건 — 이전 캐시 유지 (${e ? e.message : 'empty'})`); return; }
      ingestLinearRows(rows);
    });
  }
}
// snapshot의 상태명 + 라이브 Linear statusType → 권위 상태. Linear가 없으면(키 없음/미조회 이슈) snapshot 그대로.
// statusType은 타입만 주고 이름을 안 주므로, 비종료 타입에서는 snapshot의 커스텀 상태명("Known Issue" 등)을 살린다.
function authStateOf(lt, snapState) {
  if (!lt) return snapState;
  if (lt === 'completed') return 'Done';
  if (lt === 'canceled') return 'Canceled';
  // started 타입에는 "In Progress" 말고도 "In Review"·"Ready to Deploy" 같은 커스텀 이름이 들어있고
  // statusType만으론 그 이름을 복원할 수 없다 → snapshot이 이미 비-Backlog/비-종료 이름이면 그대로 유지한다.
  // (이 분기의 실제 임무는 "snapshot이 아직 Backlog/종료인데 Linear는 이미 시작됨"을 정정하는 것뿐.)
  if (lt === 'started') return ['Backlog', 'Done', 'Canceled', 'Cancelled'].includes(snapState) ? 'In Progress' : snapState;
  // backlog | unstarted | triage — snapshot이 진행/종료로 알고 있으면 그쪽이 뒤처진 것 → Backlog로 정정.
  return ['In Progress', 'In Review', 'Done', 'Canceled', 'Cancelled'].includes(snapState) ? 'Backlog' : snapState;
}

// wantIssues=false면 이 루프는 사이드바 한 줄로만 쓰인다 — 이슈 카드도 활동 피드도 안 그린다.
function loopStatus(lid, allTabs, wantIssues = true) {
  const dir = `${LOOPS}/${lid}`, st = `${dir}/state`;
  const cfg = loopCfg(lid);
  const snap = readJSON(`${st}/snapshot.json`);
  // runs.jsonl은 루프당 최대 800KB대고 줄마다 JSON.parse가 돈다. 화면에 안 나갈 피드까지
  // 매 요청(2초)마다 통째로 읽으면 그 시간만큼 이벤트 루프가 멈춘다 — 필요할 때만 읽는다.
  const f = wantIssues ? feedOf(st) : [];
  const order = { 'In Progress': 0, 'In Review': 1, 'Backlog': 2, 'Done': 3, 'Canceled': 4 };
  const tabByIssue = {};
  // 🛠=fresh worker, ↩=resume/heal 탭 둘 다 "살아있는 worker"로 인식 (안 하면 heal된 ↩ 탭을 죽은 걸로 오판해 워치독이 무한 재기동).
  for (const t of allTabs) { const m = (t.title || '').match(new RegExp('(?:🛠|↩)\\s*' + lid + '\\s+(\\S+)')); if (m) tabByIssue[m[1].toUpperCase()] = t.ref; }
  const liveness = readJSON(`${st}/liveness.json`) || {};   // watchdog.sh가 쓰는 spawn-liveness 상태 {issue:{attempts,escalated,...}}
  const rework = readJSON(`${st}/rework.json`) || {};       // rework-worker.sh가 쓰는 리뷰 재작업 상태 {issue:{count,lastAt,exhausted}}
  const orchRunning = existsSync(`/tmp/loop-${lid}.lockdir`);   // run 진행 중 — 아래 stalled 판정의 억제 조건(팬아웃 과도기)
  const issues = (snap?.issues || []).map(i => {
    const live = prByBranch[branchOf(cfg, lid, i.id)] || null;
    const ws = tabByIssue[i.id] || null, alive = !!ws;
    const lv = liveness[i.id] || null;
    const rw = rework[i.id] || null;
    // 재작업 상한 도달은 리뷰가 아직 CHANGES_REQUESTED로 열려있는 동안만 경보 — 사람이 머지/승인/닫으면 자동 해소.
    const reworkExhausted = !!(rw && rw.exhausted && live && live.state === 'OPEN' && live.review === 'CHANGES_REQUESTED');
    const stuck = !!(lv && lv.escalated);                      // 워치독이 자가복구 N회 실패로 포기 → 사람 필요
    const wedged = !!(lv && lv.wedged && alive);               // 탭은 살아있으나 화면이 정지 = 멈춘 OMP → 사람 확인
    const healing = !!(lv && lv.attempts > 0 && !lv.escalated && !alive);  // 자가복구 진행중(조용, 경보 아님)
    // 배달 후(OPEN PR) 상주 monitor가 MERGE_WEDGE_SEC 이상 정체 = 워치독의 heal/wedge 범위 밖이라 복구 액터가 없는 상태.
    // 사람이 머지(또는 확인)해야 풀린다 — 엔진은 절대 머지하지 않으므로 이 표면화가 유일한 해소 경로다.
    const mergeWedged = !!(lv && lv.mergeWedged && alive && live && live.state === 'OPEN');
    const gateResolved = i.flag === 'human-gate' && existsSync(`${st}/decisions/${i.id}.md`);
    const verify = readJSON(`${st}/verify/${i.id}.json`);   // 검증자(verifier) verdict {verdict,ts,summary} — verify 켜진 루프만 존재
    const validate = readJSON(`${st}/validate/${i.id}.json`);   // 제안 검증자(validator) verdict {verdict,ts,summary,ask_note,alternative} — validate 켜진 제안형 루프만 존재
    // 표시 상태 = 라이브 신호(PR + Linear + 탭) 우선. snapshot은 사이클당 1회라 뒤처지므로 보조로만.
    // authState = snapshot을 라이브 Linear로 정정한 상태. direct 모드엔 PR이 없어 이게 유일한 완료 신호다.
    const authState = authStateOf(linearByIssue[String(i.id).toUpperCase()] || null, i.state);
    let state = authState, working = false;
    if (live && live.merged) state = 'Done';
    else if (live && live.state === 'OPEN') state = 'In Review';
    else if (live && live.state === 'CLOSED') state = (authState === 'Done' || authState === 'Canceled') ? authState : 'In Review';  // 닫힘=정리 대상 → In Review 버킷 + pr-closed 플래그로 표시
    else if (!live && alive && authState !== 'Done' && authState !== 'Canceled') { state = 'In Progress'; working = true; }  // PR도 없고 Linear도 미완인데 탭 살아있음 = 진짜 작업중
    // 박제 감지: 권위 상태는 In Progress인데 라이브 탭도 PR도 없음 = 죽었거나 완료 후 탭이 닫힌 worker (이미 계산된 alive/live만 조합, 신규 IO 없음). direct 모드는 PR이 상시 null이라 특히 필요.
    // ⚠️ run 진행 중(lockdir)엔 억제한다: 오케스트레이터 팬아웃은 **spawn 전에** Linear를 In Progress로 옮기므로
    //    (spawn-worker.sh:45 주석 참조 — resolve-gate/start-issue 경로만 spawn 후 이동) 탭이 뜨기까지 수 초~수십 초 동안
    //    "started인데 탭 없음"이 정상적으로 존재한다. 라이브 Linear를 근거로 쓰면서 이걸 안 막으면 팬아웃마다
    //    stalled-worker 오탐이 뜨고 pushTick이 폰 알림까지 쏜다. 워치독·리퍼도 같은 이유로 lockdir 중엔 skip한다(동일 정책).
    const stalled = authState === 'In Progress' && !alive && !live && !orchRunning;
    return {
      ...i, state, snapState: i.state, linearState: authState, pr: (live && live.url) || i.pr || null,
      workspace: ws, alive, working, stalled, hasWorktree: existsSync(wtPath(cfg, i.id)),
      merged: live ? live.merged : undefined, prState: live ? live.state : undefined, checks: live ? live.checks : undefined,
      ci: live ? live.ci : undefined, review: live ? live.review : undefined, reviewCount: live ? live.reviewCount : undefined,
      commentCount: live ? live.commentCount : undefined, gateResolved,
      verify: verify ? { verdict: verify.verdict, ts: verify.ts, summary: verify.summary } : null,
      validate: validate ? { verdict: validate.verdict, ts: validate.ts, summary: validate.summary, askNote: validate.ask_note, alternative: validate.alternative } : null,
      stuck, wedged, healing, mergeWedged, healAttempts: lv ? (lv.attempts || 0) : 0,
      reworkCount: rw ? (rw.count || 0) : 0, reworkExhausted,
      // attention 우선순위: rework-exhausted(자동 반영 포기 → 사람 필수) > PR 라이브 신호 > human-gate > merge-wedged > stuck > wedged > stalled.
      attention: (reworkExhausted ? 'rework-exhausted' : null) || (live ? live.attention : null) || (i.flag === 'human-gate' && !gateResolved ? 'human-gate' : null) || (mergeWedged ? 'merge-wedged' : null) || (stuck ? 'stuck' : null) || (wedged ? 'wedged' : null) || (stalled && !healing ? 'stalled-worker' : null),
    };
  }).sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
  // counts는 파생 상태로 재계산 → 사이드바/카운트가 카드와 일치 (snap.counts는 시간당 1회라 뒤처짐).
  const counts = { Backlog: 0, 'In Progress': 0, 'In Review': 0, Done: 0, Canceled: 0 };
  for (const i of issues) if (counts[i.state] != null) counts[i.state]++;
  const lastExit = readText(`${st}/.last_run_exit`).trim();
  const lastRun = lastExit !== '' ? { exit: +lastExit, ts: +readText(`${st}/.last_run_done`).trim() || null } : null;
  const nextFile = readText(`${st}/next_fire`).trim();
  const gd = globalDispatcher();
  const nextTs = (gd.running && !existsSync(`${st}/PAUSED`) && cfg.enabled !== false && nextFile) ? +nextFile : null;
  return {
    id: lid, name: cfg.name || lid, emoji: cfg.emoji || '🔁', enabled: cfg.enabled !== false,
    product: cfg.product || null, linearLabel: cfg.linearLabel || null,   // 제품 계층 — 사이드바 그룹핑 + 제품 모달 멤버 표시
    repo: cfg.repo || '', linearProjectUrl: cfg.linearProjectUrl || '', maxWorkers: cfg.maxWorkers || 2,
    delivery: cfg.delivery || 'pr',
    schedule: cfg.schedule || { intervalSec: 3600, startAt: null }, paused: existsSync(`${st}/PAUSED`),
    // issues는 선택된 루프만 — 사이드바는 counts/attentionCount만 읽고 이슈 카드는 선택된
    // 루프 하나만 그린다. 전부 실어보내던 시절엔 434건이 응답의 대부분(436KB)을 차지했고,
    // 그중 화면에 닿는 건 1/11이었다. 나머지는 2초마다 폰으로 내려가 폴링을 정체시켰다.
    nextTs, lastRun, counts, issues: wantIssues ? issues : [], feed: wantIssues ? f.slice(-40).reverse() : [],
    economics: economicsOf(st, cfg, counts, rework),
    learningsTs: (() => { try { return Math.floor(statSync(`${st}/learnings.md`).mtimeMs / 1000); } catch { return null; } })(),
    // 오케스트레이터가 인프라 wedge(cmux spawn 실패 등)로 사이클을 못 돌 때 snapshot에 남기는 {reason,streak} — UI 배너로 표출.
    blocked: snap?.blocked || null,
    attentionCount: issues.filter(i => i.attention).length,
    // "정리 필요" = Linear는 아직 In Review인데 PR은 이미 머지/닫힘 → reconcile 유도.
    // 판정 근거는 라이브 Linear(linearState) — snapshot으로 보면 이미 Done으로 옮겨간 이슈까지 정리 필요로 오표시된다.
    mergedInReview: issues.filter(i => i.linearState === 'In Review' && i.merged).length,
    closedInReview: issues.filter(i => i.linearState === 'In Review' && i.prState === 'CLOSED' && !i.merged).length,
    orchRunning,
  };
}
function status(sel) {
  const allTabs = tabsAll();
  return { now: Math.floor(Date.now() / 1000), dispatcher: globalDispatcher(), awake: !!awakeStatus(), linearKey: !!LINEAR_KEY, telegram: telegramStatus(), remote: { wanted: remoteWanted, on: remoteServers.length > 0, url: remoteUrl }, products: productsStatus(), loops: listLoopIds().map(l => loopStatus(l, allTabs, !sel || l === sel)) };
}

// 제품 계층 메타(products/<id>/product.json) + triage 활동 — 사이드바 product 그룹 헤더가 소비.
// products/ 미존재·파싱 실패는 빈 객체(제품 계층은 opt-in — 없음이 정상 경로).
function productsStatus() {
  const out = {};
  let ids = [];
  try { ids = readdirSync(`${ROOT}/products`).filter(d => existsSync(`${ROOT}/products/${d}/product.json`)); } catch { return out; }
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); const t0 = Math.floor(d0.getTime() / 1000);
  for (const pid of ids) {
    const pj = readJSON(`${ROOT}/products/${pid}/product.json`); if (!pj) continue;
    let ev = [];
    try { ev = readText(`${ROOT}/products/${pid}/state/runs.jsonl`).trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && e.type === 'triage'); } catch {}
    out[pid] = {
      name: pj.name || pid, linearProjectUrl: pj.linearProjectUrl || '', linearProjectId: pj.linearProjectId || '',
      repo: pj.repo || '', prBase: pj.prBase || '', ompCommand: pj.ompCommand || '',
      model: (pj.triage && pj.triage.model) || '',
      routes: pj.triage && pj.triage.routes ? Object.entries(pj.triage.routes).map(([label, desc]) => ({ label, desc })) : [],
      triage: !!(pj.triage && pj.triage.routes),
      triageToday: ev.filter(e => e.ts >= t0).length,
      triageLast: ev.slice(-3).reverse().map(e => ({ issue: e.issue, label: e.label })),
    };
  }
  return out;
}

function sh(cmd, args, timeout = 12000) { return new Promise(r => execFile(cmd, args, { timeout }, (e, so, se) => r({ ok: !e, out: (so || '') + (se || '') }))); }
function activateCmux() { try { execFile('osascript', ['-e', `tell application id "${CMUX_BUNDLE}" to activate`], () => {}); } catch {} }
function reorderBottom(ref) { try { const n = execFileSync(CMUX, ['list-workspaces'], { encoding: 'utf8', timeout: 4000 }).split('\n').filter(l => /workspace:\d+/.test(l)).length; execFile(CMUX, ['reorder-workspace', '--workspace', ref, '--index', String(n)], () => {}); } catch {} }
function ownedInfrastructureRefs() {
  const root = realpathSync(ROOT);
  const { workspaces } = JSON.parse(execFileSync(CMUX, ['--json', 'workspace', 'list'], { encoding: 'utf8', timeout: 4000 }));
  if (!Array.isArray(workspaces)) throw new Error('cmux workspace ownership metadata unavailable');
  return new Set(workspaces.filter(workspace => {
    try { return realpathSync(workspace.current_directory) === root; } catch { return false; }
  }).map(workspace => workspace.ref));
}
function cfgPath(lid) { return `${LOOPS}/${lid}/config.json`; }
function worktreeOf(lid, id) { const cfg = readJSON(cfgPath(lid)) || {}; return wtPath(cfg, id); }
function clearNextFire(lid) { try { execFile('/bin/rm', ['-f', `${LOOPS}/${lid}/state/next_fire`], () => {}); } catch {} }
function defaultGitRefs(repo) {
  if (typeof repo !== 'string' || !repo.trim()) return null;
  const git = (...args) => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const remote = git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  const branch = remote ? remote.replace(/^origin\//, '') : git('symbolic-ref', '--quiet', '--short', 'HEAD');
  if (!branch) return null;
  return { prBase: branch, baseRef: remote || (git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`) ? `origin/${branch}` : branch) };
}

// Linear GraphQL (Node 내장 https, 의존성 0). LINEAR_API_KEY=loops.env. 이슈 버리기(→Canceled)용.
function linearGQL(query, variables) {
  return new Promise((resolve, reject) => {
    const key = LINEAR_KEY;
    if (!key) return reject(new Error('LINEAR_API_KEY 없음 — 설정 ⚙️ 에서 Linear 키를 입력하세요'));
    const body = JSON.stringify({ query, variables });
    const req = https.request('https://api.linear.app/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: key, 'content-length': Buffer.byteLength(body) }, timeout: 15000 }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const j = JSON.parse(d); if (j.errors) return reject(new Error(j.errors.map(e => e.message).join('; '))); resolve(j.data); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('linear timeout')));
    req.end(body);
  });
}

// 제품 라우트 라벨을 프로젝트의 팀에 확보(없으면 생성). 실패는 throw — 호출자가 ok:false로 변환.
// 라벨은 라우팅의 실체라, 조용히 빠지면 "분류는 됐는데 아무 루프도 안 집어가는" 유령 상태가 된다.
async function ensureRouteLabels(projectId, labels) {
  if (!labels.length) return;
  const q = await linearGQL(`query($pid:String!){ project(id:$pid){ teams(first:1){ nodes{ id labels(first:250){ nodes{ name } } } } } }`, { pid: projectId });
  const team = q?.project?.teams?.nodes?.[0];
  if (!team) throw new Error('프로젝트의 팀을 찾을 수 없음');
  const have = new Set((team.labels?.nodes || []).map(l => l.name));
  for (const name of labels) {
    if (have.has(name)) continue;
    const m = await linearGQL(`mutation($in:IssueLabelCreateInput!){ issueLabelCreate(input:$in){ success } }`, { in: { teamId: team.id, name } });
    if (!m?.issueLabelCreate?.success) throw new Error(`라벨 '${name}' 생성 실패`);
  }
}

async function control(a, p) {
  const lid = p.loop;
  switch (a) {
    case 'start': {
      // ▶ = "켜기": 이미 running이면 PAUSED를 해제(=resume)한다. running+paused일 때 ▶가 no-op으로 보이던 함정 제거.
      await sh('/bin/rm', ['-f', `${GSTATE}/STOPPED.dispatcher`]);   // "켜라"는 의도 — supervisor 감독 대상으로 복귀
      const gd = globalDispatcher();
      if (gd.running) { if (gd.paused) { await sh('/bin/rm', ['-f', GPAUSED]); return { ok: true, out: 'resumed (paused 해제)' }; } return { ok: true, out: 'already running' }; }
      // 이 엔진 ROOT에 속한 🔁/⏹ 디스패처 탭만 잔재로 취급한다: 다른 인스턴스나 사용자 탭은 회수하지 않는다.
      // 의도적으로 큐에 남은 미materialize 탭 하나만 재사용하고, 복원 셸과 종료된 잔재는 회수한다.
      try {
        const owned = ownedInfrastructureRefs();
        let queued = null; const closes = [];
        for (const l of execFileSync(CMUX, ['list-workspaces'], { encoding: 'utf8', timeout: 4000 }).split('\n')) {
          const t = l.replace(/\s*\[selected\]\s*$/, '');
          if (!t.includes('🔁 loops dispatcher') && !t.includes('⏹ loops dispatcher')) continue;
          const m = t.match(/workspace:\d+/); if (!m || !owned.has(m[0])) continue;
          let mat = true;
          try { execFileSync(CMUX, ['read-screen', '--workspace', m[0], '--lines', '1'], { stdio: 'ignore', timeout: 4000 }); } catch { mat = false; }
          if (!queued && !mat && t.includes('⏳')) { queued = m[0]; continue; }   // 의도된 큐 탭 1개 재사용
          closes.push(m[0]);   // 그 외: 복원 셸·발화 후 즉사한 ⏳ 셸·⏹ 잔재·여분 큐 — 회수
        }
        for (const r of closes) await sh(CMUX, ['close-workspace', '--workspace', r]);
        if (queued) { await sh(CMUX, ['select-workspace', '--workspace', queued]); return { ok: true, out: `큐 대기 ⏳ 탭(${queued}) 유지 — cmux 창이 화면에 보이면 자동 시작됩니다` }; }
      } catch (e) { console.error('start: 🔁 잔재 정리 스캔 실패(무해, spawn 진행):', e.message); }
      // spawn은 spawn-panel.sh 단일 원천(materialize 검증·격상·폐기) — 디스패처만 큐 잔류 허용(QUEUE_OK, 이중기동 가드 전제).
      const r = await new Promise(res => execFile(`${ROOT}/bin/spawn-panel.sh`, [ROOT, `${ROOT}/bin/dispatch.sh`, '🔁 loops dispatcher'], { timeout: 30000, env: { ...process.env, SPAWN_PANEL_QUEUE_OK: '1' } }, (e, so, se) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: (so || '').trim(), err: (se || '').trim() })));
      if (r.code === 0) { if (r.out) reorderBottom(r.out); return { ok: true, out: `디스패처 시작 (${r.out})` }; }
      if (r.code === 2) return { ok: true, out: `🕐 디스패처 큐 대기(⏳ ${r.out}) — cmux 창을 화면에 띄우면 자동 시작됩니다` };
      return { ok: false, out: r.err || 'spawn-panel 실패' };
    }
    case 'stop': { writeFileSync(`${GSTATE}/STOPPED.dispatcher`, '');   /* 의도적 정지 마커 — supervisor가 재기동하지 않도록 */ const pid = globalDispatcher().pid; if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} setTimeout(() => { try { if (pidAlive(pid)) process.kill(pid, 'SIGKILL'); } catch {} }, 1500); } execFile('/usr/bin/pkill', ['-f', `${ROOT}/bin/dispatch.sh`], () => {}); return { ok: true, out: 'stopped' }; }
    case 'pause': return sh('/usr/bin/touch', [GPAUSED]);
    case 'resume': return sh('/bin/rm', ['-f', GPAUSED]);
    case 'awake-on': {
      if (awakeStatus()) return { ok: true, out: '이미 잠자기 방지 중' };
      // caffeinate -i: idle 시스템 슬립 차단. detached+unref → 요청/서버 재시작과 무관하게 살아있고, awake-off에서 kill.
      const c = spawn('/usr/bin/caffeinate', ['-i'], { stdio: 'ignore', detached: true }); c.unref();
      if (!c.pid) return { ok: false, out: 'caffeinate 실행 실패' };
      try { writeFileSync(GAWAKE, String(c.pid)); } catch (e) { return { ok: false, out: '' + e }; }
      return { ok: true, out: '☕ 잠자기 방지 ON (idle 슬립 차단 — 뚜껑 닫기 잠자기는 막지 못함)' };
    }
    case 'awake-off': {
      const pid = awakeStatus(); if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      execFile('/bin/rm', ['-f', GAWAKE], () => {});
      return { ok: true, out: '잠자기 방지 OFF' };
    }
    case 'run-now': { if (!lid) return { ok: false, out: 'no loop' }; if (existsSync(`/tmp/loop-${lid}.lockdir`)) return { ok: false, out: '⏳ 이미 orchestrator 실행 중입니다 — 끝난 뒤 다시 누르세요 (버튼이 "실행 중·로그"로 바뀌면 끝난 겁니다).' }; spawn(`${ROOT}/bin/spawn-orchestrator.sh`, [lid], { stdio: 'ignore' }); return { ok: true, out: lid + ' 사이클 발사' }; }
    case 'reconcile': { if (!lid) return { ok: false, out: 'no loop' }; if (existsSync(`/tmp/loop-${lid}.lockdir`)) return { ok: false, out: '⏳ orchestrator 실행 중이라 지금은 못 합니다. 현재 run이 끝나면 다음 run이 머지/닫힘 PR을 자동 정리합니다 (급하면 끝난 뒤 다시 누르세요).' }; spawn(`${ROOT}/bin/spawn-orchestrator.sh`, [lid, 'reconcile'], { stdio: 'ignore' }); return { ok: true, out: lid + ' PR 정리 중… (머지→Done, 닫힘→Canceled, ~1분)' }; }
    case 'resolve-gate': {
      if (!lid || !p.issue) return { ok: false, out: 'no loop/issue' };
      const decision = (p.decision || '').trim();
      if (!decision) return { ok: false, out: '결정 내용이 비어있음' };
      const ddir = `${LOOPS}/${lid}/state/decisions`;
      try { mkdirSync(ddir, { recursive: true }); writeFileSync(`${ddir}/${p.issue}.md`, decision); }
      catch (e) { return { ok: false, out: '결정 저장 실패: ' + e }; }
      spawn(`${ROOT}/bin/spawn-worker.sh`, [lid, p.issue], { stdio: 'ignore' }); setTimeout(activateCmux, 8000);
      return { ok: true, out: p.issue + ' 결정 저장 + 워커 시작 (human-gate 해제)' };
    }
    case 'loop-pause': { if (!lid) return { ok: false }; return sh('/usr/bin/touch', [`${LOOPS}/${lid}/state/PAUSED`]); }
    case 'loop-resume': { if (!lid) return { ok: false }; return sh('/bin/rm', ['-f', `${LOOPS}/${lid}/state/PAUSED`]); }
    case 'toggle-enabled': {
      if (!lid) return { ok: false }; const cfg = readJSON(cfgPath(lid)); if (!cfg) return { ok: false, out: 'no config' };
      cfg.enabled = !(cfg.enabled !== false); writeFileSync(cfgPath(lid), JSON.stringify(cfg, null, 2));
      return { ok: true, out: lid + ' enabled=' + cfg.enabled };
    }
    case 'set-schedule': {
      if (!lid) return { ok: false }; const cfg = readJSON(cfgPath(lid)); if (!cfg) return { ok: false };
      cfg.schedule = cfg.schedule || {};
      if (p.intervalMin != null) cfg.schedule.intervalSec = Math.max(60, Math.round(+p.intervalMin * 60));
      if (p.startAt !== undefined) cfg.schedule.startAt = p.startAt || null;
      writeFileSync(cfgPath(lid), JSON.stringify(cfg, null, 2));
      clearNextFire(lid);
      return { ok: true, out: 'schedule 저장' };
    }
    case 'open-issue': {
      if (!lid || !p.issue) return { ok: false, out: 'no loop/issue' };
      const t = tabsAll().find(t => new RegExp('🛠\\s*' + lid + '\\s+' + p.issue, 'i').test(t.title));
      if (t) { const r = await sh(CMUX, ['select-workspace', '--workspace', t.ref]); activateCmux(); return r; }
      const wt = worktreeOf(lid, p.issue);
      if (!existsSync(wt)) return { ok: false, out: 'worktree 없음(정리됨)' };
      const r = await sh(`${ROOT}/bin/heal-worker.sh`, [lid, p.issue, '0']);
      activateCmux(); return r;
    }
    case 'start-issue': { if (!lid || !p.issue) return { ok: false }; spawn(`${ROOT}/bin/spawn-worker.sh`, [lid, p.issue], { stdio: 'ignore' }); setTimeout(activateCmux, 8000); return { ok: true, out: p.issue + ' worker 시작 중...' }; }
    case 'heal-issue': {   // stuck 이슈 수동 재시도: liveness 카운터 리셋(escalated 해제) + worktree 보존 재기동.
      if (!lid || !p.issue) return { ok: false };
      try { const lp = `${LOOPS}/${lid}/state/liveness.json`; const lo = readJSON(lp) || {}; delete lo[p.issue]; writeFileSync(lp, JSON.stringify(lo)); } catch {}
      spawn(`${ROOT}/bin/heal-worker.sh`, [lid, p.issue], { stdio: 'ignore' }); setTimeout(activateCmux, 8000);
      return { ok: true, out: p.issue + ' 재시도 중… (자가복구 카운터 리셋)' };
    }
    case 'close-tab': { if (!p.workspace) return { ok: false, out: 'no workspace' }; return sh(CMUX, ['close-workspace', '--workspace', p.workspace]); }
    case 'cleanup-issue': { if (!lid || !p.issue) return { ok: false, out: 'no issue' }; spawn(`${ROOT}/bin/cleanup-issue.sh`, [lid, p.issue], { stdio: 'ignore' }); return { ok: true, out: p.issue + ' 정리 중… (탭·worktree·브랜치 제거)' }; }
    case 'cancel-issue': {   // 이슈 버리기: Linear → Canceled + 세션 탭·worktree·브랜치 정리. snapshot 패치로 보드 즉시 반영.
      if (!lid || !p.issue) return { ok: false, out: 'no issue' };
      try {
        const q = await linearGQL(`query($id:String!){ issue(id:$id){ id team { states { nodes { id type } } } } }`, { id: p.issue });
        const iss = q && q.issue; if (!iss) return { ok: false, out: p.issue + ' Linear에서 못 찾음' };
        const st = ((iss.team && iss.team.states && iss.team.states.nodes) || []).find(s => s.type === 'canceled');
        if (!st) return { ok: false, out: '팀에 Canceled 상태가 없음' };
        const m = await linearGQL(`mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{stateId:$s}){ success } }`, { id: iss.id, s: st.id });
        if (!(m && m.issueUpdate && m.issueUpdate.success)) return { ok: false, out: 'Linear 업데이트 실패' };
      } catch (e) { return { ok: false, out: 'Linear: ' + e.message }; }
      try { const sp = `${LOOPS}/${lid}/state/snapshot.json`; const snap = readJSON(sp); if (snap && Array.isArray(snap.issues)) { const it = snap.issues.find(x => x.id === p.issue); if (it) { it.state = 'Canceled'; writeFileSync(sp, JSON.stringify(snap, null, 2)); } } } catch {}
      try { await sh(`${ROOT}/bin/cleanup-issue.sh`, [lid, p.issue]); } catch {}   // 탭 닫기 + worktree·브랜치 제거(제목으로 매칭하므로 ref 불필요)
      return { ok: true, out: p.issue + ' → Canceled · 세션 탭·worktree 정리' };
    }
    case 'create-issue': {   // Linear 이슈 생성 → 루프의 project Backlog. start:true 면 즉시 워커 spawn. (텔레그램 에이전트/향후 대시보드 "+태스크"용)
      if (!lid) return { ok: false, out: 'no loop' };
      const cfg = loopCfg(lid); if (!cfg || !Object.keys(cfg).length) return { ok: false, out: 'no config' };
      const pid = cfg.linearProjectId; if (!pid) return { ok: false, out: lid + ' config에 linearProjectId 없음(product 상속 포함)' };
      const title = (p.title || '').trim(); if (!title) return { ok: false, out: 'title 필요' };
      let iss;
      try {
        // project → team + backlog 상태(최저 position). linear-move.mjs와 동일 패턴.
        const q = await linearGQL(`query($pid:String!){ project(id:$pid){ teams(first:1){ nodes{ id states(first:50){ nodes{ id type position } } } } } }`, { pid });
        const team = q?.project?.teams?.nodes?.[0];
        if (!team) return { ok: false, out: 'project의 team을 못 찾음' };
        const bl = (team.states?.nodes || []).filter(s => s.type === 'backlog').sort((a, b) => a.position - b.position)[0];
        const input = { teamId: team.id, projectId: pid, title, description: p.description || '', ...(bl ? { stateId: bl.id } : {}) };
        const m = await linearGQL(`mutation($in:IssueCreateInput!){ issueCreate(input:$in){ success issue{ id identifier url } } }`, { in: input });
        iss = m?.issueCreate?.issue;
        if (!(m?.issueCreate?.success && iss)) return { ok: false, out: 'Linear issueCreate 실패' };
      } catch (e) { return { ok: false, out: 'Linear: ' + e.message }; }
      if (p.start) { spawn(`${ROOT}/bin/spawn-worker.sh`, [lid, iss.identifier], { stdio: 'ignore' }); setTimeout(activateCmux, 8000); }
      return { ok: true, out: `${iss.identifier} 생성${p.start ? ' + 워커 시작' : ' (Backlog)'}`, identifier: iss.identifier, url: iss.url };
    }
    case 'set-linear-key': {   // UI에서 Linear 개인키 입력 → 런타임 즉시 적용 + loops.env 영속화 (값은 어디에도 되돌려주지 않음)
      const key = (p.key || '').trim();
      if (!key) return { ok: false, out: '키가 비었음' };
      LINEAR_KEY = key;
      try { setEnvVar(ROOT, 'LINEAR_API_KEY', key); } catch (e) { return { ok: false, out: 'loops.env 저장 실패: ' + e.message }; }
      refreshLinear();   // 키가 없어 비어있던 라이브 Linear 캐시를 즉시 채운다(다음 60s 틱까지 기다리지 않음)
      return { ok: true, out: 'Linear 키 저장됨 (즉시 적용 · 재시작 불필요)' };
    }
    case 'set-telegram': {   // UI에서 Telegram 봇 토큰 입력 → loops.env 영속화 (값은 되돌려주지 않음). chat-id는 봇이 첫 메시지에서 자동 페어링.
      const token = (p.token || '').trim();
      if (!token) return { ok: false, out: '토큰이 비었음' };
      try { setEnvVar(ROOT, 'TELEGRAM_BOT_TOKEN', token); } catch (e) { return { ok: false, out: 'loops.env 저장 실패: ' + e.message }; }
      return { ok: true, out: '봇 토큰 저장됨 — "봇 시작" 후 텔레그램에서 봇에게 아무 메시지를 보내면 페어링됩니다.' };
    }
    case 'bot-start': {   // Telegram 브리지를 cmux 패널로 기동 (dashboard/dispatcher와 동일 방식). 봇은 /api/status·/api/control만 호출 — merge/deploy/force-push 없음.
      if (botRunning()) return { ok: true, out: '봇 이미 실행 중' };
      if (!loadEnv(ROOT).TELEGRAM_BOT_TOKEN) return { ok: false, out: '먼저 봇 토큰을 저장하세요.' };
      await sh('/bin/rm', ['-f', `${GSTATE}/STOPPED.bot`]);   // "켜라"는 의도 — supervisor 감독 대상으로 복귀
      // 현재 엔진 ROOT의 봇 잔재만 회수한다. 다른 인스턴스의 동명 탭은 보존한다.
      try {
        const owned = ownedInfrastructureRefs();
        for (const l of execFileSync(CMUX, ['list-workspaces'], { encoding: 'utf8', timeout: 4000 }).split('\n')) {
          const t = l.replace(/\s*\[selected\]\s*$/, '');
          if (!t.includes('🤖 loops bot') && !t.includes('⏹ loops bot')) continue;
          const m = t.match(/workspace:\d+/); if (m && owned.has(m[0])) await sh(CMUX, ['close-workspace', '--workspace', m[0]]);
        }
      } catch (e) { console.error('bot-start: 잔재 탭 정리 실패(무해, spawn 진행):', e.message); }
      const r = await sh('/bin/zsh', [`${ROOT}/bin/spawn-panel.sh`, ROOT, '. ./bin/_common.sh; exec node --watch ./bin/notify-bot.mjs', '🤖 loops bot'], 30000);
      const m = r.out.match(/workspace:\d+/);
      if (!r.ok || !m) return { ok: false, out: r.out || '봇 패널 실행 실패' };
      reorderBottom(m[0]);
      return { ok: true, out: `봇 시작 (${m[0]}) — 페어링 안 됐으면 텔레그램에서 봇에게 메시지를 보내세요` };
    }
    case 'bot-stop': { writeFileSync(`${GSTATE}/STOPPED.bot`, '');   /* 의도적 정지 마커 — supervisor가 재기동하지 않도록 */ execFile('/usr/bin/pkill', ['-f', `${ROOT}/bin/notify-bot.mjs`], () => {}); return { ok: true, out: '봇 중지' }; }
    case 'remote-on': return openRemote();     // tailscale IP에 추가 바인딩(폰 원격) + LOOPS_REMOTE=1 영속. 런타임 즉시 적용(재시작 불필요).
    case 'remote-off': return disableRemote(); // 원격 리스너 닫기 + LOOPS_REMOTE=0. 127.0.0.1(로컬)은 그대로.
    case 'save-mission': { if (!lid) return { ok: false }; try { writeFileSync(`${LOOPS}/${lid}/mission.md`, p.content || ''); return { ok: true, out: 'mission 저장' }; } catch (e) { return { ok: false, out: '' + e }; } }
    case 'save-vision': { if (!lid) return { ok: false }; try { writeFileSync(`${LOOPS}/${lid}/vision.md`, p.content || ''); return { ok: true, out: 'vision 저장 (다음 run부터 주입)' }; } catch (e) { return { ok: false, out: '' + e }; } }
    case 'save-learnings': { if (!lid) return { ok: false }; try { mkdirSync(`${LOOPS}/${lid}/state`, { recursive: true }); writeFileSync(`${LOOPS}/${lid}/state/learnings.md`, p.content || ''); return { ok: true, out: 'learnings 저장 (다음 run부터 주입)' }; } catch (e) { return { ok: false, out: '' + e }; } }
    case 'run-retro': { if (!lid) return { ok: false, out: 'no loop' }; if (existsSync(`/tmp/loop-${lid}.lockdir`)) return { ok: false, out: '⏳ orchestrator 실행 중 — 끝난 뒤 다시 누르세요.' }; spawn(`${ROOT}/bin/spawn-orchestrator.sh`, [lid, 'retro'], { stdio: 'ignore' }); return { ok: true, out: lid + ' 🧠 retro 분석 시작 (learnings.md 갱신, ~수분)' }; }
    case 'save-config': {
      if (!lid) return { ok: false }; const cfg = readJSON(cfgPath(lid)) || {};
      // ⚠️ 빈 문자열은 **절대 저장하지 않는다** — 키를 지운다. 제품 상속(mergeProduct)은 `cfg[k] == null`일 때만
      //    걸리므로 ""를 쓰면 상속이 영구히 막혀 repo/baseRef가 빈 채로 굳고, 워커 spawn이
      //    `fatal: not a valid object name: 'origin/develop'`로 죽는다. /api/config는 **raw** config를 돌려주므로
      //    제품 상속 필드(repo·baseRef·prBase·ompCommand·linearProject*)는 모달에 빈 칸으로 뜬다.
      //    고쳐 저장해도 그 빈 칸들이 ""로 함께 기록됐다 — 이 사고가 실제로 2번 재발했다(오케스트레이터가 매번 손으로 되돌림).
      //    나머지 키(name·emoji·branchPrefix·worktree*)도 코드에 기본값이 있어 삭제가 ""보다 항상 옳다.
      //    ⚠️ 여기서 굳이 effective(상속 반영) 값을 채워 넣지 않는 이유: 그러면 제품 값이 루프 config에 복사돼
      //    이후 제품 설정을 바꿔도 이 루프만 옛 값에 고정된다(상속의 의미가 사라짐).
      for (const k of ['name', 'emoji', 'repo', 'linearProjectId', 'linearProjectUrl', 'orchestratorWorktree', 'worktreePrefix', 'branchPrefix', 'baseRef', 'prBase', 'ompCommand', 'model']) {
        if (p[k] === undefined) continue;
        const v = typeof p[k] === 'string' ? p[k].trim() : p[k];
        if (v === '' || v == null) delete cfg[k]; else cfg[k] = v;
      }
      // product·linearLabel: 빈 값이면 키 자체를 지운다 — cfg.product=""는 상속도 안 되면서 파일만 오염.
      for (const k of ['product', 'linearLabel']) if (p[k] !== undefined) { const v = String(p[k]).trim(); if (v) cfg[k] = v; else delete cfg[k]; }
      if (p.delivery === 'pr' || p.delivery === 'direct') cfg.delivery = p.delivery;   // 배달 방식(enum) — 유효값만 기록(no silent fallback)
      if (p.maxWorkers != null) cfg.maxWorkers = Math.max(1, +p.maxWorkers);
      if (p.backlogTarget != null) cfg.backlogTarget = Math.max(1, +p.backlogTarget);
      writeFileSync(cfgPath(lid), JSON.stringify(cfg, null, 2)); return { ok: true, out: 'config 저장' };
    }
    case 'create-product': {   // 대시보드 "+ 새 제품": (선택) Linear 프로젝트 자동 생성 + 라우트 라벨 확보 + product.json (+선택: 버그 루프 스캐폴드)
      const id = String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!id) return { ok: false, out: '제품 id가 필요합니다 (영문 소문자·하이픈)' };
      if (existsSync(`${ROOT}/products/${id}/product.json`)) return { ok: false, out: `이미 있는 제품: ${id}` };
      const name = String(p.name || '').trim() || id;
      const routes = (Array.isArray(p.routes) ? p.routes : []).map(r => ({ label: String((r && r.label) || '').trim(), desc: String((r && r.desc) || '').trim() })).filter(r => r.label);
      let projId = String(p.linearProjectId || '').trim(), projUrl = '';
      try {
        if (!projId) {   // 새 Linear 프로젝트 자동 생성 (결정론 — LLM 불필요)
          if (!LINEAR_KEY) return { ok: false, out: 'Linear API 키가 없어 프로젝트 자동 생성 불가 — ⚙️ 워크스페이스 설정에서 키를 넣거나, 기존 프로젝트 ID를 입력하세요' };
          let teamId = String(p.linearTeamId || '').trim();
          if (!teamId) {
            const t = await linearGQL(`query{ teams(first:20){ nodes{ id name } } }`);
            const ns = t?.teams?.nodes || [];
            if (ns.length !== 1) return { ok: false, out: '팀이 여러 개라 자동 선택 불가 — 팀을 선택해주세요' };
            teamId = ns[0].id;
          }
          const m = await linearGQL(`mutation($in:ProjectCreateInput!){ projectCreate(input:$in){ success project{ id url } } }`, { in: { name, teamIds: [teamId] } });
          if (!m?.projectCreate?.success) return { ok: false, out: 'Linear 프로젝트 생성 실패' };
          projId = m.projectCreate.project.id; projUrl = m.projectCreate.project.url;
        } else {
          const q = await linearGQL(`query($pid:String!){ project(id:$pid){ url } }`, { pid: projId });
          if (!q?.project) return { ok: false, out: '해당 ID의 Linear 프로젝트를 찾을 수 없습니다' };
          projUrl = q.project.url;
        }
        if (routes.length) await ensureRouteLabels(projId, routes.map(r => r.label));
      } catch (e) { return { ok: false, out: 'Linear 준비 실패: ' + e.message }; }
      const prb = String(p.prBase || '').trim() || 'main';
      const pj = { id, name, linearProjectId: projId, linearProjectUrl: projUrl, baseRef: 'origin/' + prb, prBase: prb };
      if (String(p.repo || '').trim()) pj.repo = String(p.repo).trim();
      if (String(p.ompCommand || '').trim()) pj.ompCommand = String(p.ompCommand).trim();
      if (routes.length) pj.triage = { routes: Object.fromEntries(routes.map(r => [r.label, r.desc])), ...(String(p.model || '').trim() ? { model: String(p.model).trim() } : {}), maxPerPass: 5 };
      mkdirSync(`${ROOT}/products/${id}/state`, { recursive: true });
      writeFileSync(`${ROOT}/products/${id}/product.json`, JSON.stringify(pj, null, 2) + '\n');
      let extra = '';
      if (p.scaffoldBug && pj.repo) {   // 버그 자동수정 루프 스캐폴드 (examples/bug-drain 템플릿 · enabled:false — 사람 검토 후 켜기)
        const blid = `${id}-bugs`;
        if (!existsSync(`${LOOPS}/${blid}`)) {
          const tc = readJSON(`${ROOT}/examples/bug-drain/config.json`) || {};
          const bugLabel = (routes.find(r => /bug|버그/i.test(r.label)) || routes[0] || { label: 'Bug' }).label;
          Object.assign(tc, { id: blid, name: `${name} — 버그 수정`, emoji: '🐞', product: id, linearLabel: bugLabel, branchPrefix: `loop-${blid}`, orchestratorWorktree: `${WORKTREE_BASE}/loop-${blid}`, worktreePrefix: `${WORKTREE_BASE}/loop-${blid}`, enabled: false });
          for (const k of ['repo', 'baseRef', 'prBase', 'linearProjectId', 'linearProjectUrl', 'ompCommand']) delete tc[k];
          mkdirSync(`${LOOPS}/${blid}/state`, { recursive: true });
          writeFileSync(cfgPath(blid), JSON.stringify(tc, null, 2) + '\n');
          let ms = readText(`${ROOT}/examples/bug-drain/mission.md`).split('<앱 이름>').join(name);
          if (bugLabel !== 'Bug') ms = ms.split('`Bug`').join('`' + bugLabel + '`');
          writeFileSync(`${LOOPS}/${blid}/mission.md`, ms);
          extra = ` · 🐞 버그 루프 '${blid}' 생성됨(꺼짐 — mission 검토 후 켜세요)`;
        }
      }
      return { ok: true, out: `📦 제품 '${name}' 생성됨${projUrl ? ' · Linear 프로젝트 연결' : ''}${extra}` };
    }
    case 'save-product': {   // 제품 ⚙️ 모달 저장 — product.json 병합(모르는 키 보존) + 새 라우트 라벨 Linear 확보. 저장 즉시 적용(매 호출 재-read).
      const pid2 = String(p.product || '').trim(); const pf = `${ROOT}/products/${pid2}/product.json`;
      const cur = readJSON(pf); if (!cur) return { ok: false, out: '제품 없음: ' + pid2 };
      for (const k of ['name', 'repo', 'ompCommand', 'linearProjectId', 'linearProjectUrl']) if (p[k] !== undefined) { const v = String(p[k]).trim(); if (v) cur[k] = v; else delete cur[k]; }
      if (p.prBase !== undefined) { const v = String(p.prBase).trim(); if (v) { cur.prBase = v; cur.baseRef = 'origin/' + v; } }
      if (Array.isArray(p.routes)) {
        const routes = p.routes.map(r => ({ label: String((r && r.label) || '').trim(), desc: String((r && r.desc) || '').trim() })).filter(r => r.label);
        if (routes.length) {
          cur.triage = Object.assign({ maxPerPass: 5 }, cur.triage || {}, { routes: Object.fromEntries(routes.map(r => [r.label, r.desc])) });
          if (p.model !== undefined) { const m = String(p.model || '').trim(); if (m) cur.triage.model = m; else delete cur.triage.model; }
          if (cur.linearProjectId) { try { await ensureRouteLabels(cur.linearProjectId, routes.map(r => r.label)); } catch (e) { return { ok: false, out: '라벨 확보 실패: ' + e.message }; } }
        } else delete cur.triage;   // 라우트 전부 삭제 = 자동 분류 끔
      }
      writeFileSync(pf, JSON.stringify(cur, null, 2) + '\n');
      return { ok: true, out: '📦 제품 설정 저장 — 즉시 적용' };
    }
    case 'attach-loop': {   // 기존 루프를 제품에 편입: 이슈 이관/라벨링(Linear) → config 연결 + 중복 필드 호이스트. 표준 모델(제품=프로젝트 1개, 라벨 분리)로의 전환기.
      const alid = String(p.loop || '').trim(); if (!alid) return { ok: false, out: 'no loop' };
      const cfg = readJSON(cfgPath(alid)); if (!cfg) return { ok: false, out: 'no config' };
      const prodId = String(p.product || '').trim();
      const prod = readJSON(`${ROOT}/products/${prodId}/product.json`); if (!prod) return { ok: false, out: '제품 없음: ' + prodId };
      const label = String(p.linearLabel || '').trim(); if (!label) return { ok: false, out: '담당 라벨 필요' };
      if (!prod.linearProjectId) return { ok: false, out: '제품에 Linear 프로젝트가 없음 — 제품 ⚙️에서 먼저 설정하세요' };
      const routeLabels = prod.triage && prod.triage.routes ? Object.keys(prod.triage.routes) : [];
      let moved = 0, labeled = 0;
      try {
        await ensureRouteLabels(prod.linearProjectId, [label]);
        const tq = await linearGQL(`query($pid:String!){ project(id:$pid){ teams(first:1){ nodes{ labels(first:250){ nodes{ id name } } } } } }`, { pid: prod.linearProjectId });
        const lbl = tq?.project?.teams?.nodes?.[0]?.labels?.nodes?.find(l => l.name === label);
        if (!lbl) return { ok: false, out: `라벨 '${label}' id 확보 실패` };
        if (cfg.linearProjectId && cfg.linearProjectId !== prod.linearProjectId) {
          // 루프 전용 프로젝트 → 제품 공유 프로젝트로 **전 이슈 이관 + 라벨 부착**. identifier(팀 단위)는 불변이라 worktree/브랜치/탭 매칭이 안 깨진다.
          const iq = await linearGQL(`query($id:String!){ project(id:$id){ issues(first:250){ nodes{ id labels{ nodes{ id } } } } } }`, { id: cfg.linearProjectId });
          for (const n of (iq?.project?.issues?.nodes || [])) {
            const ids = Array.from(new Set([...n.labels.nodes.map(l => l.id), lbl.id]));
            await linearGQL(`mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`, { id: n.id, in: { projectId: prod.linearProjectId, labelIds: ids } });
            moved++;
          }
        } else {
          // 이미 공유 프로젝트(또는 미지정) → **라우트 라벨이 하나도 없는 이슈만** 이 루프 몫으로 라벨링 — 다른 루프 라벨은 불가침.
          const iq = await linearGQL(`query($id:String!){ project(id:$id){ issues(first:250){ nodes{ id labels{ nodes{ id name } } } } } }`, { id: prod.linearProjectId });
          const rset = new Set(routeLabels.length ? routeLabels : [label]);
          for (const n of (iq?.project?.issues?.nodes || [])) {
            if (n.labels.nodes.some(l => rset.has(l.name))) continue;
            await linearGQL(`mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`, { id: n.id, in: { labelIds: [...n.labels.nodes.map(l => l.id), lbl.id] } });
            labeled++;
          }
        }
      } catch (e) { return { ok: false, out: '이슈 이관 실패 — config는 안 바꿨습니다(재시도 안전): ' + e.message }; }
      cfg.product = prodId; cfg.linearLabel = label;
      for (const k of ['repo', 'baseRef', 'prBase', 'ompCommand']) if (cfg[k] != null && prod[k] != null && cfg[k] === prod[k]) delete cfg[k];
      delete cfg.linearProjectId; delete cfg.linearProjectUrl;   // 제품 상속
      cfg.on = Object.assign({}, cfg.on, { linearNew: true });   // 라벨 라우팅 표준 — 새 라벨 이슈 즉시 착수
      writeFileSync(cfgPath(alid), JSON.stringify(cfg, null, 2));
      return { ok: true, out: `🔗 ${alid} → 📦 ${prodId} 편입 완료 (라벨 ${label}${moved ? ` · 이슈 ${moved}건 이관` : ''}${labeled ? ` · 기존 이슈 ${labeled}건 라벨링` : ''} · 새 이슈 즉시착수 on)` };
    }
    case 'save-config-raw': {
      if (!lid) return { ok: false }; let obj = p.config;
      if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (e) { return { ok: false, out: 'JSON 파싱 실패: ' + e.message }; } }
      if (!obj || obj.id !== lid) return { ok: false, out: 'id 불일치/누락 — id는 "' + lid + '" 여야 함' };
      writeFileSync(cfgPath(lid), JSON.stringify(obj, null, 2));
      clearNextFire(lid);
      return { ok: true, out: 'config 저장됨' };
    }
    case 'delete-loop': {
      const id = slugOf(lid || ''); if (!id) return { ok: false, out: 'no loop' };
      const dir = `${LOOPS}/${id}`; if (!dir.startsWith(LOOPS + '/') || !existsSync(dir)) return { ok: false, out: '경로 오류/없음' };
      try { execFileSync(`${ROOT}/bin/cleanup-loop.sh`, [id], { timeout: 60000 }); } catch {}   // rm 전에 worktree·탭 정리(config 살아있는 동안)
      execFile('/bin/rm', ['-rf', dir], () => {}); return { ok: true, out: id + ' loop 삭제됨 (worktree·탭 정리 · Linear는 보존)' };
    }
    case 'build-loop': {
      let desc = p.description; if (!desc) return { ok: false, out: '설명 필요' };
      // 제품 하위 루프 요청이면 빌더(loop-builder.md)에게 제품 컨텍스트를 구조화해 전달 — 프로젝트 새로 안 만들고 상속/라벨 모델을 따르게.
      if (p.product) {
        const prod = readJSON(`${ROOT}/products/${p.product}/product.json`);
        if (!prod) return { ok: false, out: '제품 없음: ' + p.product };
        const routes = prod.triage && prod.triage.routes ? Object.keys(prod.triage.routes).join(', ') : '(없음)';
        desc += `\n\n[제품 컨텍스트 — 지시] 이 루프는 제품 '${p.product}'(products/${p.product}/product.json, repo ${prod.repo || '?'}) 하위 루프다. config에 "product":"${p.product}"를 넣고 repo·baseRef·prBase·ompCommand·linearProjectId/Url은 넣지 마라(제품 상속). **Linear 프로젝트를 새로 만들지 마라** — 제품 공유 프로젝트를 쓴다. "linearLabel"을 정해 넣어라(기존 라우트: ${routes}${p.linearLabel ? ` · 사용자가 지정한 라벨: ${p.linearLabel}` : ''} — 새 라벨이면 제품 product.json의 triage.routes에도 설명과 함께 추가). "on":{"linearNew":true} 포함.`;
      }
      const b64 = Buffer.from(String(desc), 'utf8').toString('base64');
      const r = await sh('/bin/zsh', [`${ROOT}/bin/spawn-panel.sh`, ROOT, `./bin/build-loop.sh ${b64}`, '🤖 loop builder'], 30000);
      const m = (r.out || '').match(/workspace:\d+/);
      if (!r.ok || !m) return { ok: false, out: r.out || '빌더 시작을 확인하지 못했습니다.' };
      reorderBottom(m[0]); await sh(CMUX, ['select-workspace', '--workspace', m[0]]);
      activateCmux(); return { ok: true, out: '🤖 루프 빌더 시작 — 새 탭에서 몇 가지 선택지에 답하면 완성됩니다("다 맡김" 옵션도 있음). 완료되면 사이드바에 loop가 뜹니다.' };
    }
    case 'create-loop': {
      const id = slugOf(p.id || ''); if (!id) return { ok: false, out: 'id 필요' };
      if (existsSync(`${LOOPS}/${id}`)) return { ok: false, out: '이미 존재: ' + id };
      const product = p.product && readJSON(`${ROOT}/products/${p.product}/product.json`);
      const refs = !product && (!p.baseRef || !p.prBase) ? defaultGitRefs(p.repo) : {};
      if (!refs) return { ok: false, out: 'Git 프로젝트를 선택하세요. 기본 브랜치를 찾지 못하면 baseRef와 prBase를 명시해야 합니다.' };
      mkdirSync(`${LOOPS}/${id}/state`, { recursive: true });
      const cfg = {
        id, name: p.name || id, emoji: p.emoji || '🔁', repo: p.repo || '',
        baseRef: p.baseRef || refs.baseRef, prBase: p.prBase || refs.prBase, branchPrefix: 'loop-' + id,
        orchestratorWorktree: p.orchestratorWorktree || `${WORKTREE_BASE}/loop-${id}`,
        worktreePrefix: p.worktreePrefix || `${WORKTREE_BASE}/loop-${id}`,
        linearProjectId: p.linearProjectId || '', linearProjectUrl: p.linearProjectUrl || '',
        maxWorkers: +p.maxWorkers || 2, schedule: { startAt: p.startAt || null, intervalSec: Math.max(60, Math.round((+p.intervalMin || 120) * 60)) }, enabled: false,
      };
      if (product) {
        // 제품 하위 루프: 공통 필드는 상속 — 빈 문자열로 남기면 상속(cfgval의 v==null 판정)이 막히므로 키 자체를 지운다.
        cfg.product = String(p.product);
        if (String(p.linearLabel || '').trim()) cfg.linearLabel = String(p.linearLabel).trim();
        for (const k of ['repo', 'baseRef', 'prBase', 'linearProjectId', 'linearProjectUrl']) if (!String(p[k] || '').trim()) delete cfg[k];
        cfg.on = { linearNew: true };
      }
      writeFileSync(cfgPath(id), JSON.stringify(cfg, null, 2));
      writeFileSync(`${LOOPS}/${id}/mission.md`, p.mission || '(이 루프의 임무를 정의하세요)');
      return { ok: true, out: 'loop 생성: ' + id + ' (enabled=false, 켜려면 toggle)' };
    }
    default: return { ok: false, out: 'unknown: ' + a };
  }
}

function sessionText(u) {
  if (u.searchParams.get('bot')) {   // Telegram 봇이 주고받은 로그 (state/bot-log.jsonl) — 사람이 읽게 포맷
    const lines = readText(`${GSTATE}/bot-log.jsonl`).split('\n').filter(Boolean).slice(-300);
    if (!lines.length) return '(봇 로그 없음 — Telegram 봇이 아직 주고받은 기록이 없습니다. loops.env에 토큰 저장 후 "봇 시작")';
    return lines.map(l => { try { const e = JSON.parse(l); const t = new Date(e.ts * 1000).toLocaleTimeString(); return `${t}  ${e.dir === 'in' ? '▸ 나 ' : '◂ 봇 '} ${e.text}`; } catch { return l; } }).join('\n');
  }
  if (u.searchParams.get('ref')) { try { return execFileSync(CMUX, ['read-screen', '--workspace', u.searchParams.get('ref'), '--lines', '300'], { encoding: 'utf8', timeout: 5000 }); } catch (e) { return '(read-screen 실패)'; } }
  if (u.searchParams.get('dispatcher')) return readText(`${GSTATE}/dispatcher.log`).split('\n').slice(-300).join('\n');
  const lid = u.searchParams.get('loop'); if (lid) return readText(`${LOOPS}/${lid}/state/run.log`).split('\n').slice(-300).join('\n');
  return '(no ref/loop)';
}
function promptText(u) { const lid = u.searchParams.get('loop'); if (!lid) return ''; if (u.searchParams.get('learnings')) return readText(`${LOOPS}/${lid}/state/learnings.md`); if (u.searchParams.get('vision')) return readText(`${LOOPS}/${lid}/vision.md`); return readText(`${LOOPS}/${lid}/mission.md`); }

// 원격 노출 인증 게이트: 로컬 loopback(cmux 패널) 직접 접속만 무인증. 그 외(터널 XFF·tailscale IP 등
// 비-loopback 원격)는 LOOPS_REMOTE_AUTH="user:pass"(loops.env) 설정 시 Basic auth 요구.
// 미설정이면 게이트 비활성 = 로컬 전용 기본 동작 유지(tailnet 자체가 사설 경계라 비밀번호는 선택).
const REMOTE_AUTH = ENV.LOOPS_REMOTE_AUTH || process.env.LOOPS_REMOTE_AUTH || '';
function viaProxy(req) { return !!(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-host']); }
function isLoopback(req) { const a = (req.socket && req.socket.remoteAddress) || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
function authOK(req) {
  if (req.headers['x-palace-engine-proxy']) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return !!HOST_TOKEN && !!m && m[1] === HOST_TOKEN;
  }
  if (!REMOTE_AUTH) return true;
  if (isLoopback(req) && !viaProxy(req)) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  try { return Buffer.from(m[1], 'base64').toString() === REMOTE_AUTH; } catch { return false; }
}

function handler(req, res) {
  const authority = String(req.headers.host || '').toLowerCase();
  let trustedHost = false;
  try {
    const host = new URL(`http://${authority}`);
    trustedHost = !host.username && !host.password && (
      ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) ||
      (!!remoteUrl && new URL(remoteUrl).host.toLowerCase() === authority)
    );
  } catch {}
  const origin = req.headers.origin;
  const ownOrigin = `${req.socket.encrypted ? 'https' : 'http'}://${authority}`;
  if (!trustedHost || (req.method === 'POST' && origin && origin !== ownOrigin)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('다른 웹사이트에서 시작한 제어 요청은 허용하지 않습니다.');
    return;
  }
  const u = new URL(req.url, 'http://localhost');
  if (!authOK(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="loops dashboard"', 'content-type': 'text/plain; charset=utf-8' }); res.end('인증 필요'); return; }
  if (req.method === 'GET' && u.pathname === '/api/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, pid: process.pid })); return; }
  // HTML은 요청마다 fresh 읽기 → dashboard.html 편집 시 새로고침만 하면 즉시 반영 (서버 재시작 불필요)
  if (req.method === 'GET' && u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(readText(`${ROOT}/dashboard.html`) || '<h1>dashboard.html 없음</h1>'); return; }
  if (req.method === 'GET' && u.pathname === '/api/projects') { const projects = readJSON(`${GSTATE}/palace-projects.json`); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(projects) ? projects : [])); return; }
  // 벤더링된 정적 에셋(Oat UI 등) — 무빌드. 파일명 화이트리스트로 경로 탈출 차단.
  if (req.method === 'GET' && u.pathname.startsWith('/vendor/')) { const name = u.pathname.slice(8); if (!/^[a-zA-Z0-9._-]+$/.test(name)) { res.writeHead(400); res.end('bad'); return; } const body = readText(`${ROOT}/vendor/${name}`); if (!body) { res.writeHead(404); res.end('not found'); return; } const ct = name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream'; res.writeHead(200, { 'content-type': ct, 'cache-control': 'max-age=3600' }); res.end(body); return; }
  // loop= 는 "이 루프만 이슈/피드를 실어달라". 안 주면(옛 클라이언트·직접 호출) 전부 실어 준다.
  if (req.method === 'GET' && u.pathname === '/api/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(status(u.searchParams.get('loop') || null))); return; }
  if (req.method === 'GET' && u.pathname === '/api/linear/teams') {   // "+ 새 제품" 모달의 팀 선택용 (키 없거나 실패 → 빈 목록 + error 필드로 loud)
    linearGQL(`query{ teams(first:20){ nodes{ id name } } }`)
      .then(t => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ teams: t?.teams?.nodes || [] })); })
      .catch(e => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ teams: [], error: e.message })); });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/api/session') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(sessionText(u)); return; }
  if (req.method === 'GET' && u.pathname === '/api/mission') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(promptText(u)); return; }
  // ?effective=1 → 제품 상속까지 반영한 값(모달의 placeholder 전용 — 저장되는 값이 아니다).
  // 기본(raw)은 그대로 유지: 저장 폼이 effective를 실제 value로 들고 있으면 제품 값이 루프 config에 복사돼 상속이 끊긴다.
  if (req.method === 'GET' && u.pathname === '/api/config') {
    const lid = u.searchParams.get('loop'); const raw = readJSON(cfgPath(lid)) || {};
    let out = raw;
    if (u.searchParams.get('effective') === '1') { try { out = mergeProduct(ROOT, JSON.parse(JSON.stringify(raw))); } catch { out = raw; } }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out, null, 2)); return;
  }
  if (req.method === 'GET' && u.pathname === '/api/remote') {   // 원격 모달용 라이브 상태(tailscale CLI 조회 포함 — status()와 달리 매 폴링엔 안 씀)
    const info = tailscaleInfo(); const url = remoteUrl || computeRemoteUrl(info);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ on: remoteServers.length > 0, wanted: remoteWanted, url, port: PORT, secure: true, authRequired: !!REMOTE_AUTH, pushSubs: push.subs.length, tailscale: { installed: info.installed, running: info.running, dnsName: info.dnsName, ips: info.ips, error: info.error || '' } }));
    return;
  }
  // ── PWA (홈화면 추가 + 웹푸시). 상대 URL로 로컬 / 와 Palace /engine/에서 모두 같은 스코프를 쓴다. ──
  if (req.method === 'GET' && u.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); res.end(readText(`${ROOT}/vendor/sw.js`) || '// sw 없음'); return; }
  if (req.method === 'GET' && u.pathname === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
    res.end(JSON.stringify({ name: 'Loops', short_name: 'Loops', start_url: './', scope: './', display: 'standalone', background_color: '#0a0e13', theme_color: '#0d131c', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] }));
    return;
  }
  if (req.method === 'GET' && (u.pathname === '/icon-192.png' || u.pathname === '/icon-512.png')) {
    let buf; try { buf = readFileSync(`${ROOT}/vendor${u.pathname}`); } catch { res.writeHead(404); res.end('no icon'); return; }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }); res.end(buf); return;
  }
  if (req.method === 'GET' && u.pathname === '/api/push/key') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ key: push.vapid.publicKey })); return; }
  if (req.method === 'GET' && u.pathname === '/api/push/prefs') {   // 루프별 알림 on/off (per-project) — muted 맵 + 루프 목록
    const loops = listLoopIds().map(id => { const c = readJSON(cfgPath(id)) || {}; return { id, name: c.name || id, emoji: c.emoji || '🔁' }; });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ subs: push.subs.length, muted: push.muted, loops })); return;
  }
  if (req.method === 'POST' && (u.pathname === '/api/push/subscribe' || u.pathname === '/api/push/unsubscribe' || u.pathname === '/api/push/test' || u.pathname === '/api/push/mute')) {
    let b = ''; req.on('data', d => b += d); req.on('end', async () => {
      let p = {}; try { p = JSON.parse(b || '{}'); } catch {}
      let out = { ok: true };
      if (u.pathname === '/api/push/subscribe') {
        if (p && p.endpoint && p.keys && p.keys.p256dh && p.keys.auth) { if (!push.subs.some(s => s.endpoint === p.endpoint)) { push.subs.push({ endpoint: p.endpoint, keys: p.keys }); savePush(); } out = { ok: true, count: push.subs.length }; }
        else out = { ok: false, out: 'bad subscription' };
      } else if (u.pathname === '/api/push/unsubscribe') {
        const before = push.subs.length; push.subs = push.subs.filter(s => s.endpoint !== (p && p.endpoint)); if (push.subs.length !== before) savePush(); out = { ok: true, count: push.subs.length };
      } else if (u.pathname === '/api/push/mute') {
        if (p && p.loop) { if (p.muted) push.muted[p.loop] = true; else delete push.muted[p.loop]; savePush(); }   // muted=true 끔 / false 켬
        out = { ok: true, muted: push.muted };
      } else { const r = await sendPush({ title: 'Loops', body: '🔔 푸시 알림이 정상 동작합니다.', tag: 'test' }); out = { ok: true, sent: r.sent }; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/api/control') {
    let b = ''; req.on('data', d => b += d); req.on('end', async () => { let p = {}; try { p = JSON.parse(b || '{}'); } catch {} const r = await control(p.action, p); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); }); return;
  }
  res.writeHead(404); res.end('not found');
}

// ── Tailscale 원격(폰) 노출 — HTTPS ────────────────────────────────────────
// `tailscale serve`를 건드리지 않는다(사용자가 이미 다른 포트로 쓸 수 있음 → 매핑 덮어쓰기 위험).
// 대신 `tailscale cert`로 이 노드의 tailnet 정식 인증서를 받아, 대시보드 서버가 tailscale IP(들)에
// **HTTPS** 리스너를 직접 연다: 127.0.0.1(항상, HTTP) + 100.x/fd7a(원격 켤 때만, HTTPS).
// HTTPS가 필수인 이유: iOS/Android 웹푸시는 secure context에서만 동작(웹푸시 알림 = 이 HTTPS 위에서).
// 0.0.0.0가 아니라 tailscale IP에만 바인딩 → LAN 노출 없이 tailnet 전용(전송은 TLS + WireGuard).
let remoteServers = [];                                   // 열려 있는 tailscale-IP HTTPS 리스너들(v4/v6)
let remoteUrl = '';                                       // 마지막으로 연 원격 URL(status 폴링에 CLI 안 쓰도록 캐시)
let remoteWanted = /^(1|true|on|yes)$/i.test(String(ENV.LOOPS_REMOTE || process.env.LOOPS_REMOTE || ''));
const CERT_CRT = `${GSTATE}/ts-remote.crt`, CERT_KEY = `${GSTATE}/ts-remote.key`;
function tailscaleInfo() {
  try {
    const j = JSON.parse(execFileSync('tailscale', ['status', '--json'], { timeout: 4000, encoding: 'utf8' }));
    const ips = (j.Self && j.Self.TailscaleIPs) || [];
    const dnsName = String((j.Self && j.Self.DNSName) || '').replace(/\.$/, '');
    return { installed: true, running: j.BackendState === 'Running', ips, dnsName, error: '' };
  } catch (e) {
    const missing = /ENOENT/.test(e.message || '');       // tailscale 바이너리 부재
    return { installed: !missing, running: false, ips: [], dnsName: '', error: missing ? 'tailscale 미설치' : e.message };
  }
}
function computeRemoteUrl(info) { return info.dnsName ? `https://${info.dnsName}:${PORT}/` : ''; }   // 인증서 SAN = MagicDNS fqdn이어야 유효 → dnsName 필수
// tailnet 정식 인증서 확보(fresh면 재사용, 아니면 `tailscale cert` 재발급). 반환 {cert,key} 또는 throw.
function ensureCert(fqdn) {
  let fresh = false;
  try { fresh = existsSync(CERT_CRT) && existsSync(CERT_KEY) && (Date.now() - statSync(CERT_CRT).mtimeMs) < 30 * 864e5; } catch {}
  if (!fresh) {
    execFileSync('tailscale', ['cert', '--cert-file', CERT_CRT, '--key-file', CERT_KEY, fqdn], { timeout: 60000, stdio: ['ignore', 'ignore', 'pipe'] });
  }
  return { cert: readFileSync(CERT_CRT), key: readFileSync(CERT_KEY) };
}
function closeRemote() { for (const s of remoteServers) { try { s.close(); } catch {} } remoteServers = []; }
function openRemote() {
  const info = tailscaleInfo();
  if (!info.installed) return { ok: false, out: 'tailscale가 설치돼 있지 않습니다 → https://tailscale.com/download' };
  if (!info.running) return { ok: false, out: 'tailscale가 실행/로그인 상태가 아닙니다 — 터미널에서 `tailscale up` 후 다시 시도하세요.' };
  if (!info.ips.length) return { ok: false, out: 'tailscale IP를 찾지 못했습니다 (`tailscale status` 확인).' };
  if (!info.dnsName) return { ok: false, out: 'MagicDNS 이름이 없어 HTTPS 인증서를 발급할 수 없습니다 — tailnet 관리자에서 MagicDNS + HTTPS Certificates 를 켜세요.' };
  let creds;
  try { creds = ensureCert(info.dnsName); }
  catch (e) { const m = String(e.stderr || e.message || e); return { ok: false, out: 'tailscale cert 발급 실패 — tailnet 관리자에서 HTTPS Certificates 를 켜세요. (' + m.trim().split('\n').pop() + ')' }; }
  closeRemote();                                          // 재-open 멱등(IP/인증서 변경 대비)
  let bound = 0;
  for (const ip of info.ips) {
    try {
      const s = https.createServer({ cert: creds.cert, key: creds.key }, handler);
      s.on('error', e => console.error(`원격 리스너 ${ip}:${PORT} 오류:`, e.message));   // EADDRNOTAVAIL 등 비동기 오류 — 나머지 IP는 계속
      s.listen(PORT, ip, () => console.log(`Loops dashboard 원격(HTTPS) → https://${ip.includes(':') ? `[${ip}]` : ip}:${PORT}`));
      remoteServers.push(s); bound++;
    } catch (e) { console.error(`원격 listen ${ip} 실패:`, e.message); }
  }
  if (!bound) return { ok: false, out: 'tailscale 인터페이스 바인딩 실패 (로그 확인).' };
  remoteUrl = computeRemoteUrl(info); remoteWanted = true;
  try { setEnvVar(ROOT, 'LOOPS_REMOTE', '1'); } catch (e) { console.error('LOOPS_REMOTE 영속화 실패:', e.message); }
  return { ok: true, url: remoteUrl, out: `📱 원격 켜짐 · ${remoteUrl}` };
}
function disableRemote() {
  closeRemote(); remoteUrl = ''; remoteWanted = false;
  try { setEnvVar(ROOT, 'LOOPS_REMOTE', '0'); } catch (e) { console.error('LOOPS_REMOTE 영속화 실패:', e.message); }
  return { ok: true, out: '원격 꺼짐' };
}

// ── 웹푸시(VAPID) — 의존성 0(bin/webpush.mjs). state/push.json에 vapid 키·구독·seen 영속 ──
const PUSH_FILE = `${GSTATE}/push.json`;
const PUSH_SUBJECT = ENV.LOOPS_PUSH_SUBJECT || process.env.LOOPS_PUSH_SUBJECT || 'https://github.com/';   // VAPID sub — 잘 형성된 https/mailto면 됨(해석될 필요 없음)
function loadPush() { const p = readJSON(PUSH_FILE) || {}; if (!p.vapid) p.vapid = generateVapidKeys(); p.subs = p.subs || []; p.seen = p.seen || {}; p.muted = p.muted || {}; return p; }   // muted: {loopId:true} = 그 루프 알림 끔
let push = loadPush();
function savePush() { try { mkdirSync(GSTATE, { recursive: true }); writeFileSync(PUSH_FILE, JSON.stringify(push, null, 2)); } catch (e) { console.error('push.json 저장 실패:', e.message); } }
if (!existsSync(PUSH_FILE)) savePush();                   // 최초 부팅에 vapid 키 확정
async function sendPush(payload) {
  if (!push.subs.length) return { sent: 0 };
  const body = JSON.stringify(payload);
  const dead = [];
  await Promise.all(push.subs.map(async (sub) => {
    try {
      const r = await sendNotification(sub, body, { subject: PUSH_SUBJECT, publicKey: push.vapid.publicKey, privateKey: push.vapid.privateKey });
      if (r.statusCode === 404 || r.statusCode === 410) dead.push(sub.endpoint);          // 구독 영구 만료 → 정리
      else if (r.statusCode >= 400) console.error(`push ${new URL(sub.endpoint).host} → ${r.statusCode}: ${String(r.body).slice(0, 200)}`);
    } catch (e) { console.error(`push 실패 ${(() => { try { return new URL(sub.endpoint).host; } catch { return '?'; } })()}:`, e.message); }
  }));
  if (dead.length) { push.subs = push.subs.filter(s => !dead.includes(s.endpoint)); savePush(); }
  return { sent: push.subs.length };
}
// 주의 신호(🔴 human-gate·rework-exhausted·stuck·CI 실패 등) diff → 새 신호만 폰으로 push. 첫 폴링(warm 전)은 무음 시드.
const PUSH_LABEL = { 'human-gate': '🔴 사람 판단 필요', 'rework-exhausted': '⚠️ 자동반영 포기 — 사람 필요', 'ci-failed': '❌ CI 실패', 'pr-review': '👀 리뷰 요청', 'pr-closed': '🚪 PR 닫힘(정리 대상)', 'merge-wedged': '🔀 배달 후 정체 — 머지 확인 필요', stuck: '🧟 stuck(자가복구 실패)', wedged: '🧊 wedged(멈춤)', 'stalled-worker': '💤 워커 정지' };
let pushWarm = false;
async function pushTick() {
  if (!push.subs.length) return;                          // 구독 0 → 크립토/폴링 생략
  let cur;
  try { cur = status(); } catch (e) { console.error('pushTick status 실패:', e.message); return; }
  const now = {}, fresh = [];
  for (const loop of cur.loops || []) for (const iss of loop.issues || []) {
    if (!iss.attention) continue;
    const key = `${loop.id}|${iss.id}|${iss.attention}`;
    now[key] = true;   // muted 루프도 seen엔 기록(음소거 해제 시 과거분 폭탄 방지) — 단 push는 안 함
    if (!push.seen[key] && !push.muted[loop.id]) fresh.push({ loop, iss, att: iss.attention });
  }
  push.seen = now; savePush();                            // seen = 현재 주의집합(사라진 키는 자동 프루닝 → 재발생 시 재알림)
  if (!pushWarm) { pushWarm = true; return; }             // 프로세스 첫 tick은 무음 시드(과거분 폭탄 방지)
  for (const f of fresh) {
    const label = PUSH_LABEL[f.att] || f.att;
    await sendPush({ title: `${loop_emoji(f.loop)} ${f.loop.name || f.loop.id}`, body: `${label}\n${f.iss.title || f.iss.id}`, tag: `${f.loop.id}:${f.iss.id}`, loop: f.loop.id });
  }
}
function loop_emoji(l) { return l.emoji || '🔁'; }

const server = http.createServer(handler);
server.listen(PORT, '127.0.0.1', () => console.log(`Loops dashboard → http://localhost:${PORT}`));
if (remoteWanted) { const r = openRemote(); console.log(r.ok ? `Loops dashboard 원격(폰) → ${r.url}` : `Loops dashboard 원격 자동기동 실패: ${r.out}`); }   // LOOPS_REMOTE=1 이면 부팅 시 자동 재개
refreshPRs(); setInterval(refreshPRs, 60000);
refreshLinear(); setInterval(refreshLinear, 60000);   // 라이브 Linear 상태(리퍼와 동일한 권위 신호) — direct 모드의 유일한 완료 신호
setInterval(() => { pushTick().catch(e => console.error('pushTick:', e.message)); }, 20000);   // 20s마다 주의신호 diff → 폰 push

// 자기 탭 기록(state/panel.dashboard.ref) — supervisor panels sweep이 "진짜 대시보드 탭"을 식별해 나머지 📊 잔재
// (cmux 재시작 복원 셸 등)를 회수하는 근거. node --watch 재기동마다 재기록(같은 PTY라 동일 ref).
// identify 실패(비 cmux 컨텍스트·플레이크) → 파일 제거 + 로그 — sweep은 파일 없으면 📊 정리를 skip(판정불가=skip 원칙).
try {
  const j = JSON.parse(execFileSync(CMUX, ['identify'], { encoding: 'utf8', timeout: 4000 }));
  const ref = j && j.caller && j.caller.workspace_ref;
  if (!/^workspace:\d+$/.test(ref || '')) throw new Error('caller.workspace_ref 없음');
  writeFileSync(`${GSTATE}/panel.dashboard.ref`, ref);
} catch (e) {
  try { execFileSync('/bin/rm', ['-f', `${GSTATE}/panel.dashboard.ref`]); } catch {}
  console.error('panel.dashboard.ref 기록 실패(sweep은 📊 정리 skip):', e.message);
}
