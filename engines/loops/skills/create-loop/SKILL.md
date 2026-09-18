---
name: create-loop
description: Create a new autonomous loop for the Loops platform from a one-line description. Use when the user wants a recurring OMP agent for a domain such as refactoring, SEO, dead-code cleanup, i18n coverage, QA, or bug triage. Generates the mission, creates a Linear project ledger, and writes a disabled-for-review config; the shared engine handles scheduling, native PR delivery, human gates, and no-merge fan-out.
---

# Loops 플랫폼 — 루프 생성 스킬

사용자가 한 줄로 설명한 자율 루프를 만들어 Loops 플랫폼에 등록한다.

## 절차
1. **플랫폼 위치 확인**: `LOOPS_HOME="$(cat ~/.loops-home)"` (install.sh가 기록). 환경 로드: `source "$LOOPS_HOME/bin/_common.sh"` → `LOOPS_HOME`·`WORKTREE_BASE`·`DEFAULT_REPO` 사용 가능. (또는 `$LOOPS_HOME/loops.env` 를 직접 읽어 값 확인.)
2. **`$LOOPS_HOME/bin/loop-builder.md` 를 읽고 그 지침을 그대로 따른다.** (플랫폼 이해 + 만들 것 + config.json 스키마 + 품질 기준이 모두 거기 있다. 경로는 `$LOOPS_HOME`·`$WORKTREE_BASE`·`$DEFAULT_REPO` 기준.)
3. 사용자의 루프 설명을 그 지침의 "사용자 요청"으로 사용한다.

## 핵심
공통 엔진(`$LOOPS_HOME/bin/orchestrator-base.md`·`worker-base.md`)이 Linear ledger·dedup·cap·fan-out·OMP 네이티브 PR 생성·human-gate·no-merge를 이미 처리한다 → 새 루프는 **mission.md(무엇을·어떻게 발굴) + Linear 프로젝트 + config.json** 만 만들면 된다.

## 완료 후
- 생성 loop은 `enabled:false` — "대시보드(`$LOOPS_HOME/loopctl dashboard`)에서 mission 검토 후 '켜기'" 안내.
