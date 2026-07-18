# 👑 palace

당신이 만든 self-hosted 도구들(`cmux-remote`, `loops`, …)의 **관제 데스크탑 앱**.
어느 컴퓨터든 palace 하나만 깔면 — 카탈로그에서 골라 **설치**하고, **상태**를 보고, **시작/정지**하고,
각 앱의 **대시보드를 임베드**해서 보고, **업데이트**하고, **README 사용법**을 읽는다.
앞으로의 도구는 **매니페스트 한 장**으로 계속 추가된다.

## 무엇을 하나

- **카탈로그** — 내장(cmux-remote, loops) + 사용자 추가 앱. 설치됨/미설치·실행중/정지·버전·git 상태를 한눈에.
- **설치** — `git clone` + 설치 스텝. 이미 `~/LTH` 등에 clone 돼 있으면 재clone 없이 **감지**.
- **시작/정지** — `launchMode` 에 따라 palace 가 직접 프로세스로 띄우거나(process), cmux 터미널로 위임(cmux).
  누가 켰든 **대시보드 포트가 뜨면 실행중으로 표시**하고 임베드한다.
- **대시보드 임베드** — 실행 중이면 `<webview>` 로 각 앱의 로컬 대시보드(loops 8422, cmux-remote 8787 …)를 그대로 띄운다.
- **업데이트** — `git fetch` 로 뒤처짐 감지 → `git pull`(+ 재설치). 허브 자체는 electron-updater.
- **진단(Doctor)** — 전제 도구(bun/cmux/gh/tailscale …) 점검 + 설치 명령 복사.
- **문서** — 설치된 앱의 README(및 CLAUDE.md 등)를 렌더링.

## 개발

```sh
cd ~/LTH/palace
npm install
npm run dev          # 개발 모드 (HMR)
npm run typecheck    # 타입 점검
npm run build        # 프로덕션 번들 → out/
npm run dist:mac     # .dmg / .zip 패키징 → dist/
```

## 앱을 어떻게 추가하나 (확장)

두 가지 방법:

1. **UI** — 좌하단 `＋ 앱 추가` → GitHub 저장소 URL + 시작/설치 명령 + 대시보드 URL 입력.
   `~/.palace/apps/<id>.json` 에 매니페스트로 저장된다.
2. **파일** — 아래 형태의 JSON 을 `~/.palace/apps/` 에 직접 떨군다:

```jsonc
{
  "id": "my-tool",
  "name": "my-tool",
  "tagline": "한 줄 소개",
  "repo": "git@github.com:Godsenal/my-tool.git",
  "runtime": "bun",
  "launchMode": "cmux",              // process | cmux | manual
  "install": [{ "run": "bun install" }],
  "update": [{ "run": "git pull --ff-only" }],
  "start": { "run": "bun start" },
  "dashboard": { "url": "http://localhost:3000", "port": 3000 },
  "prerequisites": [{ "name": "bun", "check": "bun --version", "install": "curl -fsSL https://bun.sh/install | bash" }],
  "readme": "README.md",
  "extraDocs": ["CLAUDE.md"]
}
```

내장 카탈로그는 `src/shared/manifests.ts` 에 있다.

## 구조

```
src/
  main/         Electron main (Node) — git·프로세스·헬스·IPC
    index.ts    윈도우·수명주기·자동업데이트·헬스 폴링
    appManager.ts  설치/업데이트/시작/정지/닥터/문서 오케스트레이션
    registry.ts    내장+사용자 매니페스트 로드, 설치 경로 해석
    exec.ts        로그인 셸로 명령 실행(PATH 확보)·스트리밍·장기 spawn
    git.ts / health.ts / markdown.ts / paths.ts / ipc.ts
  preload/      contextBridge → window.palace
  renderer/     React UI (사이드바·상세·대시보드 임베드·로그·문서·진단·모달)
  shared/       타입 + 내장 매니페스트
```

## 아키텍처 메모

- **cmux 전제 앱** (cmux-remote·loops) 은 cmux 아래에서 실행돼야 한다(access_mode: cmuxOnly / cmux 패널).
  그래서 `launchMode: "cmux"` — palace 는 시작 명령을 클립보드에 넣고 cmux 를 연다. 임베드/상태는 포트 헬스로 동작.
- 명령은 **로그인 셸(`zsh -l -c`)** 로 실행해 GUI 앱의 빈약한 PATH 문제(bun·loopctl·brew 못 찾음)를 피한다.
- 문서 HTML 은 main 에서 `marked` 로 렌더 → renderer 에서 `DOMPurify` 로 새니타이즈 후 주입.

MIT · Godsenal
