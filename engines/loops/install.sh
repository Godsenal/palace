#!/bin/zsh
# Loops 플랫폼 로컬 준비 — 도구 탐지 → loops.env 생성, 엔진의 .agent/skills 등록.
# usage: ./install.sh
set -u
LOOPS_HOME="${0:A:h}"
REMOTE_OPT=0; [[ "${1:-}" == "remote" || "${1:-}" == "--remote" ]] && REMOTE_OPT=1   # ./install.sh remote → 폰 원격(tailscale) 켜서 설치
echo "📦 Loops 설치 — LOOPS_HOME=$LOOPS_HOME"

# --- 전제도구 점검 + 가이드 설치 (공유 preflight: 누락 시 brew 설치 y/N 제안) ---
source "$LOOPS_HOME/bin/preflight.sh"
loops_preflight install
echo

# 설치/탐지 후 최종 경로 해석.
NODE="$(loops_tool_path node)"; GH="$(loops_tool_path gh)"; CMUX="$(loops_tool_path cmux)"; OMP="$(loops_tool_path omp)"
miss=$LOOPS_MISSING

# PATH prepend = node/omp/gh(+있으면 ego-browser) 디렉터리.
EGO="$(loops_tool_path ego-browser)"
typeset -aU dirs
for b in "$NODE" "$OMP" "$GH" "$EGO"; do [[ -n "$b" ]] && dirs+=("${b:h}"); done
PREPEND="${(j.:.)dirs}"

# 기존 값 보존(재실행 시) — loops.env 있으면 WORKTREE_BASE/DEFAULT_REPO/PORT/BUNDLE 유지
WT_BASE="$HOME/LTH"; DEF_REPO=""; PORT="8422"; BUNDLE="com.cmuxterm.app"
# 비관리 키(LINEAR_API_KEY·LOOPS_REMOTE_AUTH·사용자 커스텀)는 그대로 보존 — 재실행이 키를 날리면 안 됨.
MANAGED="LOOPS_PATH_PREPEND OMP_COMMAND OMP_BIN CMUX_BIN GH_BIN CMUX_BUNDLE_ID WORKTREE_BASE DEFAULT_REPO LOOPS_PORT"
EXTRA=""
if [[ -f "$LOOPS_HOME/loops.env" ]]; then
  source "$LOOPS_HOME/loops.env" 2>/dev/null
  WT_BASE="${WORKTREE_BASE:-$WT_BASE}"; DEF_REPO="${DEFAULT_REPO:-$DEF_REPO}"
  PORT="${LOOPS_PORT:-$PORT}"; BUNDLE="${CMUX_BUNDLE_ID:-$BUNDLE}"
  while IFS= read -r ln; do
    [[ -z "$ln" || "$ln" == \#* ]] && continue
    [[ " $MANAGED " == *" ${ln%%=*} "* ]] && continue
    EXTRA+="$ln"$'\n'
  done < "$LOOPS_HOME/loops.env"
fi

cat > "$LOOPS_HOME/loops.env" <<EOF
# 자동 생성 (install.sh). 머신별 도구 경로 — 수정 가능.
LOOPS_PATH_PREPEND="$PREPEND"
OMP_BIN="$OMP"
OMP_COMMAND="${OMP_COMMAND:-$OMP}"
CMUX_BIN="$CMUX"
GH_BIN="$GH"
CMUX_BUNDLE_ID="$BUNDLE"
WORKTREE_BASE="$WT_BASE"
DEFAULT_REPO="$DEF_REPO"
LOOPS_PORT="$PORT"
EOF
[[ -n "$EXTRA" ]] && { print -r -- "# --- 보존된 키 (대시보드/원격 등이 기록) ---" >> "$LOOPS_HOME/loops.env"; printf '%s' "$EXTRA" >> "$LOOPS_HOME/loops.env"; }
# remote 옵션: LOOPS_REMOTE=1 을 loops.env에 확정(코드베이스 단일 원천 env-file.mjs로 치환-또는-추가).
(( REMOTE_OPT )) && { node --input-type=module -e 'const {setEnvVar}=await import(process.argv[1]+"/bin/env-file.mjs");setEnvVar(process.argv[1],"LOOPS_REMOTE","1")' "$LOOPS_HOME" && echo "📱 LOOPS_REMOTE=1 — 대시보드가 tailscale IP에도 바인딩(폰 원격). 폰에도 Tailscale 로그인 필요."; }
echo "✅ loops.env 생성 (기존 LINEAR_API_KEY 등 보존)"

# 스킬이 LOOPS_HOME 찾는 포인터
echo "$LOOPS_HOME" > "$HOME/.loops-home"

# 엔진 프로젝트 전용 OMP 스킬. 사용자 홈/global 설정은 수정하지 않는다.
mkdir -p "$LOOPS_HOME/.agent/skills"
ln -sfn "$LOOPS_HOME/skills/create-loop" "$LOOPS_HOME/.agent/skills/create-loop"
echo "✅ create-loop 스킬 등록 ($LOOPS_HOME/.agent/skills/create-loop)"

# loopctl 전역 등록 (~/.local/bin symlink → 어디서나, 어느 cwd에서나 `loopctl …`).
# _common.sh가 ${0:A:h}로 LOOPS_HOME을 유도하고 :A가 symlink를 실제 경로로 해석하므로 cwd·심볼릭 무관 동작.
BINDIR="$HOME/.local/bin"; mkdir -p "$BINDIR"
ln -sfn "$LOOPS_HOME/loopctl" "$BINDIR/loopctl"
if echo ":$PATH:" | grep -q ":$BINDIR:"; then
  echo "✅ loopctl 전역 등록 ($BINDIR/loopctl → repo) — 어디서나 'loopctl cleanup <loop>' 등 실행 가능"
else
  echo "✅ loopctl 심볼릭 생성 ($BINDIR/loopctl) — ⚠️ $BINDIR 가 PATH에 없음: ~/.zshrc 에 'export PATH=\"\$HOME/.local/bin:\$PATH\"' 추가 후 새 셸"
fi

# 디렉토리 + 실행권한
mkdir -p "$LOOPS_HOME/loops" "$LOOPS_HOME/state"
chmod +x "$LOOPS_HOME/loopctl" "$LOOPS_HOME/dashboard-server.mjs" "$LOOPS_HOME/bin/"*.sh "$LOOPS_HOME/bin/"*.mjs 2>/dev/null

# 자동 복구: supervisor(launchd, 60s) 등록 — cmux 재시작/크래시 뒤 죽은 디스패처·대시보드·봇을 자동 재기동.
# 새 컴퓨터에서 install.sh(palace 설치 포함)만으로 자동화가 걸리도록 여기서 배선한다. macOS 전용·멱등·실패해도 설치는 성공.
if [[ "$(uname)" == "Darwin" ]]; then
  if launchctl print "gui/$(id -u)/com.loops.supervisor" >/dev/null 2>&1; then
    echo "✅ supervisor 이미 등록됨 (launchd 60s)"
  elif "$LOOPS_HOME/loopctl" supervisor install >/dev/null 2>&1; then
    echo "✅ supervisor 자동 등록 (launchd 60s) — 죽은 디스패처/대시보드/봇 자동 재기동"
  else
    echo "ℹ️  supervisor 등록 건너뜀 — 필요시 'loopctl supervisor install' 수동 실행"
  fi
fi

echo
echo "완료 ✅  다음 (loopctl 은 어느 디렉토리에서나 실행 가능):"
echo "  loopctl dashboard          # 대시보드 (http://localhost:$PORT, cmux 패널)"
echo "  loopctl start              # 디스패처 시작"
echo "  loopctl cleanup <loop>     # 종료된 worktree·탭 정리 (--dry 로 미리보기)"
echo "  loop 추가: 대시보드 '+ 새 loop' (AI 생성) 또는 examples/ 복사 → loops/<id>/"
[[ -z "$DEF_REPO" ]] && echo "  (선택) loops.env 의 DEFAULT_REPO 에 기본 repo 절대경로를 넣으면 AI 빌더가 편함"
[[ $miss -gt 0 ]] && echo "⚠️  전제도구 ${miss}개 미해결 — 위 설치 명령 실행 후 './install.sh' 재실행 (또는 'loopctl doctor' 로 재점검)"
