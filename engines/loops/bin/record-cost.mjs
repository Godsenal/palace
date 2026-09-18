#!/usr/bin/env node
// omp-run.mjs의 명시적 JSON run record를 두 갈래로 분리한다:
//   ① stdout ← result 텍스트
//   ② costs.jsonl ← {ts,kind,mode,usd,durMs,turns,tokens,errorClass?}
// JSON 파싱 실패면 원문을 보존하고 크게 알린다.
// usage: record-cost.mjs <loop-id> <json-file> <kind> [mode]
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const ROOT = process.env.LOOPS_HOME || dirname(dirname(fileURLToPath(import.meta.url)));
const [, , loopId, file, kind = 'cycle', mode = ''] = process.argv;
if (!loopId || !file) { console.error('usage: record-cost.mjs <loop-id> <json-file> <kind> [mode]'); process.exit(1); }
let raw = '';
try { raw = readFileSync(file, 'utf8'); } catch (e) { console.error(`⚠️ cost capture 실패: 출력 파일 없음(${file}) — ${e.message}`); process.exit(0); }
let j;
try { j = JSON.parse(raw); } catch {
  process.stdout.write(raw);
  console.error(`\n⚠️ cost capture 실패: OMP runner 출력이 JSON이 아님 — 비용 미기록, 로그는 원문 그대로.`);
  process.exit(0);
}
process.stdout.write(j.ok === false ? `[OMP_ERROR_CLASS:${j.errorClass || 'fatal'}] ${String(j.error || 'OMP 실행 실패')}` : String(j.result ?? ''));
const u = j.usage || {};
const t = u.tokens || {};
const rec = {
  ts: Math.floor(Date.now() / 1000), kind, ...(mode ? { mode } : {}),
  usd: u.usd ?? null, durMs: u.durationMs ?? null, turns: u.turns ?? null,
  tokens: { in: t.in ?? 0, out: t.out ?? 0, cacheRead: t.cacheRead ?? 0, cacheWrite: t.cacheWrite ?? 0 },
  ...(j.errorClass ? { errorClass: j.errorClass } : {}),
};
appendFileSync(`${ROOT}/loops/${loopId}/state/costs.jsonl`, JSON.stringify(rec) + '\n');
