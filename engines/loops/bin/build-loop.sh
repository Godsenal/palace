#!/bin/zsh
# AI 루프 빌더 — 한 줄 설명을 받아 OMP가 최적 루프(mission+Linear+config)를 구성.
# usage: build-loop.sh <base64-encoded-description>
set -u
source "${0:A:h}/_common.sh"
ROOT="$LOOPS_HOME"
DESC="$(echo "${1:?usage: build-loop.sh <base64-desc>}" | base64 -d 2>/dev/null)"
PROMPT="$(cat "$ROOT/bin/loop-builder.md")"
echo "════════ 🤖 루프 빌더 시작  $(date '+%F %T') ════════"
echo "요청: $DESC"
echo
FINAL_PROMPT="$PROMPT

═══ 사용자 요청 ═══
$DESC"
print -rn -- "$FINAL_PROMPT" | omp_live builder "${LOOPS_BUILDER_MODEL:-}"
echo "════════ 🤖 빌더 종료  $(date '+%F %T') ════════"
