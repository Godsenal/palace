# CLAUDE.md — palace

> 👑 **palace** = Godsenal(=이 저장소 소유자)가 만든 self-hosted 도구들(cmux-remote, loops, …)의
> **관제 데스크탑 앱**. 한 곳에서 설치·실행·모니터링·업데이트하고, 새 도구는 **매니페스트 한 장**으로 늘린다.
> Electron + React + TypeScript. macOS 전용.

이 파일은 이 저장소에서 작업하는 다음 세션(사람/Claude)을 위한 안내다. 코드 구조는 아래를 신뢰하되,
파일/심볼/플래그를 추천하기 전엔 실제로 존재하는지 확인할 것.

## 빠른 시작

```sh
npm install
npm run dev          # 개발(HMR)
npm run typecheck    # tsc (node + web 프로젝트 둘 다) — 커밋 전 필수
npm run build        # 프로덕션 번들 → out/
npm run dist:mac     # .dmg/.zip 패키징 → dist/ (로컬 unsigned)
```

## 아키텍처

Electron 3-프로세스 + 공유 타입. **모든 프로세스가 `src/shared/types.ts` 계약을 공유**한다.

```
src/
  main/      Electron main (Node). git·프로세스·헬스·IPC.
    index.ts        BrowserWindow·수명주기·electron-updater·4초 헬스 폴링
    appManager.ts   ★핵심 오케스트레이터: 상태계산·설치·업데이트·시작/정지·닥터·문서·env
    registry.ts     내장+사용자 매니페스트 로드, 설치경로 해석(resolveDir)
    exec.ts         로그인 셸로 명령 실행(스트리밍/캡처/장기 spawn)
    git.ts  health.ts  markdown.ts  env.ts  paths.ts  ipc.ts
  preload/   contextBridge → window.palace (PalaceAPI)
  renderer/  React UI. App.tsx(사이드바·상태·모달) + components/*
             Detail(탭 라우팅) · DashboardEmbed(webview) · Logs · Docs · Doctor · EnvEditor · Modals
  shared/    types.ts(계약) + manifests.ts(내장 카탈로그: cmux-remote, loops)
```

데이터 흐름: renderer가 `window.palace.*`(IPC invoke) 호출 → main의 AppManager가 처리 →
상태 변경 시 `emitState()`가 전체 AppView[]를 재계산해 `palace:state`로 브로드캐스트(+ `palace:log`,
`palace:progress` 스트림). renderer는 이벤트 구독으로 갱신.

## 반드시 지킬 규약 (깨지기 쉬운 것들)

- **CJS 빌드**: `package.json`에 `"type": "module"` **넣지 말 것**. preload가 `.js`(CJS)로 나와야
  안정적으로 로드된다. `marked`는 ESM 전용이라 main 번들에 **포함**시킨다
  (`electron.vite.config.ts`의 `externalizeDepsPlugin({ exclude: ['marked'] })`).
- **로그인 셸 실행**: 모든 외부 명령은 `exec.ts`를 통해 `zsh -l -c`로 실행한다. GUI Electron은 PATH가
  빈약해 bun·loopctl·brew·cmux를 못 찾기 때문. 새 실행 경로도 반드시 이걸 쓸 것.
- **문서 렌더**: main에서 `marked`로 HTML 생성 → renderer에서 `DOMPurify.sanitize` 후 주입. main에서
  새니타이즈하지 말 것(Node엔 DOM 없음).
- **대시보드 임베드**: `<webview>` 태그(BrowserWindow `webviewTag: true`). 실행중 판정은 **대시보드
  포트 헬스**(`health.isPortOpen`)로 하므로, cmux에서 켠 것도 자동 인식된다.

## 앱(매니페스트) 모델

- 앱 = `Manifest`(`src/shared/types.ts`). 내장은 `src/shared/manifests.ts`, 사용자 추가는
  `~/.palace/apps/*.json`. 같은 id면 사용자 것 우선.
- **설치 감지**: `resolveDir`가 `detectPaths`(예 `~/LTH/cmux-remote`)에 이미 clone돼 있으면 재clone 안 함.
  없으면 `installRoot`(기본 `~/LTH`)/`<id>`로 clone.
- **launchMode**: `process`(palace가 자식 프로세스로 spawn) / `cmux`(cmux CLI `new-workspace
  --cwd --command`로 위임 — cmuxOnly 도구용) / `manual`. cmux-remote·loops는 `cmux`.
- 새 앱 추가 절차는 **`docs/새-앱-추가하기.md`** 참고.

## 설정·경로

- palace 설정: `~/.palace/settings.json`(installRoot, shell, theme). 사용자 매니페스트: `~/.palace/apps/`.
- 앱 설치 루트 기본값: `~/LTH`(사용자 관례). 대부분의 도구가 여기 clone돼 있다.

## CI / 릴리즈 / 서명

- `.github/workflows/ci.yml`: main push/PR → `typecheck` + `build`(ubuntu, **Node 22**).
- `.github/workflows/release.yml`: `v*` 태그 → macOS 빌드 → **GitHub Releases 게시**(`.dmg`/`.zip`/
  `latest-mac.yml`) → 기존 palace가 electron-updater로 갱신.
- 릴리즈 컷: `npm version patch && git push && git push --tags`.
- 서명/공증: `electron-builder.config.cjs`가 `CSC_LINK` 존재를 감지해 자동 서명+공증 경로로 전환
  (없으면 unsigned). 방법은 **`docs/배포-서명-릴리즈.md`**.

## ⚠️ 실환경 함정 (겪고 해결한 것)

- **npm 레지스트리**: 이 머신 `~/.npmrc`가 사내 npm 프록시를 가리킨다 → `npm install`이 만든
  `package-lock.json`의 resolved URL이 내부 호스트를 가리켜 **공개 CI 러너에서 `EALLOWREMOTE`로 실패**.
  lockfile 갱신 후엔 반드시 공개 레지스트리로 정규화(경로 동일 → integrity 유지):
  `sed -i '' 's#https://<사내-npm-proxy-호스트>/#https://registry.npmjs.org/#g' package-lock.json`
- **CI Node 버전**: 20은 번들 npm의 `Exit handler never called!` 버그로 `npm ci`가 조용히 실패(exit 0인데
  설치 불완전)한다. 워크플로우는 **Node 22 + `npm install -g npm@latest`**.
- **git upstream 미설정 → 업데이트/감지 실패**: palace 로 clone 하지 않고 미리 있던 repo(detectPaths)나
  tracking 없이 셋업된 repo 는 `main` 에 upstream 이 없어 `git pull --ff-only` 가 "no tracking
  information" 으로 exit 1, `@{u}` 기반 behind 감지도 죽는다. → `git.ts`의 **`ensureUpstream()`**이
  install(clone 직후)·fetchAndCompare(감지)·update(직전)에서 `origin/<branch>` 로 자가치유한다. 새 git
  실행 경로를 추가하면 이걸 먼저 태울 것.
- **cmux `new-workspace` 는 앱이 떠 있어야 함**: `cmux <path>`와 달리 스스로 앱을 안 띄우고 "caller's
  window" 에 워크스페이스를 만든다 → cmux 미실행 상태에서 위임하면 실패해 클립보드 폴백으로 빠진다.
  `openInCmux` 는 **`ensureCmuxRunning()`**(probe=`cmux list-workspaces`, 안 뜨면 `open -a cmux` 후
  소켓 응답까지 폴링)으로 먼저 앱을 깨운 뒤 위임한다. 로그 소음 줄이려 `CMUX_QUIET=1` 프리픽스.

## 관례

- 커밋/PR은 요청받았을 때만. 기본 브랜치 `main`. 원격 `Godsenal/palace`(private).
- 주석·UI 문구는 한국어. 타입 우선(shared 계약 먼저 바꾸고 main/preload/renderer 순).
- 커밋 전 `npm run typecheck` 통과 확인.
