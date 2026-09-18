#!/bin/zsh
# 한 루프의 액션(Linear 이슈) 1건 → 전용 worktree + cmux worker 탭. ⚠️ cmux 안에서 시작된 프로세스에서 호출해야 함.
# usage: spawn-worker.sh <loop-id> <issue-id>
set -u
source "${0:A:h}/_common.sh"
LOOP="${1:?usage: spawn-worker.sh <loop-id> <issue-id>}"
ID="${2:?usage: spawn-worker.sh <loop-id> <issue-id>}"
ROOT="$LOOPS_HOME"; LOOPDIR=$ROOT/loops/$LOOP; STATE=$LOOPDIR/state; CFG=$LOOPDIR/config.json
CMUX="$CMUX_BIN"
RUNNER=$ROOT/bin/worker-run.sh
REPO="$(cfgval "$CFG" repo)"; BASEREF="$(cfgval "$CFG" baseRef)"; [[ -z "$BASEREF" ]] && BASEREF=origin/develop
PREFIX="$(cfgval "$CFG" worktreePrefix)"; BRPFX="$(cfgval "$CFG" branchPrefix)"; [[ -z "$BRPFX" ]] && BRPFX="loop-$LOOP"

slug="$(slugof "$ID")"
WT="${PREFIX}-${slug}"; BR="${BRPFX}/${slug}"
git -C "$REPO" fetch origin -q
git -C "$REPO" worktree remove --force "$WT" 2>/dev/null
git -C "$REPO" branch -D "$BR" 2>/dev/null
if ! git -C "$REPO" worktree add -b "$BR" "$WT" "$BASEREF" 2>&1; then echo "ERROR: worktree 생성 실패 $WT"; exit 1; fi

# ⚠️ 워커도 spawn-panel 경유로 spawn — 워크스페이스 "생성"이 아니라 커맨드 "실제 발화(PTY 렌더)"까지 검증한다.
#   cmux lazy-PTY: 백그라운드/최소화 창에 raw new-workspace로 --command를 걸면 큐에만 얹혀 worker-run.sh가 한 줄도
#   실행되지 않고(pidfile 미기록), 🛠 타이틀 탭만 남아 In Progress 슬롯을 영구 점유한다(GOD-37·47·52: 워치독·리퍼·
#   corpse-closer 세 경로 모두 사각). panels에 이미 적용된 no-late-fire 원칙을 워커로 확장 — 생성→렌더 확인→실패 시
#   spawn-panel이 워크스페이스를 폐기(지연 발화 원천 차단)하고 비0 종료 → orphan 탭을 애초에 남기지 않는다.
#   ⚠️ 워커는 double-start 가드가 없으므로 SPAWN_PANEL_QUEUE_OK 절대 금지 — 여기서 export하지 않는다.
# 실패 우선 가드(파일 상단 worktree-add 가드와 동일 관용구): 실패면 정리 후 즉시 종료, 성공 경로는 기본 들여쓰기로 EOF까지.
#   `{ …; }`는 서브셸이 아닌 그룹이라 ref 대입이 현재 셸에 남는다 → 이후 성공 코드가 ref를 그대로 쓴다.
if ! { ref="$("$ROOT/bin/spawn-panel.sh" "$WT" "LOOP_ID=$LOOP LOOP_ISSUE=$ID $RUNNER" "🛠 $LOOP $ID" 2>>"$STATE/dispatcher.log")" && [[ -n "$ref" ]]; }; then
  # 머티리얼라이즈 실패 → spawn-panel이 워크스페이스를 이미 폐기(지연 발화 원천 차단). 방금 baseRef에서 갓 만든
  #   worktree/브랜치(커밋 0·유실 없음)도 되돌려 orphan을 남기지 않는다. Linear는 started로 올리지 않는다 —
  #   Backlog에 두면 orchestrator가 다음 사이클에 cap 안에서 재spawn(오케스트레이터가 팬아웃 전 이미 In Progress로
  #   옮긴 경우엔 리퍼가 no-worktree started 유령을 Backlog로 회수). 비0 종료로 무소음 실패 금지. no-merge/force-push 없음.
  git -C "$REPO" worktree remove --force "$WT" 2>/dev/null
  git -C "$REPO" branch -D "$BR" 2>/dev/null
  ts=$(date '+%s')
  print -r -- "{\"ts\":$ts,\"type\":\"worker\",\"event\":\"spawn-failed\",\"issue\":\"$ID\",\"branch\":\"$BR\"}" >> "$STATE/runs.jsonl"
  echo "[$(date '+%F %T')] WARN spawn $ID: cmux 머티리얼라이즈 실패 → 탭·worktree 폐기(orphan 방지) — Backlog 유지, 다음 사이클 재spawn" >> "$STATE/dispatcher.log"
  echo "spawn-failed $LOOP/$ID → cmux 머티리얼라이즈 실패(orphan 없음, 재spawn 예정)"
  exit 1
fi
# ── 이하 spawn 성공(탭이 실제 발화됨) ──
cnt=$("$CMUX" list-workspaces 2>/dev/null | grep -c 'workspace:')   # 맨 밑에 추가
"$CMUX" reorder-workspace --workspace "$ref" --index "$cnt" >/dev/null 2>&1
# Linear 이슈를 즉시 In Progress로 결정론적 선반영.
#   워커(LLM)가 시작 시 스스로 In Progress로 옮기지만, dead-at-startup(그 지시 실행 전 죽음)이면 Linear가 Backlog에 고정된다.
#   그러면 watchdog(in-flight=Linear started 기준)의 시야 밖 + 리퍼는 orphan 탭에 막혀 → 승인된 작업이 조용히 멈추는 blind spot.
#   (오케스트레이터 팬아웃은 spawn 전 LLM이 In Progress로 옮기지만 resolve-gate·start-issue 경로는 그 단계가 없어 이 blind spot에 노출됐다.)
#   여기서 결정론적으로 started로 올리면 dead-at-startup이어도 watchdog이 회수(heal)하거나 wedged로 표면화한다.
#   워커·오케스트레이터의 자체 In Progress 이동은 멱등 backstop으로 남는다(이미 started면 linear-move가 no-op).
#   best-effort — 탭은 이미 발화됐으므로 Linear 이동 실패는 치명적이지 않다(로그만; 워커 자체 이동이 커버). LINEAR_API_KEY는
#   loops.env에서 source되지만 export 안 돼 node 자식에 명시 전달(watchdog/cleanup-terminal과 동일 패턴).
if [[ -n "${LINEAR_API_KEY:-}" ]]; then
  if mvout="$(LINEAR_API_KEY="${LINEAR_API_KEY:-}" node "$ROOT/bin/linear-move.mjs" "$ID" started 2>&1)"; then
    echo "  → Linear: $mvout"
  else
    echo "[$(date '+%F %T')] WARN spawn $ID: linear-move started 실패 — $mvout (워커 자체 이동으로 커버, 무해)" >> "$STATE/dispatcher.log"
  fi
fi
ts=$(date '+%s')
print -r -- "{\"ts\":$ts,\"type\":\"worker\",\"event\":\"spawned\",\"issue\":\"$ID\",\"workspace\":\"$ref\",\"branch\":\"$BR\"}" >> "$STATE/runs.jsonl"
echo "spawned $LOOP/$ID → worktree=$WT branch=$BR tab=$ref"
