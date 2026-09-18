#!/bin/zsh
# cmux 패널 spawn의 단일 원천 — 워크스페이스 "생성"이 아니라 커맨드 "실행 시작"까지 책임진다.
#
# ⚠️ cmux 함정(실측): 워크스페이스=탭이고 --command 는 "텍스트+엔터 전송"이라, 렌더되지 않은(백그라운드/비포커스)
# 탭은 PTY가 없어 커맨드가 실행되지 않고 큐에 잠들었다가 **한참 뒤 렌더되는 순간 지연 실행**된다 — 죽은 줄 알았던
# 디스패처가 나중에 살아나 이중 기동되는 사고의 근원. cmux PTY 안(대화형 터미널·대시보드 패널)에서 호출하면 즉시
# materialize되지만, launchd·외부 셸에서는 안 된다.
# → 생성 후 read-screen으로 materialize를 검증하고, 안 되면 select → 앱 activate → 새 창 이동+포커스로 격상.
#   끝내 실패하면 확인된 자기 워크스페이스만 닫는다. ref를 받지 못하면 다른 탭을 추측해 닫지 않고 수동 확인을 요청한다.
#
# 예외 — SPAWN_PANEL_QUEUE_OK=1 (디스패처 전용): materialize 최종 실패 시 폐기 대신 타이틀에 " ⏳"를 붙여
#   큐에 남기고 exit 2. cmux가 백그라운드인 동안엔 어떤 새 탭도 렌더되지 않으므로(실측: activate/새창 격상도 무력)
#   폐기-재시도는 영원히 수렴하지 않는다 — 대신 큐 탭 1개를 남겨 사용자가 cmux를 전면화하는 순간 자동 발화시킨다.
#   이 지연 발화가 안전한 패널은 이중기동 가드(dispatch.sh pidfile alive-check)가 있는 디스패처뿐 — 워커·verifier 등에 쓰지 말 것.
#   ⏳ 마커 = "의도된 큐 탭"과 "cmux 재시작 복원 껍데기 셸"(둘 다 렌더 전 read-screen 실패)을 구분하는 신원.
#   supervisor/dashboard의 재사용·sweep 판정이 이 마커에 걸려 있고, dispatch.sh가 기동하며 마커를 벗긴다.
#
# usage: spawn-panel.sh <cwd> <command> [title]
# stdout: workspace ref (성공/큐 잔류 시). exit 0 = 커맨드 실행 시작 확인 · 1 = 실패(stderr 사유, 확인된 자기 탭만 정리)
#         · 2 = SPAWN_PANEL_QUEUE_OK=1 하에 큐 잔류(⏳ — cmux 전면화 시 발화 예정).
set -u
source "${0:A:h}/_common.sh"
CWD="${1:?usage: spawn-panel.sh <cwd> <command> [title]}"
CMD="${2:?command 필요}"
TITLE="${3:-}"
CMUX="$CMUX_BIN"
[[ -z "$CMUX" ]] && { echo "spawn-panel: cmux 없음(CMUX_BIN)" >&2; exit 1; }

# 전송할 명령이 길면 로그인 셸의 canonical 입력 버퍼에서 잘릴 수 있다.
# 짧은 파일 실행 명령만 PTY로 보내고 실제 스크립트 진입까지 확인한다.
launch_dir="$(mktemp -d "${TMPDIR:-/tmp}/palace-panel-XXXXXXXX")" || exit 1
keep_launch=0
trap '(( keep_launch )) || rm -rf -- "$launch_dir"' EXIT
(
  umask 077
  {
    printf 'print -r -- "$$" > %q\n' "$launch_dir/started"
    print -r -- "$CMD"
    printf '\nlaunch_status=$?\n[[ -f %q ]] && rm -rf -- %q\nexit "$launch_status"\n' "$launch_dir/queued" "$launch_dir"
  } > "$launch_dir/command.zsh"
)
launch_command="/bin/zsh ${(q)launch_dir}/command.zsh"

mat(){ [[ -s "$launch_dir/started" ]] && "$CMUX" read-screen --workspace "$ref" --lines 1 >/dev/null 2>&1; }
wait_mat(){ repeat "$1" { mat && return 0; sleep 0.5 }; return 1; }
activate(){ osascript -e "tell application id \"${CMUX_BUNDLE_ID:-com.cmuxterm.app}\" to activate" >/dev/null 2>&1; }
gone(){ ! CMUX_QUIET=1 "$CMUX" list-workspaces 2>/dev/null | grep -qE "(^|[^0-9])$1([^0-9]|\$)" }
# 폐기 — ⚠️ 실측: materialize되지 않은(=PTY 없는) 워크스페이스의 close-workspace는 cmux 소켓 RPC가 응답하지 않아
#   **타임아웃으로 실패**한다(rename-workspace도 같이 실패 → 제목조차 안 붙어 "Terminal"로 남는다). 그 실패가
#   >/dev/null로 삼켜져 검증되지 않았기 때문에 spawn 실패 1건 = 유령 탭 1개가 영구 적재됐고, 탭이 늘수록 cmux가
#   느려져 materialize 실패가 더 잦아지는 악순환이 된다(실측: 유령 93개, 워커 spawn-failed와 1:1).
#   select-workspace로 한 번 깨워주면 close가 즉시 성공한다 → 실패 시 select 후 재시도하고 목록으로 결과를 검증한다.
#   select은 사용자의 활성 탭을 잠깐 뺏으므로 원래 선택 탭을 복구한다. 그래도 남으면 무소음 실패 금지 — stderr로 알린다.
discard(){
  local r="$1" prev
  "$CMUX" close-workspace --workspace "$r" >/dev/null 2>&1
  gone "$r" && return 0
  prev="$(CMUX_QUIET=1 "$CMUX" list-workspaces 2>/dev/null | grep -F '[selected]' | grep -oE 'workspace:[0-9]+' | head -1)"
  "$CMUX" select-workspace --workspace "$r" >/dev/null 2>&1
  "$CMUX" close-workspace --workspace "$r" >/dev/null 2>&1
  [[ -n "$prev" ]] && "$CMUX" select-workspace --workspace "$prev" >/dev/null 2>&1
  gone "$r" && return 0
  echo "spawn-panel: 워크스페이스 폐기 실패($r) — 유령 탭이 남았다(수동 정리 필요)" >&2
  return 1
}
out="$("$CMUX" new-workspace --cwd "$CWD" --command "$launch_command" 2>&1)"
ref="$(print -r -- "$out" | grep -oE 'workspace:[0-9]+' | head -1)"
if [[ -z "$ref" ]]; then
  # cwd·기본 제목은 소유권 증명이 아니다. 동시에 열린 사용자의 터미널을 닫지 않는다.
  echo "spawn-panel: 생성 참조를 받지 못했습니다. cmux에 지연 실행 탭이 남았을 수 있으므로 직접 확인하세요. 다른 탭은 닫지 않았습니다." >&2
  echo "spawn-panel: new-workspace 실패 — $out" >&2
  exit 1
fi
[[ -n "$TITLE" ]] && "$CMUX" rename-workspace --workspace "$ref" "$TITLE" >/dev/null 2>&1
# 조용 모드(LOOPS_SPAWN_QUIET=1): 격상에서 앱 전면화(activate)·새 창(new-window)을 생략한다.
# → cmux가 자꾸 앞으로 튀어나오거나 새 창이 뜨는 방해를 없앤다. 대가: cmux 창이 화면에 안 보이면
#   (최소화·다른 Space) 탭이 렌더 안 돼 spawn이 큐잉(디스패처)되거나 폐기(워커)되고 다음 사이클에 재시도된다
#   — 즉시 시작 보장이 약해진다(cmux를 보고 있으면 select만으로 뜨므로 평소엔 영향 적음).
QUIET="${LOOPS_SPAWN_QUIET:-0}"

if ! wait_mat 4; then   # ~2s — cmux PTY 컨텍스트(대화형)면 이 안에 뜬다
  # 1차 격상: 활성 탭으로 선택(렌더 유도). 조용 모드가 아니면 앱도 전면화.
  "$CMUX" select-workspace --workspace "$ref" >/dev/null 2>&1
  [[ "$QUIET" == 1 ]] || activate
  if ! wait_mat 4; then
    # 2차 격상: 새 창(즉시 렌더됨)으로 이동 + 포커스 — 기존 창이 다른 Space/최소화 상태여도 통한다.
    # 조용 모드에선 생략(새 창·포커스 억제) → select만으로 못 뜨면 아래 QUEUE_OK/폐기로 떨어진다.
    if [[ "$QUIET" != 1 ]]; then
      wid="$("$CMUX" new-window 2>/dev/null | grep -oE '[0-9A-Fa-f-]{36}' | head -1)"
      if [[ -n "$wid" ]]; then
        "$CMUX" move-workspace-to-window --workspace "$ref" --window "$wid" >/dev/null 2>&1
        "$CMUX" focus-window --window "$wid" >/dev/null 2>&1
        activate
      fi
    fi
    if ! wait_mat 6; then
      if [[ "${SPAWN_PANEL_QUEUE_OK:-0}" == 1 ]]; then
        # 큐 잔류(헤더 참조): 폐기하지 않고 ⏳ 마킹 — cmux 전면화 시 자동 발화. 이중기동 가드 있는 패널 전용.
        [[ -n "$TITLE" ]] && "$CMUX" rename-workspace --workspace "$ref" "$TITLE ⏳" >/dev/null 2>&1
        print -r -- queued > "$launch_dir/queued"
        keep_launch=1
        echo "spawn-panel: PTY materialize 실패(${TITLE:-$CMD}) — 큐 잔류(⏳ $ref), cmux 전면화 시 자동 시작" >&2
        print -r -- "$ref"
        exit 2
      fi
      discard "$ref"
      echo "spawn-panel: PTY materialize 실패(${TITLE:-$CMD}) — 지연 실행 방지 위해 워크스페이스 폐기" >&2
      exit 1
    fi
  fi
fi

# 타이틀 재확정 — ⚠️ 실측: 생성 직후의 rename도 cmux 부하 시 조용히 타임아웃한다. 그러면 워커가 정상 발화했는데도
#   탭이 "Terminal"로 남고, 엔진의 생존/중복 판정이 전부 타이틀 정규식(🛠|↩|🔎)에 걸려 있어 **살아있는 워커가
#   엔진 시야에서 사라진다**(watchdog·리퍼·rework live-tab dedup 동시 사각 → 같은 이슈 중복 spawn). materialize된
#   지금은 RPC가 살아있으므로 여기서 재시도하고 목록으로 검증한다. 끝내 실패하면 무소음 금지 — stderr로 알린다.
if [[ -n "$TITLE" ]]; then
  has_title(){ CMUX_QUIET=1 "$CMUX" list-workspaces 2>/dev/null | strip_selected \
    | grep -qE "(^|[^0-9])$ref([^0-9]|\$).*$(print -r -- "$TITLE" | sed 's/[][\.*^$/]/\\&/g')" }
  repeat 3 { has_title && break; "$CMUX" rename-workspace --workspace "$ref" "$TITLE" >/dev/null 2>&1; sleep 0.3 }
  has_title || echo "spawn-panel: 타이틀 부여 실패($ref ← '$TITLE') — 엔진 생존판정에서 누락될 수 있다" >&2
fi
print -r -- "$ref"
