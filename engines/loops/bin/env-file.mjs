// loops.env 파싱/갱신 공유 헬퍼. 의존성 0 (Node 내장 fs만) — dashboard-server "Node-builtin-only" 규약 유지(로컬 .mjs import은 npm 의존성 아님).
// ⚠️ ROOT는 반드시 호출자가 주입한다. 이 모듈이 자체 import.meta.url로 유도하면 bin/ 자기 위치를 가리켜 오작동 —
//    소비자(loops-mcp·notify-bot = repo/bin, dashboard-server = repo root)마다 파일 위치가 달라도 런타임 ROOT는 동일한 repo root여야 하므로.
import { readFileSync, writeFileSync } from 'node:fs';

// loops.env → {KEY:VAL} 맵.
export function loadEnv(root) { const e = {}; try { for (const l of readFileSync(`${root}/loops.env`, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/); if (m) e[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); } } catch {} return e; }

// loops.env 의 키를 갱신-또는-추가. preserved 키라 재설치에도 보존됨.
export function setEnvVar(root, key, val) { const p = `${root}/loops.env`; let t = ''; try { t = readFileSync(p, 'utf8'); } catch {} const ln = `${key}=${val}`; const re = new RegExp('^' + key + '=.*$', 'm'); t = re.test(t) ? t.replace(re, ln) : (t.replace(/\n?$/, '\n') + ln + '\n'); writeFileSync(p, t); }
