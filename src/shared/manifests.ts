import type { Manifest } from './types'

// palace 내장 카탈로그. 사용자 추가 매니페스트는 ~/.palace/apps/*.json 에서 로드된다.
export const BUILTIN_MANIFESTS: Manifest[] = [
  {
    id: 'dotfiles',
    name: 'dotfiles',
    tagline: '내 셸·git·ssh·claude 설정 — 새 컴퓨터에 그대로 복원',
    description:
      '멱등 install.sh 가 zsh/git/npm/mise/ssh/claude 설정을 $HOME 에 심링크한다. 기존 파일은 .bak 로 백업하고 시크릿은 건드리지 않는다. 새 컴퓨터에서 palace 로 이거 하나만 "설치"하면 내 개발환경 설정이 복원된다. 서버가 아니라 1회 적용형이라 시작/대시보드가 없다.',
    repo: 'git@github.com:Godsenal/dotfiles.git',
    repoHttps: 'https://github.com/Godsenal/dotfiles',
    runtime: 'other',
    detectPaths: ['~/dotfiles', '~/.dotfiles'],
    accent: '#9aa0aa',
    prerequisites: [
      {
        name: 'git',
        check: 'command -v git',
        install: 'xcode-select --install',
        manual: true,
        note: 'Xcode Command Line Tools 설치 창이 뜹니다 — 시스템 GUI 라 수동.'
      },
      {
        name: 'GitHub 인증',
        check: 'gh auth status >/dev/null 2>&1 || ssh -o BatchMode=yes -T git@github.com 2>&1 | grep -qi "successfully authenticated"',
        install: 'gh auth login',
        manual: true,
        note: 'private repo clone 에 필요. 새 컴퓨터에서 한 번 `gh auth login`(또는 SSH 키 등록).'
      }
    ],
    install: [{ run: './install.sh' }],
    update: [{ run: 'git pull --ff-only' }, { run: './install.sh' }],
    launchMode: 'manual',
    readme: 'README.md',
    notes:
      '멱등이라 몇 번 돌려도 안전(기존 파일은 .bak.<타임스탬프> 백업). "업데이트" = git pull + install.sh 재적용. ~/.npmrc 도 여기서 심링크된다(내부 레지스트리 설정 포함).',
    builtin: true
  },
  {
    id: 'cmux-remote',
    name: 'cmux-remote',
    tagline: '폰에서 cmux 터미널(Claude Code 등)을 조종',
    description:
      'cmux 옆에 붙는 작은 Bun 서버. cmux 의 Unix 소켓을 읽어 Tailscale 망으로 폰 친화 PWA 를 서빙한다. QR 스캔 → 맥에 켜둔 터미널이 손안에. 에이전트가 사람을 필요로 하면 Apple 푸시.',
    repo: 'git@github.com:Godsenal/cmux-remote.git',
    repoHttps: 'https://github.com/Godsenal/cmux-remote',
    runtime: 'bun',
    detectPaths: ['~/LTH/cmux-remote'],
    accent: '#7c9cff',
    prerequisites: [
      {
        name: 'Homebrew',
        check: 'command -v brew',
        install: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        manual: true,
        note: '최초 설치에 관리자 암호가 필요해 터미널에서 직접 실행해야 합니다.'
      },
      { name: 'bun', check: 'bun --version', install: 'curl -fsSL https://bun.sh/install | bash' },
      {
        name: 'cmux',
        check: 'command -v cmux >/dev/null 2>&1 || test -d "/Applications/cmux.app"',
        install: 'brew install --cask cmux'
      },
      {
        name: 'tailscale',
        check: 'command -v tailscale >/dev/null 2>&1 || test -d "/Applications/Tailscale.app"',
        install: 'brew install --cask tailscale',
        optional: true,
        manual: true,
        note: '설치 후 같은 계정으로 로그인해야 원격/푸시가 됩니다(로그인은 수동).'
      }
    ],
    install: [{ run: 'bun install' }],
    update: [{ run: 'git pull --ff-only' }, { run: 'bun install' }],
    launchMode: 'cmux',
    start: { run: 'bun start' },
    dashboard: { url: 'http://localhost:8787', port: 8787 },
    readme: 'README.md',
    notes:
      'cmux 는 cmux 아래에서 spawn 된 프로세스의 소켓 연결만 허용한다(access_mode: cmuxOnly). 따라서 반드시 cmux 터미널에서 실행해야 한다 — palace 는 명령을 cmux 로 위임한다.',
    builtin: true
  },
  {
    id: 'loops',
    name: 'loops',
    tagline: '멀티 루프 자율 Claude Code 에이전트 플랫폼',
    description:
      '한 줄 mission 만 주면 주기적으로 도는 자율 에이전트("loop") 를 여러 개 돌린다. 각 loop 은 자기 도메인의 작업을 발굴하고 worker 가 1건씩 구현→PR. 머지는 사람이. cmux 탭에서 worker 가 라이브로 돌고, 대시보드에서 세션을 연다.',
    repo: 'git@github.com:Godsenal/loops.git',
    repoHttps: 'https://github.com/Godsenal/loops',
    runtime: 'node',
    detectPaths: ['~/LTH/loops'],
    accent: '#f0a35e',
    prerequisites: [
      {
        name: 'Homebrew',
        check: 'command -v brew',
        install: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        manual: true,
        note: '최초 설치에 관리자 암호가 필요해 터미널에서 직접 실행해야 합니다.'
      },
      {
        name: 'git',
        check: 'command -v git',
        install: 'xcode-select --install',
        manual: true,
        note: 'Xcode Command Line Tools 설치 창이 뜹니다 — 시스템 GUI 라 수동.'
      },
      {
        name: 'cmux',
        check: 'command -v cmux >/dev/null 2>&1 || test -d "/Applications/cmux.app"',
        install: 'brew install --cask cmux'
      },
      { name: 'claude', check: 'command -v claude', install: 'curl -fsSL https://claude.ai/install.sh | bash' },
      { name: 'gh', check: 'command -v gh', install: 'brew install gh' },
      { name: 'node', check: 'command -v node', install: 'brew install node' }
    ],
    // 최초 설치는 대화형(brew 설치 제안)이므로 cmux 터미널에서 하는 걸 권장.
    install: [{ run: './install.sh' }],
    update: [{ run: 'git pull --ff-only' }],
    launchMode: 'cmux',
    start: { run: 'loopctl dashboard' },
    dashboard: { url: 'http://localhost:8422', port: 8422 },
    readme: 'README.md',
    extraDocs: ['CLAUDE.md'],
    env: { file: 'loops.env', example: 'loops.env.example' },
    notes:
      'install.sh 는 대화형(brew 설치 제안)이라 최초 셋업은 cmux 터미널 권장. 대시보드/디스패처는 cmux 패널에서 실행되어야 한다. loopctl 은 install.sh 가 ~/.local/bin 에 전역 등록한다.',
    builtin: true
  }
]
