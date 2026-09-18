# Palace OMP

Palace OMP는 **cmux + native OMP** 개발 환경을 준비하고, 여러 컴퓨터의 OMP 프로필과 안전한 자동화를 관리하는 macOS 데스크톱 control plane입니다. Palace 창 안의 IDE는 세션 확인·간단한 개입·격리 워크스페이스 작업을 위한 고급 보조 도구이며, 주 개발 환경을 대체하지 않습니다.

## 핵심 흐름

1. **환경 설정**에서 OMP, Git, Node.js, GitHub CLI와 cmux를 확인하고 OMP/GitHub에 로그인합니다.
2. 프로젝트 폴더를 별칭으로 등록합니다. 절대 경로는 이 컴퓨터에만 남습니다.
3. **cmux + OMP**에서 프로젝트, 모델, 전문 프로필, Collab 접근 수준을 고른 뒤 native OMP TUI를 시작합니다.
4. 필요하면 **Workbench**에서 격리 워크스페이스, OMP RPC 세션, 터미널, 변경 diff와 질문을 다룹니다.
5. 반복 작업은 Palace core automation 또는 선택 사항인 원본 Loops 엔진으로 실행합니다.

모델 및 thinking 선택기의 **Auto**는 별도 모델 인자를 넘기지 않고 OMP의 현재 기본값과 `modelRoles` 설정을 따릅니다. 전문 프로필은 이름, 모델, thinking, 추가 지침, `whenToUse` 역할 설명을 묶습니다. Loops는 builder, orchestrator, worker, verifier, validator, retro, controller처럼 역할을 분리하며, 역할 모델이 비어 있거나 `auto`이면 역시 OMP 기본 모델을 사용합니다.

## 휴대폰: native OMP Collab

휴대폰은 Palace나 Loops 대시보드를 경유하지 않고 **실행 중인 native OMP Collab에 직접** 연결합니다.

- native Collab을 지원하는 OMP와 OMP 로그인이 필요합니다. 현재 검증 버전은 18.2.5입니다.
- Palace에서 보기 전용 또는 제어 허용으로 세션을 시작하거나, OMP에서 `/collab view` 또는 `/collab`을 실행합니다.
- Palace가 OMP에서 받은 보기/제어 링크와 QR을 표시합니다. 링크는 `https://my.omp.sh`의 OMP 웹 클라이언트로 연결됩니다.
- Collab 링크는 해당 접근 권한을 가진 **비밀 capability URL**입니다. 메신저나 공개 이슈에 남기지 마세요.
- 공유를 끝낼 때 OMP에서 `/collab stop`을 실행해 capability를 폐기합니다.
- native Collab에는 Tailscale, 포트 포워딩, Palace 웹 게이트웨이가 필요하지 않습니다. Palace는 세션 상태와 링크 요청만 제어하며 휴대폰 트래픽을 프록시하지 않습니다.

Tailscale은 원본 Loops PWA/SSH를 외부에서 열 때만 사용할 수 있는 선택 도구입니다. native OMP Collab의 전제 조건이 아닙니다.

## Workbench와 Skills

내장 IDE는 프로젝트별 일반 또는 격리 Git 워크스페이스, native terminal, OMP RPC 대화, 질문 응답, 모델/thinking 변경, 파일·diff 확인과 세션 재개를 제공합니다. 전체 TUI와 cmux의 기본 개발 흐름이 우선이고, IDE는 보조 표면입니다.

Skills 화면은 [skills.sh](https://skills.sh) 검색 또는 GitHub 저장소 주소를 받아 설치 전 파일을 미리 보여 줍니다. 설치는 프로젝트의 `.agent/skills` 아래에만 이루어지며 다음 안전장치를 사용합니다.

- 설치 레시피는 저장소, skill 경로와 **고정 revision**을 기록합니다.
- 업데이트도 먼저 새 revision의 내용을 검토해야 합니다.
- 추적 파일이 로컬에서 수정되었으면 업데이트나 동기화 적용을 중단해 변경을 보존합니다.
- 심볼릭 링크, 프로젝트 밖 경로, 자격 증명으로 보이는 파일과 비밀 문자열은 거부합니다.

## 프로필 동기화

별도의 Git 저장소와 브랜치를 연결해 다음 휴대 가능 데이터를 동기화합니다.

- 허용된 OMP 설정, 사용자 지침과 portable skills
- Palace 자동화 정의
- 전문 프로필
- 프로젝트 별칭에 연결된 skills의 고정 revision 레시피
- 선택한 Loops/제품 정의

다음은 의도적으로 동기화하지 않습니다.

- 프로젝트 절대 경로, worktree 경로와 그 밖의 머신 로컬 경로
- OMP/GitHub/Linear/Telegram 인증, 토큰, 쿠키, 환경 변수와 자격 증명
- 머신별 자동화 승인과 armed 상태
- 사용자 지정 endpoint/URL, 실행 명령, shell, hook, extension/MCP 등 로컬 실행 권한

push/pull은 기준 commit과 프로필 hash를 비교합니다. 앱에서 아직 push하지 않은 변경, Git 작업 트리 변경, 서로 갈라진 브랜치 또는 적용 중 충돌이 있으면 자동 덮어쓰지 않습니다. 미연결 프로젝트 별칭의 레시피는 경로를 연결할 때까지 보류합니다. 가져온 Workbench 데이터 적용은 `apply-pending` 상태로 먼저 기록되며, 로컬 skill 수정 같은 충돌로 실패하면 pending 상태를 유지합니다. 충돌을 해결하고 다시 적용하기 전까지 새 캡처로 원격 정의를 지우지 않습니다.

## 자동화

### Palace core automation

core automation은 수동, interval, 일일 시간대, 5-field cron, 인증 bearer webhook, GitHub 일정 폴링을 지원합니다. GitHub 트리거는 새 issue, PR review, 실패한 workflow run을 감지하며 첫 폴링은 과거 이벤트를 실행하지 않고 cursor만 초기화합니다. 외부 payload는 신뢰할 수 없는 데이터로 표시되고 delivery ID로 중복을 막습니다.

자동 실행에는 각 루프의 이 컴퓨터 승인, enabled, 전역 armed가 모두 필요합니다. 실행은 새 Git worktree와 브랜치에서 이루어집니다. 정책 확장은 파일 도구의 worktree 밖 접근과 알려진 push, merge, deploy, publish 및 remote mutation 명령을 거부합니다. 결정적 checks가 없으면 성공을 주장하지 않고 `needs-review`로 남기며, 성공·실패 모두 검토용 worktree/branch를 보존합니다. **core automation은 자동 merge나 deploy를 제공하지 않습니다.**

이 정책은 **OS 수준 sandbox가 아닙니다.** `bash`/`eval`, 프로젝트 스크립트와 checks는 로그인한 사용자의 권한으로 실행되므로 우회 가능한 명령 필터를 완전한 파일·네트워크 격리로 취급하면 안 됩니다. 신뢰하는 저장소와 스크립트만 승인하고, 강한 격리가 필요하면 별도 사용자나 VM에서 실행하세요.

Workbench heartbeat는 살아 있는 agent 세션에 최소 60초 간격, 명시적 최대 실행 횟수(1~10,000)와 prompt를 설정하는 bounded 반복입니다. heartbeat, cron, interval, webhook 수신, GitHub 폴링은 Palace automation service와 Mac이 깨어 있을 때만 동작합니다. 잠든 호스트를 원격에서 깨우는 서비스가 아닙니다.

### 원본 Loops 엔진 (선택)

번들된 원본 Loops는 독립적인 고급 자동 운영 모드입니다. Palace의 Loops 화면에서 시작하며 다음 기능을 그대로 제공합니다.

- interval/drain 스케줄, 수동 실행, CI 실패·PR review·Linear backlog 이벤트 폴링
- 제품/루프와 라벨 라우팅, OMP 기반 loop builder, 병렬 cmux worker와 격리 worktree
- PR 검증·재작업, verifier/validator와 사람 결정 gate, 비용·일일 예산, retro/learnings
- watchdog 자동 복구, 고아 worktree/탭 정리, incident 발제
- 선택적인 browser/Lighthouse 실측, dashboard/PWA, 엔진 자체 VAPID web push, Telegram 알림·자연어 제어

원본 Loops의 `delivery: "pr"`은 브랜치 push와 PR 생성을, `delivery: "direct"`는 구성된 원격 브랜치로 직접 전달을 허용하는 **선택적 remote-write 기능**입니다. 이는 읽기/로컬 편집 중심의 Palace core automation보다 권한이 큽니다. 루프 mission과 설정을 검토한 뒤 명시적으로 켜세요. 어느 모드도 PR을 자동 merge하거나 배포하지 않으며 force-push도 허용하지 않습니다.

선택 기능 전제 조건:

- 공통: OMP, Node.js, Git, 실행 중인 cmux, 해당 저장소 권한을 가진 `gh auth login`
- Linear 기능: Linear personal API key(`LINEAR_API_KEY`)와 대상 project ID; dashboard 설정에서 저장하면 private `loops.env`에 보관됩니다.
- Telegram: BotFather의 `TELEGRAM_BOT_TOKEN`; 봇을 시작한 뒤 해당 봇에 메시지를 보내 `TELEGRAM_CHAT_ID`를 페어링합니다. 토큰과 chat ID는 동기화되지 않습니다.
- 원본 Loops PWA를 다른 기기에서 직접 열려면 별도의 안전한 HTTPS 경로가 필요하며 Tailscale은 그 선택지 중 하나입니다. 이것은 native Collab과 별개입니다.

## 데이터와 백그라운드 서비스

소스 기준 환경 변수 이름은 `PALACE_OMP_HOME`이며 기본 데이터 루트는:

```text
~/.palace-omp
```

`PALACE_OMP_ROOT`라는 설정 변수는 사용하지 않습니다. 주요 데이터는 기본 루트 아래의 `state.json`, `runs/`, `workbench/`, `sync-repo/`, `loops-engine/`, `catalog/`에 저장됩니다. 서비스 포트는 `PALACE_OMP_PORT`로 바꿀 수 있고 기본값은 `48731`입니다. 상태·토큰 파일과 디렉터리는 사용자 전용 권한으로 생성됩니다.

앱을 열면 service가 실행되지만 로그인 후 항상 실행되는 것은 아닙니다. **launchd 등록은 설치된 packaged 앱의 UI에서 사용자가 명시적으로 설치해야** 하며 개발 모드에서는 등록할 수 없습니다. 제거도 같은 UI에서 명시적으로 수행합니다. 예약 자동화를 계속 실행하려면 Mac이 켜져 있고 잠들지 않도록 운영해야 합니다.

## 개발 설치

요구 사항은 macOS, Node.js 22 이상, npm, Git입니다. `node-pty` native module을 설치·패키징하므로 Xcode Command Line Tools도 필요합니다.

```sh
xcode-select --install   # 아직 없다면 한 번만
cd /path/to/palace-omp
npm ci
npm run dev
```

Palace 기능을 실제로 쓰려면 OMP, cmux와 GitHub CLI도 설치하고 로그인합니다. 앱의 환경 설정 화면에서 상태를 확인하거나 Homebrew 설치를 실행할 수 있습니다.

## 명령

```sh
npm ci               # lockfile 그대로 의존성 설치; node-pty native build 포함
npm run dev          # Electron 개발 모드
npm run typecheck    # main/preload와 renderer TypeScript 점검
npm test             # 번들 Loops 엔진 regression tests
npm run build        # production bundle을 out/에 생성
npm run dist:mac     # macOS dmg/zip을 dist/에 생성
```

`npm run dist`는 현재 플랫폼 패키지, `npm run dist:mac`은 macOS 패키지를 만듭니다. 로컬 기본 패키지는 **unsigned**이므로 다른 Mac에서 Gatekeeper 경고가 날 수 있습니다. 인증서(`CSC_LINK` 또는 `PALACE_SIGN=1`)와 공증 변수를 별도로 제공한 경우에만 signing/notarization을 시도합니다.

`publish`는 `null`이고 기본 update feed도 연결되어 있지 않습니다. 따라서 이 저장소는 원본 Palace release를 게시하거나 원본 Palace 업데이트를 자동 설치하지 않습니다. 별도 `PALACE_OMP_UPDATE_URL`을 명시적으로 구성하지 않는 한 auto-update가 실행되지 않으며, 로컬 빌드는 어떤 release도 publish하지 않습니다.

## 보안 경계 요약

- native phone access는 OMP Collab capability이며 Palace gateway가 아닙니다.
- capability URL, Linear/Telegram token과 sync repository credential은 비밀로 취급합니다.
- core automation은 머신별 승인, 격리 worktree와 정책 검사를 사용하지만 OS sandbox는 아닙니다.
- 원본 Loops의 PR/direct delivery는 별도로 켜는 고권한 기능입니다.
- Palace와 Loops 모두 자동 merge/deploy를 제공하지 않습니다.
- 자동화 service와 호스트가 꺼지거나 잠들면 예약 실행과 heartbeat도 멈춥니다.

MIT · Godsenal
