// electron-builder 설정(JS) — 서명을 조건부로.
// CSC_LINK(인증서) 또는 PALACE_SIGN=1 이 있으면 서명+공증, 없으면 로컬 unsigned 빌드.
const signing = !!(process.env.CSC_LINK || process.env.PALACE_SIGN === '1')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.godsenal.palace',
  productName: 'palace',
  directories: { output: 'dist', buildResources: 'resources' },
  files: ['out/**'],
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'resources/icon.icns',
    target: ['dmg', 'zip'], // zip = electron-updater(mac) 업데이트 채널
    // 서명 없을 때는 skip(null), 인증서 있으면 자동 감지(undefined).
    identity: signing ? undefined : null,
    hardenedRuntime: signing,
    gatekeeperAssess: false,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    // 공증: APPLE_TEAM_ID 있고 서명할 때만. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD 필요.
    notarize: signing && process.env.APPLE_TEAM_ID ? { teamId: process.env.APPLE_TEAM_ID } : false
  },
  dmg: {
    title: '${productName} ${version}'
  },
  publish: { provider: 'github', owner: 'Godsenal', repo: 'palace' }
}
