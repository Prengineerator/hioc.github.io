/* HIOC. offers as phone notifications (docs/WEB-PUSH-SPEC.md).
 * Served on hioc.in only (middleware answers 404 on staff./owner. hosts and
 * while the webPush flag is off). Deliberately NO fetch handler and no caching:
 * it exists only to receive pushes, so it can never serve a stale page.
 * safePath() mirrors safeOpenPath() in lib/push/url.ts; tests/webPush.test.ts
 * runs both against the same cases. */

function safePath(raw, origin) {
  if (typeof raw !== 'string') return '/';
  var value = raw.trim();
  if (value === '' || value.length > 300) return '/';
  if (value.indexOf('\\') !== -1 || /[\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    var url = new URL(value, origin);
    if (url.origin !== new URL(origin).origin) return '/';
    var path = url.pathname + url.search + url.hash;
    if (path.indexOf('//') === 0 || path.indexOf('/\\') === 0) return '/';
    if (path.indexOf('\\') !== -1 || /[\u0000-\u001f\u007f]/.test(path)) return '/';
    if (new URL(path, origin).origin !== new URL(origin).origin) return '/';
    return path;
  } catch (e) {
    return '/';
  }
}

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  var title = typeof data.title === 'string' && data.title ? data.title.slice(0, 80) : 'HIOC.';
  var body = typeof data.body === 'string' ? data.body.slice(0, 200) : '';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url: typeof data.url === 'string' ? data.url : '/', sendId: typeof data.sendId === 'string' ? data.sendId : '' },
    }),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var info = event.notification.data || {};
  var path = safePath(info.url, self.location.origin);
  var target = new URL(path, self.location.origin).href;

  var beacon = info.sendId
    ? fetch('/api/push/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sendId: info.sendId }),
        keepalive: true,
      }).catch(function () {})
    : Promise.resolve();

  var open = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url && new URL(c.url).origin === self.location.origin && 'navigate' in c) {
        return c.focus().then(function () {
          return c.navigate(target);
        });
      }
    }
    return self.clients.openWindow(target);
  });

  event.waitUntil(Promise.all([beacon, open]));
});
