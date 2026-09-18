<!-- 버그 triage & 자동수정 루프 템플릿 (drain 모드 + 공유 프로젝트 라벨 분리).
     쓰는 법: 이 디렉터리를 loops/<id>/ 로 복사하고 config.json의 repo/worktree/linearProjectId를 채운다.
     같은 Linear 프로젝트를 다른 루프와 공유하려면 그쪽 config에 다른 linearLabel을 준다.
     관측 소스는 OMP에 설치된 read-only error-tracking skill/tool 또는 mission에 명시한 결정론 CLI를 쓴다. -->

**임무**: `<앱 이름>`(`<스택 요약>`)의 **프로덕션 버그를 triage해 배포 가능한 fix로** 만든다. 두 입력을 처리한다: ① 구성된 read-only error-tracking source(Sentry/PostHog 등)의 관측 신호를 발굴해 이슈화, ② 사람이 직접 넣은 버그 이슈를 그대로 구현. 산출물은 근거 있는 수정 PR이다(머지는 사람 게이트).

> 라벨 스코프는 엔진이 강제한다 — 이 루프는 공유 Linear 프로젝트에서 `Bug` 라벨 이슈만 담당하고, 새로 만드는 이슈에도 자동으로 `Bug` 라벨을 붙인다(프롬프트 상단 규칙). drain 모드라 "버그가 쌓이면 계속 처리, 비면 발굴 주기로만 폴링"한다.

**대상 스코프** (⚠️ 이 프로젝트 신호만 신뢰 — 다른 앱 무시):
- 관측: OMP에 구성된 error-tracking read-only tool/skill 또는 mission에 명시한 CLI. 대상 org/project는 repo 설정(예 `EXPO_PUBLIC_SENTRY_DSN`)과 대조해 확정한다.
- repo: config의 `repo` (worker cwd = 이 레포 worktree).

**발굴 방법 (매 run 가볍게 — 설치·빌드·전체 스캔 금지, read/search 우선)**:
- 관측 소스를 읽기 전용으로만 쓴다. 관측 도구에서 이슈를 resolve/ignore/mute/assign 하지 말 것 — 관측 상태는 배포·사람이 정리한다.
- 미해결 · `level ≥ error` · 최근 창(지난 24~72h)의 **신규/재발(regressed)**만 조회. 뽑을 것: 예외 메시지·stacktrace 요지·breadcrumbs · 발생수·영향 사용자수 · first/last seen · **release/commit SHA** · 영향 파일.
- 우선순위: (치명도) × (발생수·영향) 높은 순. **run당 1~3건만.** worker도 같은 read-only source를 사용해 근거를 보강한다.

**dedup은 Linear에서** (사이드 스테이트 없음): 각 에러의 안정적 fingerprint(issue short-id)를 본문 **맨 아래 `fingerprint: <값>`**로 남기고, 발행 전 프로젝트의 `Bug` 이슈(모든 상태)를 그 fingerprint·제목으로 검색해 이미 있으면 skip(재오픈 금지 포함).

**severity 분기**:
- **fatal/high — stacktrace로 원인 경로 명확** → 일반 work item(자동수정 대상).
- **애매 → 본문 맨 위 `human-gate`**: 플레이키/1~2회성, 서드파티·인프라 순단, 롤백이 답인 회귀, 스펙·제품 판단, 스키마·마이그레이션·새 env, 애널리틱스 이상(코드 버그 아님), **머지해도 즉시 배포되지 않는 변경**(모바일 네이티브 지문 등 — 새 빌드·심사가 필요해 릴리스 타이밍이 사람 판단).

**사람이 직접 넣은 `Bug` 이슈**도 정상 work item — 본문대로 구현. 재현 불가/정보 부족이면 "🚧 재현 불가: <필요한 것>" 코멘트 + Backlog 복귀.

**이슈 본문 필수**: [대상: 관측 링크 + 영향 파일] · [증상: 예외·stacktrace·발생수/사용자수/first-last seen·release SHA] · [추정 근본원인 + 재현] · [제안 fix] · [수용기준: 그 경로가 예외를 더는 못 냄 + 리포 typecheck 통과 + 가능하면 재현 테스트] · 맨 아래 `fingerprint: <id>`.

**노이즈 컷**: 1~2회성 · 오래돼 재발 없음 · resolved · 서드파티 순단 · 우리 코드 아닌 스택.

**해결 판정 주의**: 라이브 에러율은 배포 후에야 떨어진다(PR 시점 미머지) → verifier·worker는 라이브 에러율이 아니라 **코드 추론 + 재현 케이스**로 검증한다.

작업 완료되면 OMP 네이티브 도구로 diff를 정리하고 커밋한 뒤 `gh pr create --base <prBase>`로 PR을 연다. 머지는 사람 게이트.
