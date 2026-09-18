#!/usr/bin/env node
// Lighthouse 실측기 — 한 URL을 실제로 감사하고 **결정론적인 것과 노이즈를 분리해서** JSON으로 뽑는다.
//
// 왜 분리하는가 (같은 URL 2회 연속 실측):
//   perf 50 vs 78 · LCP 8722ms vs 2291ms · CLS 0 vs 0.121   ← 타이밍은 배수로 흔들린다
//   a11y/bp/seo 100/96/69 vs 100/96/69 · total bytes 7,145,506 vs 7,144,699(0.01%) · requests 357 vs 357  ← 결정론
// 따라서 **게이트(이슈 발행·verdict fail)는 stable 블록에만 걸고**, timings는 코멘트용 참고치로만 남긴다.
// 이 구분을 무너뜨리면 루프가 노이즈로 이슈를 만들고 rework를 무한 유발한다.
//
// lighthouse는 설치하지 않고 npx로 부른다(첫 실행만 다운로드, 이후 캐시 — 실측 1회 ~23초).
// usage: measure-lighthouse.mjs <url> [--runs N] [--preset mobile|desktop] [--timeout-sec N]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LH_VERSION = 'lighthouse@12';   // 핀 고정: 버전이 뜨면 audit id·점수 기준이 바뀌어 과거 스냅샷과 비교 불가.
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
// 결정론적인 perf audit만(로드된 리소스에서 계산 — 바이트/개수 기반). 타이밍 기반 audit은 제외한다.
const STABLE_PERF_AUDITS = [
  'total-byte-weight', 'unused-javascript', 'unused-css-rules', 'legacy-javascript', 'duplicated-javascript',
  'modern-image-formats', 'uses-optimized-images', 'uses-responsive-images', 'offscreen-images',
  'unsized-images', 'render-blocking-resources', 'uses-text-compression', 'efficient-animated-content',
];

const argv = process.argv.slice(2);
const url = argv[0];
if (!url || url.startsWith('-')) {
  console.error('usage: measure-lighthouse.mjs <url> [--runs N] [--preset mobile|desktop] [--timeout-sec N]');
  process.exit(2);
}
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const runs = Math.max(1, Number(flag('runs', '1')));
const preset = flag('preset', 'mobile');
if (!['mobile', 'desktop'].includes(preset)) { console.error(`measure-lighthouse: --preset은 mobile|desktop (받은 값: ${preset})`); process.exit(2); }
const timeoutSec = Number(flag('timeout-sec', '300'));

const tmp = mkdtempSync(join(tmpdir(), 'loops-lh-'));
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

try {
  const reports = [];
  for (let i = 0; i < runs; i++) {
    const out = join(tmp, `lh-${i}.json`);
    const args = [
      '-y', LH_VERSION, url, '--quiet', '--output=json', `--output-path=${out}`,
      `--only-categories=${CATEGORIES.join(',')}`,
      '--chrome-flags=--headless=new --no-sandbox',
    ];
    if (preset === 'desktop') args.push('--preset=desktop');
    const r = spawnSync('npx', args, { encoding: 'utf8', timeout: timeoutSec * 1000 });
    if (r.status !== 0) {
      console.error(`measure-lighthouse: run ${i + 1}/${runs} 실패 (exit ${r.status})\n${`${r.stderr || ''}`.slice(-2000)}`);
      process.exit(1);
    }
    reports.push(JSON.parse(readFileSync(out, 'utf8')));
  }

  const last = reports[reports.length - 1];
  const num = (rep, id) => rep.audits[id]?.numericValue ?? null;
  const scoreOf = (rep, cat) => (rep.categories[cat]?.score == null ? null : Math.round(rep.categories[cat].score * 100));

  // 실패 audit — a11y/bp/seo는 전 항목, performance는 결정론 목록만.
  const failed = [];
  for (const cat of CATEGORIES) {
    for (const ref of last.categories[cat].auditRefs) {
      const a = last.audits[ref.id];
      if (!a || a.score == null || a.score >= 1) continue;
      if (cat === 'performance' && !STABLE_PERF_AUDITS.includes(ref.id)) continue;
      failed.push({
        category: cat,
        id: ref.id,
        title: a.title,
        score: a.score,
        displayValue: a.displayValue ?? null,
        savingsBytes: a.details?.overallSavingsBytes ?? null,
        itemCount: Array.isArray(a.details?.items) ? a.details.items.length : null,
        // 근거로 쓸 실제 대상 몇 개(이슈 본문에 인용 가능하게) — 전체를 넣으면 프롬프트가 폭발한다.
        sample: Array.isArray(a.details?.items)
          ? a.details.items.slice(0, 5).map((it) => String(it.url || it.node?.snippet || it.source?.url || '').slice(0, 200)).filter(Boolean)
          : [],
      });
    }
  }

  process.stdout.write(`${JSON.stringify({
    url,
    ts: Math.floor(Date.now() / 1000),
    lighthouse: last.lighthouseVersion,
    preset,
    runs,
    // ── 게이트용: 재현되는 값들 ──
    stable: {
      scores: { accessibility: scoreOf(last, 'accessibility'), bestPractices: scoreOf(last, 'best-practices'), seo: scoreOf(last, 'seo') },
      totalBytes: num(last, 'total-byte-weight'),
      requests: last.audits['network-requests']?.details?.items?.length ?? null,
      unusedJsBytes: last.audits['unused-javascript']?.details?.overallSavingsBytes ?? null,
      unusedCssBytes: last.audits['unused-css-rules']?.details?.overallSavingsBytes ?? null,
      failedAudits: failed,
    },
    // ── 참고용: run마다 흔들리는 값들(게이트 금지) ──
    timings: {
      performanceScore: reports.map((r) => scoreOf(r, 'performance')),
      fcpMs: median(reports.map((r) => num(r, 'first-contentful-paint'))),
      lcpMs: median(reports.map((r) => num(r, 'largest-contentful-paint'))),
      tbtMs: median(reports.map((r) => num(r, 'total-blocking-time'))),
      cls: median(reports.map((r) => num(r, 'cumulative-layout-shift'))),
      note: '타이밍·performance 점수는 run마다 배수로 흔들린다. 판정 근거로 쓰지 말 것(참고치).',
    },
  }, null, 2)}\n`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
