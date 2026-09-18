// 루프 config 로더 + 제품(product) 설정 상속. 의존성 0.
// 제품 계층: 하나의 제품(= Linear 프로젝트 1개)을 여러 루프(PM·버그…)가 공유할 때, 제품 공통 설정은
// products/<product>/product.json 에 두고 루프 config 는 "product": "<id>" 로 연결한다.
// 머지 규칙: **루프 값이 항상 우선**, 제품은 빈 곳만 채운다. 상속은 화이트리스트(INHERIT_KEYS)만 —
// enabled/schedule/maxWorkers 같은 루프 고유 필드가 실수로 상속되는 것을 구조적으로 차단.
// ⚠️ shell 쪽 대응: _common.sh cfgval 의 인라인 node 가 같은 화이트리스트를 복제한다 — 여기 바꾸면 거기도 바꿀 것.
// 소비자: render-prompt.mjs · dashboard-server.mjs (shell 은 cfgval 경유).
import { readFileSync } from 'node:fs';

export const INHERIT_KEYS = ['repo', 'baseRef', 'prBase', 'ompCommand', 'linearProjectId', 'linearProjectUrl'];

// cfg에 product 링크가 있으면 product.json을 읽어 화이트리스트 필드의 빈 곳을 채운다.
// 선언된 product 파일이 없으면 throw — 링크가 깨진 건 설정 오류다(무음 fallback 금지, 호출자가 loud 처리).
export function mergeProduct(root, cfg) {
  if (!cfg || !cfg.product) return cfg;
  const prod = JSON.parse(readFileSync(`${root}/products/${cfg.product}/product.json`, 'utf8'));
  for (const k of INHERIT_KEYS) if (cfg[k] == null && prod[k] != null) cfg[k] = prod[k];
  return cfg;
}

export function loadLoopConfig(root, loopId) {
  const cfg = JSON.parse(readFileSync(`${root}/loops/${loopId}/config.json`, 'utf8'));
  return mergeProduct(root, cfg);
}
