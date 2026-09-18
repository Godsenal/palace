#!/usr/bin/env node
// 브라우저 실측기 — ego-browser(ego lite)를 감싸 한 URL의 **결정론적 결함 신호**를 JSON으로 뽑는다.
// 수집: HTTP 4xx/5xx · 로딩 실패 요청 · JS 예외/unhandledrejection · console.error · 렌더 결과(root/텍스트) · 스크린샷.
//
// 왜 결정론 층인가: 판정은 LLM(verifier/orchestrator)이 하되 **측정은 쉘이 한다**.
// LLM에게 "브라우저로 확인해봐"라고 시키면 무엇을 어떻게 봤는지가 run마다 달라져 근거가 재현되지 않는다.
//
// ⚠️ 무음 폴백 금지: ego-browser 부재·스크립트 실패·결과 마커 부재는 전부 비0 종료 + stderr 설명.
//    "측정 못 했는데 조용히 빈 결과" 가 이 파일에서 가장 위험한 실패다(검증이 통과로 둔갑한다).
//
// usage: measure-browser.mjs <url> [--login <file.json>] [--wait <sec>] [--selector <css>]
//                                  [--screenshot <path>] [--space <name>] [--nav-timeout <sec>]
// --login <file.json>: { "origin": "https://…", "localStorage": { "<key>": "<value>" } }
//   대상 origin에 먼저 진입해 localStorage를 심고 나서 URL을 연다(앱의 dev 테스트-로그인 주입 경로).
//   origin 생략 시 대상 URL의 origin을 쓴다. 값은 문자열 그대로 setItem — 앱 스키마는 이 스크립트가 모른다.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const url = argv[0];
if (!url || url.startsWith('-')) {
  console.error('usage: measure-browser.mjs <url> [--login <file>] [--wait <sec>] [--selector <css>] [--screenshot <path>] [--space <name>] [--nav-timeout <sec>]');
  process.exit(2);
}
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v == null || v.startsWith('--')) { console.error(`measure-browser: --${name} 에 값이 없다`); process.exit(2); }
  return v;
};
// --wait 은 "렌더 준비까지 **최대** 대기(초)"다(고정 sleep이 아니다). 시간 내 준비되면 즉시 진행.
const waitSec = Number(flag('wait', '30'));
// 렌더 판정 하한 — 스플래시(수천 자)와 실제 화면(수만 자)을 가른다. 대상 앱마다 다르면 config에서 올린다.
const minRoot = Number(flag('min-root', '20000'));
const navTimeout = Number(flag('nav-timeout', '40'));
const selector = flag('selector', '');
const shotPath = flag('screenshot', '');
const space = flag('space', 'loops-measure');
const loginFile = flag('login', '');
// 뷰포트: webview/모바일 대상을 데스크톱 폭으로 재면 사용자가 보는 레이아웃이 아니다.
// 기본은 에뮬레이션 없음(빈 값) — 대상이 모바일이면 config/CLI에서 명시한다. 예: --viewport 390x844
const viewportArg = flag('viewport', '');
let viewport = null;
if (viewportArg) {
  const m = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(viewportArg);
  if (!m) { console.error(`measure-browser: --viewport 형식은 <w>x<h>[@<scale>] (예: 390x844@3) — 받은 값: ${viewportArg}`); process.exit(2); }
  viewport = { width: +m[1], height: +m[2], deviceScaleFactor: m[3] ? +m[3] : 3, mobile: true };
}

let login = null;
if (loginFile) {
  // 읽기 실패는 그대로 던진다 — 로그인 없이 "빈 화면"을 정상 측정으로 기록하는 게 최악이다.
  login = JSON.parse(readFileSync(loginFile, 'utf8'));
  if (!login.localStorage || typeof login.localStorage !== 'object') {
    console.error(`measure-browser: login 파일에 localStorage 객체가 없다 (${loginFile})`);
    process.exit(2);
  }
}
const loginOrigin = login ? (login.origin || new URL(url).origin) : '';

// ego-browser의 node 런타임은 **ESM**이고 부모 프로세스의 env를 상속하지 않는다 —
// 값은 전부 이 스크립트가 JSON.stringify로 소스에 박아 넣는다(그래서 stdin으로만 전달, 인자 노출 없음).
const script = `
const RESULT = {};
const task = await useOrCreateTaskSpace(${JSON.stringify(space)});
await openOrReuseTab('about:blank', { wait: true, timeout: 20 });

// 내비게이션을 살아남는 훅 — addScriptToEvaluateOnNewDocument는 문서마다 새로 주입된다.
// (페이지 로드 후 js()로 심으면 그 다음 내비게이션에서 통째로 사라져 항상 "에러 0건"이 나온다.)
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: \`
  window.__diag = { jsErrors: [], consoleErrors: [], apiErrors: [], notes: [] };
  // GraphQL은 실패해도 **HTTP 200**이고 본문 errors[]에만 실패가 담긴다 —
  // 상태코드만 보면 "에러 0건 + 화면은 스켈레톤" 이라는 최악의 무음 실패를 놓친다. 그래서 fetch를 감싼다.
  const _fetch = window.fetch;
  window.fetch = function () {
    const args = arguments;
    const p = _fetch.apply(this, args);
    try {
      const reqUrl = String((args[0] && args[0].url) || args[0] || '').slice(0, 200);
      p.then((res) => {
        const ct = (res.headers && res.headers.get('content-type')) || '';
        if (!ct.includes('json')) return;
        res.clone().text().then((t) => {
          if (!t.includes('"errors"')) return;
          try {
            const j = JSON.parse(t);
            if (Array.isArray(j.errors) && j.errors.length) {
              __diag.apiErrors.push({ url: reqUrl, status: res.status, messages: j.errors.map((e) => String(e && e.message).slice(0, 200)).slice(0, 5) });
            }
          } catch (e) { __diag.notes.push('api body parse 실패: ' + reqUrl) }
        }).catch(() => __diag.notes.push('api body read 실패: ' + reqUrl));
      }).catch(() => {});
    } catch (e) { __diag.notes.push('fetch 훅 실패: ' + String(e && e.message)) }
    return p;
  };
  addEventListener('error', e => __diag.jsErrors.push(String(e.message || e.type).slice(0, 300)));
  addEventListener('unhandledrejection', e => __diag.jsErrors.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason).slice(0, 300)));
  const _err = console.error;
  console.error = function () { try { __diag.consoleErrors.push(Array.from(arguments).map(String).join(' ').slice(0, 300)) } catch {} return _err.apply(this, arguments) };
\` });
await cdp('Network.enable', {});
// ⚠️ HTTP 캐시 비활성 — 세션이 재사용되면 **옛 index.html이 캐시에서** 나오고, 그 빌드의 lazy 청크는
// 이미 배포에서 사라져 404가 무더기로 뜬다(실측: 55건 404 + "일시적인 오류" 화면 = 전부 이 아티팩트).
// QA가 재야 하는 건 "지금 새로 들어온 사용자가 받는 것"이므로 매 측정이 현재 빌드를 실제로 받아야 한다.
await cdp('Network.setCacheDisabled', { cacheDisabled: true });
${viewport ? `await cdp('Emulation.setDeviceMetricsOverride', ${JSON.stringify(viewport)});` : ''}

${login ? `
// dev 테스트-로그인 주입: origin에 먼저 진입해야 그 origin의 localStorage에 쓸 수 있다.
await gotoUrl(${JSON.stringify(loginOrigin)});
await wait(2);
const __items = ${JSON.stringify(login.localStorage)};
await js('(' + function (items) {
  for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
  return 'ok';
}.toString() + ')(' + JSON.stringify(__items) + ')');
` : ''}

// ⚠️ 탭을 재사용하면 **직전 문서가 아직 살아 있는 채로** 첫 폴링이 돌아 "이미 렌더됨"으로 오판한다
// (같은 URL을 반복 측정하면 URL 비교로도 못 거른다). 빈 문서로 한 번 끊어 새 문서를 강제한다.
await gotoUrl('about:blank');
// 여기까지의 이벤트(로그인 사전-진입·about:blank)를 **버린다** — 안 버리면 요청 수·HTTP 에러가
// 대상 라우트의 것으로 잘못 집계된다(로그인 주입이 있는 루프에서 특히 크게 어긋난다).
await drainEvents();
await gotoUrl(${JSON.stringify(url)});

// ⚠️ 고정 sleep 금지 — 같은 URL이 12초엔 스켈레톤, 20초엔 정상 렌더로 나왔다(실측).
// 고정 대기로 "안 뜬다"를 판정하면 느린 run마다 거짓 양성이 쏟아진다. 준비 조건을 **폴링**하고,
// 걸린 시간(readyMs)을 남겨 "렌더 여부"와 "느림"을 분리한다.
// 준비 조건에 **"지금 문서가 대상 경로인가"** 를 반드시 포함한다 — gotoUrl은 내비게이션 커밋 전에 돌아올 수 있어서,
// 크기 조건만 보면 직전 문서(로그인 진입 시 뜬 홈, 이전 라우트 측정의 잔상)를 "렌더 완료"로 오판한다.
// 실측: 같은 태스크 스페이스를 연속으로 쓰면 search-region·faq가 둘 다 홈의 rootLen(79409)을 보고했다.
const READY_JS = '(' + function (sel, minRoot, wantPath) {
  const here = location.pathname.replace(/\\/$/, '');
  if (here !== wantPath.replace(/\\/$/, '')) return JSON.stringify({ ok: false, rootLen: 0, textLen: 0, path: here });
  const root = document.getElementById('root') || document.querySelector('[data-reactroot]') || document.body;
  const rootLen = root ? root.innerHTML.length : 0;
  const textLen = document.body ? document.body.innerText.trim().length : 0;
  const selOk = sel ? !!document.querySelector(sel) : true;
  return JSON.stringify({ ok: rootLen >= minRoot && textLen >= 20 && selOk, rootLen, textLen, path: here });
}.toString() + ')(' + JSON.stringify(${JSON.stringify(selector)}) + ',' + JSON.stringify(${JSON.stringify(minRoot)}) + ',' + JSON.stringify(${JSON.stringify(new URL(url).pathname)}) + ')';
const __t0 = Number(await js('Date.now()'));
let __ready = null, __last = null;
for (let i = 0; i < ${Math.ceil(waitSec / 0.5)}; i++) {
  __last = JSON.parse(await js(READY_JS));
  if (__last.ok) { __ready = Number(await js('Date.now()')) - __t0; break }
  await wait(0.5);
}
RESULT.readyMs = __ready;
// 미달로 끝났을 때 "왜"를 남긴다 — 경로가 안 바뀌었나(리다이렉트·내비게이션 실패), 크기가 모자랐나.
if (__ready == null) RESULT.readyLastCheck = __last;
RESULT.readyTimeoutSec = ${JSON.stringify(waitSec)};
// 준비된 뒤에도 잠깐 더 둔다 — 렌더 직후 터지는 에러·늦은 API 응답을 놓치지 않기 위해.
await wait(3);

// CDP 원시 이벤트에서 요청별 상태코드/실패를 집계한다(브라우저가 본 그대로 — 추정 없음).
const events = (await drainEvents()) || [];
const httpErrors = [], failed = [];
for (const e of events) {
  if (e.method === 'Network.responseReceived') {
    const r = e.params && e.params.response;
    if (r && r.status >= 400) httpErrors.push({ status: r.status, url: String(r.url).slice(0, 300), type: e.params.type });
  } else if (e.method === 'Network.loadingFailed') {
    const p = e.params || {};
    if (!p.canceled) failed.push({ error: String(p.errorText || '').slice(0, 120), type: p.type });
  }
}
RESULT.requests = events.filter(e => e.method === 'Network.responseReceived').length;
RESULT.httpErrors = httpErrors;
RESULT.failedRequests = failed;

const diag = JSON.parse(await js('JSON.stringify(window.__diag || null)'));
if (!diag) throw new Error('__diag 부재 — addScriptToEvaluateOnNewDocument 훅이 주입되지 않았다(측정 무효)');
RESULT.jsErrors = diag.jsErrors;
RESULT.consoleErrors = diag.consoleErrors;
RESULT.apiErrors = diag.apiErrors;
RESULT.diagNotes = diag.notes;

RESULT.page = JSON.parse(await js('(' + function (sel) {
  const root = document.getElementById('root') || document.querySelector('[data-reactroot]') || document.body;
  return JSON.stringify({
    url: location.href,
    title: document.title,
    rootLen: root ? root.innerHTML.length : 0,
    textLen: document.body ? document.body.innerText.trim().length : 0,
    text: document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400) : '',
    selectorFound: sel ? !!document.querySelector(sel) : null,
    // 페이지가 스스로 보고하는 타이밍(Navigation Timing / paint) — 폴링 기반 readyMs와 달리 로드 시작 기준이다.
    // ⚠️ 타이밍은 머신 부하·캐시 상태에 따라 배수로 흔들린다(실측 확인) — 게이트 근거가 아니라 참고치로만 쓸 것.
    timing: (() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
      return nav ? {
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        loadEventMs: Math.round(nav.loadEventEnd),
        fcpMs: fcp ? Math.round(fcp.startTime) : null,
      } : null;
    })(),
  });
}.toString() + ')(' + JSON.stringify(${JSON.stringify(selector)}) + ')'));

${shotPath ? `
try { await captureScreenshot(${JSON.stringify(shotPath)}); RESULT.screenshot = ${JSON.stringify(shotPath)} }
catch (e) { RESULT.screenshotError = String(e && e.message || e) }
` : ''}

cliLog('__MEASURE_RESULT__' + JSON.stringify(RESULT));
`;

const run = spawnSync('ego-browser', ['nodejs'], {
  input: script,
  encoding: 'utf8',
  timeout: (navTimeout + waitSec + 60) * 1000,
  env: process.env,
});
if (run.error) {
  console.error(`measure-browser: ego-browser 실행 실패 — ${run.error.message}\n` +
    `  (PATH에 ego-browser가 있어야 한다: loops.env의 LOOPS_PATH_PREPEND 확인. 미설치면 ego lite 앱을 먼저 설치·온보딩)`);
  process.exit(1);
}
// cliLog는 ego-browser의 **stderr**로 나간다(터미널 출력용). 스트림 위치에 의존하지 않도록 둘 다 훑는다.
const out = `${run.stdout || ''}\n${run.stderr || ''}`;
const marker = out.split('\n').find((l) => l.includes('__MEASURE_RESULT__'));
if (!marker) {
  console.error(`measure-browser: 결과 마커가 없다 (exit ${run.status}) — 측정 실패로 처리한다.\n--- output ---\n${out.slice(-3000)}`);
  process.exit(1);
}
const result = JSON.parse(marker.slice(marker.indexOf('__MEASURE_RESULT__') + '__MEASURE_RESULT__'.length));
result.url = url;
result.ts = Math.floor(Date.now() / 1000);
// 렌더 판정 = 폴링이 준비 조건을 만났는가. (readyMs === null → 제한 시간 내 미달 = 미렌더)
result.rendered = result.readyMs != null;
result.minRoot = minRoot;
// 준비 조건을 만족한 뒤 앱이 스스로 다른 경로로 옮겨갔는지 — 스택 복원·리다이렉트로 홈에 도로 앉는 케이스가 있다.
// 숨기면 "다른 화면을 재고 통과"가 되므로 결과에 명시한다(측정 무효 신호).
const want = new URL(url).pathname.replace(/\/$/, '');
const landed = new URL(result.page.url).pathname.replace(/\/$/, '');
result.redirectedTo = landed === want ? null : landed;
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
