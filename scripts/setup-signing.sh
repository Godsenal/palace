#!/usr/bin/env bash
# palace 코드서명 + 공증용 GitHub Actions 시크릿을 한 번에 등록한다.
#
# 사전 준비(당신이 GUI로):
#   1) Xcode → Settings(⌘,) → Accounts → [Apple ID] → Manage Certificates… → "+" →
#      "Developer ID Application"  (키체인에 자동 설치됨)
#   2) 키체인 접근 → 그 인증서 우클릭 → "내보내기" → .p12 로 저장(암호 설정)
#   3) appleid.apple.com → 로그인 및 보안 → 앱 암호 → 새 앱 암호 생성(공증용)
#
# 그다음 실행:
#   scripts/setup-signing.sh /path/to/DeveloperID.p12
#
# .p12 암호 / Apple ID / 앱전용 암호 / (자동감지 실패 시)팀ID 는 프롬프트로 입력한다.
# 모든 비밀값은 gh 암호화 시크릿으로만 들어가고 디스크에 평문 저장하지 않는다.
set -euo pipefail

REPO="Godsenal/palace"
P12="${1:-}"

if [[ -z "$P12" || ! -f "$P12" ]]; then
  echo "사용법: scripts/setup-signing.sh <Developer ID Application .p12 경로>" >&2
  echo "(먼저 Xcode로 인증서 생성 → 키체인에서 .p12 내보내기)" >&2
  exit 1
fi

command -v gh >/dev/null || { echo "gh CLI 필요"; exit 1; }

# 팀 ID 자동 감지(키체인에 설치돼 있으면). 실패 시 프롬프트.
TEAM_ID="$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n 's/.*Developer ID Application: .*(\([A-Z0-9]\{10\}\)).*/\1/p' | head -1 || true)"
if [[ -z "$TEAM_ID" ]]; then
  read -r -p "Apple Team ID (10자, developer.apple.com → Membership): " TEAM_ID
fi
echo "→ Team ID: $TEAM_ID"

read -r -s -p ".p12 내보내기 암호: " P12_PW; echo
read -r -p "Apple ID (이메일): " APPLE_ID
read -r -s -p "앱 전용 암호(appleid.apple.com에서 생성): " APP_PW; echo

# .p12 → base64 (한 줄)
CSC_LINK="$(base64 -i "$P12" | tr -d '\n')"

echo "→ GitHub 시크릿 등록 중 ($REPO)…"
printf '%s' "$CSC_LINK"  | gh secret set CSC_LINK                      -R "$REPO"
printf '%s' "$P12_PW"    | gh secret set CSC_KEY_PASSWORD             -R "$REPO"
printf '%s' "$APPLE_ID"  | gh secret set APPLE_ID                     -R "$REPO"
printf '%s' "$APP_PW"    | gh secret set APPLE_APP_SPECIFIC_PASSWORD  -R "$REPO"
printf '%s' "$TEAM_ID"   | gh secret set APPLE_TEAM_ID                -R "$REPO"

echo "✓ 완료. 이제 다음 릴리즈부터 자동 서명 + 공증됩니다:"
echo "    npm version patch && git push && git push --tags"
echo
echo "로컬에서 서명 빌드 확인(인증서가 키체인에 있을 때):"
echo "    PALACE_SIGN=1 npm run dist:mac"
