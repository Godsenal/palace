#!/bin/zsh
# Palace 패키지에 포함된 versioned assets만 신뢰한다. 이 runtime은 upstream Git 저장소가 아니며
# 자체 fetch/pull/reset을 절대 하지 않는다. LoopsEngineHost가 앱 시작 시 코드/assets만 동기화하고
# loops.env·loops/·products/·state/는 보존한다.
set -u
source "${0:A:h}/_common.sh"
manifest="$LOOPS_HOME/state/.palace-assets.json"
if [[ -f "$manifest" ]]; then
  [[ -n "${LOOPS_UPDATE_QUIET:-}" ]] || echo "[self-update] Palace 관리 assets 사용 중: $(cat "$manifest")"
else
  echo "[self-update] Palace asset manifest 없음 — Palace에서 엔진을 다시 시작해 동기화하세요"
fi
exit 0
