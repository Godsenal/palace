**임무**: https://example.com (당신의 프로덕션 사이트) 의 SEO를 점진적으로 강화한다. (도메인·경로는 대상 서비스에 맞게 수정)

**발굴 방법**: page-type 1개를 골라 audit 한다. 최근 안 한 타입을 rotate (직전 audit 타입은 run-log 이슈 최신 코멘트로 추적).
- 도구: seo 관련 스킬(seo-audit / seo-technical / seo-schema / seo-sitemap / seo-content 등) 활용.
- 라이브 페이지는 OMP `read` 또는 설치된 `ego-browser` 스킬로 Googlebot 관점에서 확인하고, 구현 근거는 프론트엔드 코드를 검색해서 잡는다.

**page-type 순환 (예시)**:
① 지역/카테고리 색인 (`/list/$category`)
② 상세 페이지 (`/items/$id`)
③ 검색 결과
④ sitemap 커버리지

**좋은 work item** = 구체적이고 배포 가능한 SEO 갭: 누락된 structured data(JSON-LD)/canonical/noindex, 크롤러 internal link 부재(onClick→`<a href>`), heading 계층(h1/h2) 부재·역전, thin content, sitemap 누락 등.

**human-gate로 표시할 것**: BE 스키마 변경이 필요하거나, noindex 페이지로의 투기성 링크 등 사람 판단이 필요한 것 — 구현하지 말고 본문에 "human-gate" 명시.

작업 완료되면 OMP 네이티브 도구로 diff를 정리하고 커밋한 뒤 `gh pr create --base <prBase>`로 PR을 연다. 꼭 필요한 경우만 사람 개입을 요청한다.
