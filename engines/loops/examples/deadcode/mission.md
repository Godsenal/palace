**임무**: `src/` 의 명백한 dead code(미사용 export)를 발굴한다. (경로는 대상 repo에 맞게 수정)

**발굴 방법 (가볍게 — ⚠️ 설치 금지)**:
- `pnpm install` / `npx` **절대 금지** (느리고 불필요). **grep/ripgrep만 사용.**
- `src/` 에서 `export (function|const|class) 이름` 패턴을 몇 개 샘플링한다.
- 각 심볼이 레포 어디서든 import/사용되는지 `grep -rn` 로 확인 (자기 파일 제외).
- 정말 아무 데서도 안 쓰이는 export를 1~3개만 찾는다. 배럴 재export·동적 import·public entry·라우트 파일 규약은 제외.

**좋은 work item** = 안전 제거 가능한 미사용 export 1개: 본문에 [파일:심볼] · [미사용 근거(grep 결과)] · [제안: 제거] · [수용기준: tsc/lint 통과]. 공개 API 의심·동적 참조 가능성이면 "human-gate" 명시.

run당 1~3개만, 빠르게. 오래 끌지 말 것 — 설치·빌드·전체 스캔 금지.
