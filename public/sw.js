/* Latam Games — Service Worker (PWA + Web Push).
 * NO cachea HTML/JS (la app es dinámica → siempre red, nunca sirve versiones viejas).
 * Solo: instalable + manejo de notificaciones push. */
const SW_VERSION = 'lg-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting(); // activar la versión nueva de inmediato
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through (sin cache) — necesario para que la app sea "instalable".
self.addEventListener('fetch', (event) => {
  // Solo manejamos navegación/GET de forma transparente; el resto va directo a la red.
  return; // no interceptamos → el navegador hace su request normal
});

// Llega una notificación push del servidor.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Latam Games';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'latamgames',
    renotify: true,
    vibrate: [120, 60, 120],
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Al tocar la notificación → abrir/enfocar el panel.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) { w.navigate && w.navigate(url); return w.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
