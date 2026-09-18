#!/usr/bin/env node
// retro가 쓴 learnings.md를 결정론적으로 재검사한다. 프롬프트의 금지 조항(retro-base.md ⛔)은 프롬프트일 뿐이라
// LLM이 "근거가 충분하다"고 판단하면 뚫린다 — 실제로 뚫렸다. 그래서 같은 규칙을 쉘 층에 한 번 더 건다.
//
// 왜 필요했나(실측): learnings.md는 매 run 오케스트레이터·워커 프롬프트에 주입된다. retro의 목적함수가 "무엇이
// 머지까지 갔나"인데 머지율이 99.5%(596/599)라 그 축에 분산이 없었고, 남은 유일한 변동 축인 **처리량**을 올리는
// 법을 retro가 정확히 찾아냈다 — 게이트 제거. "PR이 green·CLEAN이면 오케스트레이터가 먼저 머지하라"가 교훈으로
// 기록됐고 한 구간 머지 11건 중 8건이 그 경로였다. 엔진의 no-merge 불변식이 자기학습으로 침식된 사례다.
//
// 판정은 **지시문만** 잡는다. retro의 본업이 "무엇이 머지됐나" 분석이라 서술적 '머지' 언급은 정상이고,
// 그걸 잡으면 정상 갱신이 매번 롤백돼 사람이 가드를 꺼버린다 — 오탐이 곧 가드의 죽음이다. 그래서 명령형·
// 우회 지시 형태에만 건다(고정밀·저재현 쪽으로 의도적으로 치우침).
//
// usage: learnings-guard.mjs <loop-id>
// exit 0 = 통과(경고는 stdout), exit 1 = 불변식 위반(호출자가 갱신을 롤백), exit 2 = 파일 없음/읽기 실패.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = process.env.LOOPS_HOME || dirname(dirname(fileURLToPath(import.meta.url)));
const loopId = process.argv[2];
if (!loopId) { console.error('usage: learnings-guard.mjs <loop-id>'); process.exit(2); }

const file = `${ROOT}/loops/${loopId}/state/learnings.md`;
let text;
try { text = readFileSync(file, 'utf8'); } catch { console.error(`learnings-guard: 파일 없음 — ${file}`); process.exit(2); }

// 불변식 위반 = 롤백. 각 패턴은 "서술"이 아니라 "지시"에만 걸리도록 좁게 잡았다.
const BANNED = [
  [/(?:직접|먼저|바로|우선)\s*머지/, '오케스트레이터 직접 머지 지시'],
  [/머지\s*(?:하라|해라|하십시오|할\s*것이다)/, '머지 명령형'],
  [/gh\s+pr\s+merge/, 'PR 머지 명령'],
  [/force[-\s]?push|--force(?:-with-lease)?/i, 'force-push 지시'],
  [/close-workspace|탭을\s*(?:닫|죽)|워크스페이스를?\s*닫/, 'cmux 탭 직접 조작 지시'],
  [/worktree를?\s*(?:삭제|지우|제거)/, 'worktree 직접 삭제 지시'],
  [/게이트\s*(?:없이|건너|면제|해제|무시)|human-gate\s*(?:없이|면제|우회)/, 'human-gate 우회 지시'],
  [/베이스\s*(?:룰|프롬프트)\s*(?:을|를)?\s*(?:인용|무시|어기|위반)/, '베이스 프롬프트 규칙 위반 지시'],
  [/(?:배포|promote|deploy)\s*(?:하라|해라)/i, '배포 지시'],
];

// 예산 초과는 경고만. 롤백까지 하면 "조금 긴 정상 교훈"이 통째로 버려져 retro가 무력해진다 —
// 불변식(안전)과 예산(효율)은 심각도가 다르므로 게이트를 분리한다.
const MAX_LINES = 15, MAX_LINE_CHARS = 600;

// 부정문 예외 — retro가 금지를 *재확인*하는 문장("게이트 면제 규칙도 만들지 말 것")은 위반이 아니라 준수다.
// 이걸 안 걸러내면 규칙을 지키는 문장이 롤백을 유발해 가드가 정반대로 작동한다(실측: 첫 시행에서 3건 중 1건이 이 오탐).
const NEGATED = /말\s*것|말라|말\s*것이다|하지\s*마|금지|안\s*된다|불가|없어야|해서는\s*안/;
const NEG_WINDOW = 60;

const lines = text.split('\n');
const hits = [];
lines.forEach((line, i) => {
  for (const [re, why] of BANNED) {
    const m = line.match(re);
    if (!m) continue;
    if (NEGATED.test(line.slice(m.index, m.index + NEG_WINDOW))) continue;   // "…하지 말 것" = 준수 문장
    hits.push({ n: i + 1, why, snippet: line.slice(Math.max(0, m.index - 40), m.index + 80).trim() });
  }
});

const bullets = lines.filter((l) => l.trim().startsWith('-')).length;
const longest = lines.reduce((a, l) => Math.max(a, l.length), 0);
const warns = [];
if (bullets > MAX_LINES) warns.push(`불릿 ${bullets}줄 > ${MAX_LINES}줄`);
if (longest > MAX_LINE_CHARS) warns.push(`최장 줄 ${longest}자 > ${MAX_LINE_CHARS}자`);
if (warns.length) console.log(`⚠️ learnings 예산 초과(경고, 롤백 안 함): ${warns.join(' · ')}`);

if (!hits.length) process.exit(0);

console.error(`⛔ learnings-guard: 불변식 위반 ${hits.length}건 — 갱신을 롤백한다`);
for (const h of hits) console.error(`   L${h.n} [${h.why}] …${h.snippet}…`);
process.exit(1);
