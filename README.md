# Palace OMP

이 저장소의 가벼운 실행 경로는 **cmux + native OMP companion**입니다. cmux와 OMP를 그대로 사용하면서 모바일 세션 제어, 검사 기반 Loops·예약 실행, 프로젝트·글로벌 Skills 설치를 제공합니다. 기존 Palace Electron 앱은 별도의 선택적 실행 경로로 남아 있으며 companion 실행에는 필요하지 않습니다.

## 다른 Mac에 설치

[Palace OMP 0.2.0 다운로드](https://github.com/Godsenal/palace/releases/tag/palace-omp-v0.2.0)에서 CPU에 맞는 DMG를 받습니다.

| Mac | 설치 파일 |
| --- | --- |
| Apple Silicon · M1 이상 | `Palace-OMP-0.2.0-arm64.dmg` |
| Intel | `Palace-OMP-0.2.0-x64.dmg` |

1. DMG를 열고 **Palace OMP.app**을 **Applications**로 복사합니다. ZIP도 같은 릴리스에 제공합니다.
2. 이 프리릴리스는 **서명·공증되지 않았습니다**. 출처와 릴리스의 `SHA256SUMS.txt`를 확인한 뒤, macOS가 차단하면 **시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기**에서 해당 앱만 허용합니다. 시스템 전체 Gatekeeper를 끄지 마세요.
3. cmux 기반 기능에는 **macOS 14 이상**, 실행 중인 **cmux**, 로그인된 **OMP**, **Node.js 22+**, **Git**이 필요합니다. Loops·GitHub 작업에는 **GitHub CLI 로그인**도 필요합니다. 이 외부 도구와 계정은 설치 파일에 포함하지 않습니다.
4. 앱의 Setup/Machine에서 도구와 프로젝트의 **이 Mac에 있는 경로**를 연결합니다. 다른 컴퓨터의 절대 경로·토큰·실행 승인을 복사하지 않습니다. cmux의 socket 접근 정책도 해당 실행 경로를 허용해야 합니다.
5. OMP 원격 공유는 **보기 전용 / 제어 허용** 또는 `/collab view`·`/collab`으로 시작합니다. Native Collab은 Tailscale 없이 동작하며, 호스트 Mac과 OMP가 켜져 있어야 합니다.

Apple Silicon에서 실제 앱 실행을 검증했습니다. Intel 설치 파일은 교차 빌드이며 **Intel Mac 하드웨어 실행은 검증하지 않았습니다**. Windows/Linux용 데스크톱 설치 파일은 제공하지 않습니다.

이 릴리스는 기존 Palace `v0.1.x`와 분리한 **Palace OMP 프리릴리스**입니다. 기존 Palace의 최신 릴리스·자동 업데이트 채널은 바꾸지 않으며, Palace OMP도 자동 업데이트 대신 릴리스 페이지에서 수동 설치합니다.

### 다른 Mac에서 Companion 실행

Companion은 DMG를 설치하는 것과 별개의 Node 서비스입니다. 해당 Mac에 필요한 도구를 설치한 뒤 아래의 **정확한 릴리스 태그**로 소스를 받습니다. 기본 `main` 브랜치는 기존 Palace이므로 사용하지 않습니다.

```sh
git clone --branch palace-omp-v0.2.0 --depth 1 https://github.com/Godsenal/palace.git palace-omp
cd palace-omp
npm ci
npm run companion:build
npm run companion
```

아래의 cmux socket 접근 조건과 휴대폰 페어링 절차를 적용하세요. 기존 Mac의 Companion URL은 새 Mac의 서버 주소가 아닙니다.

## cmux + OMP companion

화면은 **Sessions / Loops · 자동화 / Skills** 세 개와 연결 설정입니다. 에디터, 파일 탐색기, 동기화 UI는 로드하지 않습니다.

- **Sessions:** 실행 중인 cmux 터미널의 최근 200줄, 대상별 한 줄 붙여넣기, Enter·Escape·방향키·Tab·확인 후 Ctrl+C. 텍스트를 붙여넣어도 Enter는 자동 입력하지 않습니다. 전체 터미널 렌더러나 native OMP Collab 대체 프로토콜은 아닙니다.
- **Loops · 자동화:** 미션·검사·재시도 설정, 수동·interval·일일 IANA 시간대·5-field cron, 머신별 명시적 승인, 전역 예약 준비(Armed), 실행 기록·증분 로그·취소. 실행을 시작하면 해당 실행 기록이 바로 열립니다.
- **검사 기반 반복:** 격리 Git worktree에서 native OMP 실행 → 검사 → 실패 내용을 전달해 새 OMP 세션으로 재작업. 최대 시도와 전체 실행 시간 제한을 적용합니다. 검사가 없으면 `needs-review`이며 성공으로 표시하지 않습니다.
- **복구:** 설정·승인·예약·기록을 디스크에 저장합니다. 같은 루프가 대기/실행/검사 중이면 예약을 추가로 쌓지 않습니다. 지나간 예약은 한 번으로 합치며, 서비스 재시작 시 실행 중이던 작업은 `interrupted`로 남깁니다. 끝난 작업은 보존된 worktree와 OMP 세션을 cmux에서 다시 열 수 있습니다.
- **Skills:** 카테고리별 추천 카드, skills.sh 검색 또는 GitHub·로컬 Git 저장소 미리보기, 프로젝트 / 현재 사용자 글로벌 설치, 검토 후 업데이트·제거. 실제 설치 경로를 확인한 뒤 명시적으로 적용합니다.

### 실행

Node.js 22+, Git, 로그인된 OMP, 실행 중인 cmux가 필요합니다.

```sh
cd /path/to/palace-omp
npm ci
npm run companion:build
npm run companion
```

기본 주소는 `http://127.0.0.1:48732`, 데이터는 `~/.cmux-omp`입니다. 기존 Palace의 포트와 데이터에 접근하지 않습니다. `CMUX_OMP_PORT`, `CMUX_OMP_HOME`으로 변경할 수 있습니다. 다른 cmux 터미널에서 `npm run companion:pair`를 실행하면 연결 링크와 QR이 표시됩니다.

**현재 cmux의 socket 접근 모드가 `cmuxOnly`라면 companion을 cmux 안의 전용 터미널에서 실행하고 그 터미널을 유지하세요.** `companion:install`은 이 모드에서 launchd 등록을 거부하며 접근 설정을 자동으로 완화하지 않습니다. 이미 외부 서비스 접근을 적절히 구성한 머신에서만 `companion:install`, `companion:status`, `companion:uninstall`로 로그인 서비스를 관리할 수 있습니다.

설정에서 프로젝트 키에 실제 Git 저장소 절대 경로를 연결하고 OMP 실행 경로를 지정하세요. 하단 **Loops → 새 Loop**에서 미션, 검사 명령, 일정과 한도를 입력하고 **저장하고 승인으로 → 이 Loop 실행 승인**을 누릅니다. 새 Loop는 활성 상태로 저장되지만 자동 승인하거나 예약 전체를 켜지는 않습니다. 수동은 **지금 실행**, 예약은 상단 **예약 일시정지**를 눌러 **예약 준비됨**으로 전환합니다. 예약이 멈춘 이유와 최근 결과는 카드에 표시됩니다. 실행 정의·프로젝트 경로·OMP 명령을 변경하면 다시 승인해야 합니다. 시간 제한은 시도별이 아니라 **모든 재시도와 검사를 포함한 전체 실행 시간**입니다.

### Skills 추천과 탐색

모바일 Companion과 Palace 데스크톱은 같은 추천 목록을 사용합니다. 첫 화면에는 분야별 대표 추천 **6개**, **전체**에는 **10개**가 표시됩니다. 카테고리는 프론트엔드, 디자인·UI, 백엔드·DB, 테스트·디버깅, 에이전트·워크플로, 문서·협업입니다.

- 카드는 용도, 제작자·저장소, 추천 이유와 [skills.sh](https://skills.sh) 상세 페이지를 제공합니다. 추천과 분류는 앱에서 직접 선별한 것이며 실시간 순위, 보안 인증이나 프로젝트별 개인화 결과가 아닙니다.
- 카테고리 필터는 로컬 추천 목록을 즉시 좁힙니다. **더 검색 / 이 분야 더 찾기**는 해당 분야의 검색어로 skills.sh를 실시간 검색합니다. [Topics](https://skills.sh/topic)와 일반 키워드 검색도 사용할 수 있습니다.
- 추천 카드의 **미리보기**는 실제 Git 저장소에서 파일을 읽습니다. 최종 설치는 대상 경로·파일·고정 revision 확인 후에만 진행하며, 필요한 외부 도구를 자동 설치하지 않습니다.
- 목록은 `src/shared/skill-catalog.ts`에서 관리합니다. 항목 추가·변경 시 skills.sh 상세 링크와 실제 저장소의 `SKILL.md` 및 설치 미리보기를 확인하세요.

### Skills 설치 범위

- **Project:** 등록된 프로젝트의 `<프로젝트>/.agent/skills`에 설치합니다. Palace 데스크톱에서는 **폴더 선택**으로 대상을 연결하며, 자동 발견된 미등록 폴더를 설치 대상으로 취급하지 않습니다.
- **Global:** 현재 Mac 사용자의 `~/.agents/skills`에 설치합니다. 시스템 전체나 다른 사용자 계정에 설치하는 옵션이 아닙니다.
- 같은 이름이면 native OMP의 탐색 설정·우선순위를 따릅니다. 기본 설정에서는 프로젝트 설치가 글로벌보다 우선합니다. 설치·업데이트 후 **새 OMP 세션이나 새 Loop 실행**에서 사용하세요. 실행 중인 세션에 자동으로 다시 로드하지 않습니다.
- 설치 전 모든 파일과 고정 revision, 대상 경로를 검토합니다. 업데이트에도 새 미리보기가 필요합니다. 수정되었거나 추가된 로컬 파일이 있으면 업데이트·제거를 거부합니다. 변경을 별도로 보관하고 원래 상태로 복원한 뒤 다시 시도하세요.
- 목록은 이 Companion이 관리하는 설치만 표시합니다. 기존 폴더·다른 도구의 설치·심볼릭 링크를 덮어쓰지 않습니다. 글로벌 설치는 프로젝트 프로필 동기화에 포함하지 않습니다.

### 휴대폰 연결: Tailscale 사설 HTTPS

Mac과 휴대폰에 Tailscale을 설치하고 같은 tailnet으로 로그인합니다. macOS의 Tailscale 네트워크 확장 승인도 필요합니다. [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve)는 tailnet 내부에만 서비스를 열며 **Funnel은 사용하지 않습니다.**

1. `tailscale status --json`의 `Self.DNSName`에서 Mac의 전체 `*.ts.net` 이름을 확인합니다.
2. companion을 `CMUX_OMP_PUBLIC_URL=https://<Mac의-DNSName>:8443 npm run companion`으로 실행합니다. 이름 끝의 DNS 점은 제거하고 URL에는 경로를 붙이지 않습니다.
3. 기존 `tailscale serve status`에서 8443 포트를 사용하지 않는지 확인한 뒤 아래 명령을 실행합니다. HTTPS 활성화 승인을 요구하면 안내된 Tailscale 설정에서 승인합니다.

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:48732
npm run companion:pair
```

4. 휴대폰의 Tailscale을 연결한 상태에서 QR을 스캔합니다. 홈 화면에 추가해서 사용할 수 있지만 **오프라인 실행은 지원하지 않습니다.**

연결 해제는 `tailscale serve --https=8443 off`입니다. 다른 Serve 설정을 지우는 `serve reset`은 사용하지 마세요. 포트를 변경했다면 companion URL과 Serve 대상도 같이 맞춰야 합니다. Mac과 companion이 켜져 있고 깨어 있어야 예약 실행과 원격 제어가 동작합니다.

### 인증과 권한

- 서버는 loopback에만 바인딩하고, 인증된 allowlist API만 제공합니다. Host와 Origin을 정확히 검사하며 원격 origin은 `CMUX_OMP_PUBLIC_URL`로 명시해야 합니다.
- 페어링 토큰은 **Mac의 터미널과 명령 실행을 제어할 수 있는 비밀**입니다. 공개 채팅·로그·스크린샷에 남기지 마세요. 파일은 사용자 전용 권한이며 브라우저는 `sessionStorage`만 사용합니다. URL fragment의 토큰은 즉시 지웁니다.
- `npm run companion:rotate-token`은 기존 기기를 다음 API 요청부터 차단합니다. 새 QR로 다시 연결하세요. 로그아웃은 해당 브라우저 탭의 토큰만 지웁니다.
- 각 입력은 live workspace/surface UUID와 terminal 타입을 재확인합니다. 사라진 대상을 현재 터미널로 대체하지 않습니다.
- 자동화와 검사 명령은 **OS sandbox가 아닙니다.** 신뢰하는 저장소와 명령만 승인하세요. source checkout의 미커밋 변경은 격리 worktree에 복사하지 않으며 자동 merge/push/deploy도 하지 않습니다.

### 검증

```sh
npm run typecheck
npm run companion:test
npm test
```

companion 회귀 검사는 인증·origin·Host·토큰 폐기, 실제 셸 검사 기반 재시도·한도·worktree 격리, 예약 중복 방지·취소·재시작 복구, 프로젝트/글로벌 설치 격리·검토한 업데이트·로컬 변경 보존·심볼릭 링크 경계를 검사합니다. 모델 공급자를 호출하지 않는 결정적 RPC 드라이버를 사용합니다. 실제 OMP와 cmux 및 모바일 브라우저 실행은 별도의 smoke 검증 대상입니다.

## 핵심 흐름

1. **환경 설정**에서 OMP, Git, Node.js, GitHub CLI와 cmux를 확인하고 OMP/GitHub에 로그인합니다.
2. 프로젝트 폴더를 별칭으로 등록합니다. 절대 경로는 이 컴퓨터에만 남습니다.
3. **cmux + OMP**에서 프로젝트, 모델, 전문 프로필, Collab 접근 수준을 고른 뒤 native OMP TUI를 시작합니다.
4. **cmux + OMP → 프로필 관리**에서 전문 프로필을 편집하고, **Skills**에서 프로젝트·글로벌 스킬을 관리합니다.
5. 반복 작업은 Palace core automation 또는 선택 사항인 원본 Loops 엔진으로 실행합니다.

모델 및 thinking 선택기의 **Auto**는 별도 모델 인자를 넘기지 않고 OMP의 현재 기본값과 `modelRoles` 설정을 따릅니다. 전문 프로필은 이름, 모델, thinking, 추가 지침, `whenToUse` 역할 설명을 묶습니다. Loops는 builder, orchestrator, worker, verifier, validator, retro, controller처럼 역할을 분리하며, 역할 모델이 비어 있거나 `auto`이면 역시 OMP 기본 모델을 사용합니다.

## 기존 Palace 앱의 휴대폰 연결: native OMP Collab

휴대폰은 Palace나 Loops 대시보드를 경유하지 않고 **실행 중인 native OMP Collab에 직접** 연결합니다.

- native Collab을 지원하는 OMP와 OMP 로그인이 필요합니다. 현재 검증 버전은 18.2.5입니다.
- Palace에서 보기 전용 또는 제어 허용으로 세션을 시작하거나, OMP에서 `/collab view` 또는 `/collab`을 실행합니다.
- Palace가 OMP에서 받은 보기/제어 링크와 QR을 표시합니다. 링크는 `https://my.omp.sh`의 OMP 웹 클라이언트로 연결됩니다.
- Collab 링크는 해당 접근 권한을 가진 **비밀 capability URL**입니다. 메신저나 공개 이슈에 남기지 마세요.
- 공유를 끝낼 때 OMP에서 `/collab stop`을 실행해 capability를 폐기합니다.
- native Collab에는 Tailscale, 포트 포워딩, Palace 웹 게이트웨이가 필요하지 않습니다. Palace는 세션 상태와 링크 요청만 제어하며 휴대폰 트래픽을 프록시하지 않습니다.

native OMP Collab에는 Tailscale이 필요하지 않습니다. 위의 독립 companion이나 원본 Loops PWA를 사설망에서 열 때 사용하는 Tailscale 경로와 별개입니다.

## Native OMP와 Skills

코드 편집, 에이전트 대화, 터미널과 diff 확인은 cmux와 native OMP에서 수행합니다. Palace의 내장 IDE·Workbench·별도 터미널·파일/diff 화면은 제공하지 않습니다. 모델 조회와 전문 프로필 관리는 독립된 OMP 서비스로 유지하며, 기존 `workbench/state.json`의 전문 프로필은 첫 실행 때 `workbench/profiles.json`으로 이전합니다. 옛 상태 파일, 세션 기록과 작업 폴더는 수정하거나 삭제하지 않습니다.

Skills 화면은 모바일과 같은 카테고리별 추천, [skills.sh](https://skills.sh) 검색 또는 GitHub·로컬 Git 저장소 입력에서 설치 전 파일 미리보기로 이어집니다. **Project**는 선택한 프로젝트의 `.agent/skills`, **Global**은 현재 사용자의 `~/.agents/skills`에 설치합니다. 글로벌 설치는 프로젝트 동기화에서 제외하며 다음 안전장치를 사용합니다.

- 설치 레시피는 저장소, skill 경로와 **고정 revision**을 기록합니다.
- 업데이트도 먼저 새 revision의 내용을 검토해야 합니다.
- 로컬 수정·추가 파일이 있으면 업데이트·제거·동기화 적용을 중단해 변경을 보존합니다.
- 심볼릭 링크, 선택한 설치 루트 밖 경로, 자격 증명으로 보이는 파일과 비밀 문자열은 거부합니다.

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
- Skills 화면에서 관리하는 사용자 글로벌 설치
- 사용자 지정 endpoint/URL, 실행 명령, shell, hook, extension/MCP 등 로컬 실행 권한

push/pull은 기준 commit과 프로필 hash를 비교합니다. 앱에서 아직 push하지 않은 변경, Git 작업 트리 변경, 서로 갈라진 브랜치 또는 적용 중 충돌이 있으면 자동 덮어쓰지 않습니다. 미연결 프로젝트 별칭의 레시피는 경로를 연결할 때까지 보류합니다. 가져온 전문 프로필·Skills·Loops 설정의 적용은 `apply-pending` 상태로 먼저 기록되며, 로컬 skill 수정 같은 충돌로 실패하면 pending 상태를 유지합니다. 충돌을 해결하고 다시 적용하기 전까지 새 캡처로 원격 정의를 지우지 않습니다.

## 자동화

### Palace core automation

core automation은 수동, interval, 일일 시간대, 5-field cron, 인증 bearer webhook, GitHub 일정 폴링을 지원합니다. GitHub 트리거는 새 issue, PR review, 실패한 workflow run을 감지하며 첫 폴링은 과거 이벤트를 실행하지 않고 cursor만 초기화합니다. 외부 payload는 신뢰할 수 없는 데이터로 표시되고 delivery ID로 중복을 막습니다.

자동 실행에는 각 루프의 이 컴퓨터 승인, enabled, 전역 armed가 모두 필요합니다. 실행은 새 Git worktree와 브랜치에서 이루어집니다. 정책 확장은 파일 도구의 worktree 밖 접근과 알려진 push, merge, deploy, publish 및 remote mutation 명령을 거부합니다. 결정적 checks가 없으면 성공을 주장하지 않고 `needs-review`로 남기며, 성공·실패 모두 검토용 worktree/branch를 보존합니다. **core automation은 자동 merge나 deploy를 제공하지 않습니다.**

이 정책은 **OS 수준 sandbox가 아닙니다.** `bash`/`eval`, 프로젝트 스크립트와 checks는 로그인한 사용자의 권한으로 실행되므로 우회 가능한 명령 필터를 완전한 파일·네트워크 격리로 취급하면 안 됩니다. 신뢰하는 저장소와 스크립트만 승인하고, 강한 격리가 필요하면 별도 사용자나 VM에서 실행하세요.

cron, interval, webhook 수신, GitHub 폴링은 Palace automation service와 Mac이 깨어 있을 때만 동작합니다. 잠든 호스트를 원격에서 깨우는 서비스가 아닙니다.

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

요구 사항은 macOS, Node.js 22 이상, npm, Git입니다. 내장 터미널 전용 `node-pty`와 해당 네이티브 모듈 빌드 단계는 사용하지 않습니다.

```sh
cd /path/to/palace-omp
npm ci
npm run dev
```

Palace 기능을 실제로 쓰려면 OMP, cmux와 GitHub CLI도 설치하고 로그인합니다. 앱의 환경 설정 화면에서 상태를 확인하거나 Homebrew 설치를 실행할 수 있습니다.

## 명령

```sh
npm ci               # lockfile 그대로 의존성 설치
npm run dev          # Electron 개발 모드
npm run typecheck    # main/preload와 renderer TypeScript 점검
npm test             # 번들 Loops 엔진 regression tests
npm run build        # production bundle을 out/에 생성
npm run dist:mac     # macOS dmg/zip을 dist/에 생성
```

`npm run dist`는 현재 플랫폼 패키지, `npm run dist:mac`은 macOS 패키지를 만듭니다. 로컬 기본 패키지는 **unsigned**이므로 다른 Mac에서 Gatekeeper 경고가 날 수 있습니다. 인증서(`CSC_LINK` 또는 `PALACE_SIGN=1`)와 공증 변수를 별도로 제공한 경우에만 signing/notarization을 시도합니다.

`publish`는 `null`이고 기본 update feed도 연결되어 있지 않습니다. 따라서 이 저장소는 원본 Palace release를 게시하거나 원본 Palace 업데이트를 자동 설치하지 않습니다. 별도 `PALACE_OMP_UPDATE_URL`을 명시적으로 구성하지 않는 한 auto-update가 실행되지 않으며, 로컬 빌드는 어떤 release도 publish하지 않습니다.

## 보안 경계 요약

- companion은 Tailscale 사설 HTTPS와 별도 페어링 토큰을 사용합니다. 기존 Palace의 native phone access는 OMP Collab capability입니다.
- capability URL, Linear/Telegram token과 sync repository credential은 비밀로 취급합니다.
- core automation은 머신별 승인, 격리 worktree와 정책 검사를 사용하지만 OS sandbox는 아닙니다.
- 원본 Loops의 PR/direct delivery는 별도로 켜는 고권한 기능입니다.
- Palace와 Loops 모두 자동 merge/deploy를 제공하지 않습니다.
- 자동화 service와 호스트가 꺼지거나 잠들면 예약 실행과 자동 작업도 멈춥니다.

MIT · Godsenal
