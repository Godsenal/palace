// Loops 대시보드 PWA 서비스워커. 캐싱 안 함(모든 데이터가 라이브 — 오래된 셸이 더 나쁨).
// 존재 이유: 웹푸시 수신 — iOS는 설치된 PWA + 등록된 SW에만 푸시를 전달한다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'Loops', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(   // iOS는 userVisibleOnly 구독 → 모든 push가 뭔가 표시해야 함
    self.registration.showNotification(d.title || 'Loops', {
      body: d.body || '',
      tag: d.tag || 'loops',
      icon: new URL('icon-192.png', self.registration.scope).href,
      badge: new URL('icon-192.png', self.registration.scope).href,
      data: { loop: d.loop || '' },
      renotify: !!d.tag,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const loop = event.notification.data && event.notification.data.loop;
  const url = new URL(loop ? `?loop=${encodeURIComponent(loop)}` : '.', self.registration.scope).href;
  event.waitUntil(   // 열린 창이 있으면 재사용(폰은 대개 백그라운드) — 없으면 새로 연다
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { if (loop) c.postMessage({ type: 'select-loop', loop }); return c.focus(); }
      }
      return self.clients.openWindow(url);
    }),
  );
});
