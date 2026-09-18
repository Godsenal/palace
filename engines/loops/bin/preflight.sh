#!/bin/zsh
# 전제도구 점검 + 가이드 설치 (install.sh 와 `loopctl doctor` 공용). loops.env 에 의존하지 않는다.
# 함수만 정의 — source 해서 loops_preflight <install|check> 로 호출.
#   install : 누락 도구마다 brew 설치를 y/N 으로 제안(기본 N), yes 면 실행. brew 없으면 brew부터 안내.
#   check   : 설치 안 하고 ✅/⚠️ 리포트만.
# 반환: 전역 LOOPS_MISSING 에 누락(필수) 도구 수. cmux 는 하드 전제(없으면 플랫폼 동작 불가).

# 도구의 실제 경로(없으면 ""). cmux 는 app bundle fallback, OMP는 ~/.local/bin도 확인한다.
loops_tool_path() {
  case "$1" in
    cmux)   command -v cmux 2>/dev/null || { [[ -x /Applications/cmux.app/Contents/Resources/bin/cmux ]] && echo /Applications/cmux.app/Contents/Resources/bin/cmux; } ;;
    omp)    [[ -x "$HOME/.local/bin/omp" ]] && { echo "$HOME/.local/bin/omp"; return; }
            command -v omp 2>/dev/null ;;
    # 실측 층(measure-*.mjs) 전용 — ego lite 온보딩이 ~/.local/bin 에 심는다. PATH에 없어도 여기서 찾아
    # install.sh 가 LOOPS_PATH_PREPEND 에 그 dir을 넣어준다(안 그러면 헤드리스 run에서 조용히 안 보인다).
    ego-browser) [[ -x "$HOME/.local/bin/ego-browser" ]] && { echo "$HOME/.local/bin/ego-browser"; return; }
            command -v ego-browser 2>/dev/null ;;
    chrome) command -v "google-chrome" 2>/dev/null || { [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]] && echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; } ;;
    *)      command -v "$1" 2>/dev/null ;;
  esac
}

# 도구별 설치 명령(macOS).
loops_install_cmd() {
  case "$1" in
    cmux)   echo "brew install --cask cmux" ;;
    gh)     echo "brew install gh && gh auth login" ;;
    node)   echo "brew install node" ;;
    git)    echo "xcode-select --install" ;;
    omp)    echo "brew install can1357/tap/omp && omp   # 최초 실행에서 provider 로그인" ;;
    brew)   echo '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' ;;
    ego-browser) echo "ego lite 앱 설치 + 온보딩 1회 → https://lite.ego.app/  (CLI가 ~/.local/bin 에 등록됨)" ;;
    chrome) echo "brew install --cask google-chrome   # Lighthouse가 띄울 브라우저" ;;
  esac
}

# 한 도구 처리. mode=install 이면 누락 시 설치 제안. 설치/존재하면 0, 미해결 누락이면 1.
_loops_one() {
  local tool="$1" mode="$2" tp cmd   # ⚠️ zsh: 'path'는 PATH와 연동된 특수변수 → local로 쓰지 말 것
  tp="$(loops_tool_path "$tool")"
  if [[ -n "$tp" ]]; then printf '  ✅ %-7s %s\n' "$tool" "$tp"; return 0; fi
  cmd="$(loops_install_cmd "$tool")"
  printf '  ⚠️  %-7s 미설치 — 설치: %s\n' "$tool" "$cmd"
  [[ "$mode" != install ]] && return 1
  # install 모드: brew 기반 도구만 자동설치 제안(OMP/git/brew는 인증/대화가 필요해 안내만).
  case "$tool" in cmux|gh|node) ;; *) return 1 ;; esac
  [[ -z "$(command -v brew 2>/dev/null)" ]] && { echo "     (brew 없음 — 위 명령 전에 brew 먼저 설치)"; return 1; }
  printf '     지금 설치할까요? [y/N] '; local ans; read -r ans
  [[ "$ans" == [yY] ]] || { echo "     건너뜀 — 나중에: $cmd"; return 1; }
  eval "$cmd" && { [[ -n "$(loops_tool_path "$tool")" ]] && return 0 || return 1; } || return 1
}

# 메인. mode = install|check. 전역 LOOPS_MISSING 에 (필수) 누락 수.
loops_preflight() {
  local mode="${1:-check}" tool
  typeset -g LOOPS_MISSING=0
  echo "🔧 전제도구 점검 (mode=$mode):"
  # brew 는 설치 도우미 — 먼저 알린다(없어도 cmux 등은 수동 가능).
  [[ -z "$(command -v brew 2>/dev/null)" ]] && printf '  ⚠️  %-7s 미설치 — 설치: %s\n' brew "$(loops_install_cmd brew)"
  # 필수: git node omp gh cmux. gh/OMP는 각각 인증이 필요하고 cmux는 실행 중이어야 한다.
  for tool in git node omp gh cmux; do
    _loops_one "$tool" "$mode" || LOOPS_MISSING=$((LOOPS_MISSING+1))
  done
  # 선택: 실측 층(config `measure` 블록이 있는 루프)에서만 필요 — 없어도 나머지 플랫폼은 정상 동작하므로
  # 누락 수에 세지 않는다. 다만 있으면 install.sh 가 PATH에 넣어줘야 헤드리스 run에서 보인다.
  for tool in ego-browser chrome; do
    local otp="$(loops_tool_path "$tool")"
    if [[ -n "$otp" ]]; then printf '  ✅ %-11s %s\n' "$tool" "$otp"
    else printf '  ℹ️  %-11s 미설치 (선택 — 실측 루프에서만 필요) — %s\n' "$tool" "$(loops_install_cmd "$tool")"; fi
  done
  if (( LOOPS_MISSING )); then
    echo "  → 미해결 누락 ${LOOPS_MISSING}개. cmux가 실행 중이고 호출 탭의 ancestry가 없으면 dispatcher/worker spawn이 동작하지 않습니다."
  else
    echo "  → 전제도구 모두 준비됨 ✅"
  fi
  return 0
}
