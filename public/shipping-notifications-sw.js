/* This worker handles notifications only; it never intercepts requests or caches admin data. */
const NOVELTIES = '/admin?section=orders&tab=heka&panel=novelties';
const ICON = '/admin/shipping-icon/192';
const validEvent = id => typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

async function adminWindows() {
  return (await self.clients.matchAll({ type:'window', includeUncontrolled:true })).filter(client => {
    const url = new URL(client.url);
    return url.origin === self.location.origin && url.pathname === '/admin';
  });
}

async function invalidate() {
  for (const client of await adminWindows()) client.postMessage({ type:'shipping-novelties-changed' });
}

self.addEventListener('push', event => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!/^ship-[0-9a-f]{24}$/.test(payload?.tag) || !['test','production'].includes(payload.environment)) return;
  event.waitUntil(Promise.all([
    self.registration.showNotification(payload.environment === 'test' ? 'Envíos · Pruebas' : 'Novedades de envíos', {
      body:'Hay una actualización. Abre la bandeja de envíos en el administrador para revisarla.',
      icon:ICON, tag:payload.tag, data:validEvent(payload.eventId)?{eventId:payload.eventId}:undefined,
    }),
    invalidate(),
  ]));
});

self.addEventListener('pushsubscriptionchange', event => event.waitUntil(invalidate()));

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const eventId=event.notification.data?.eventId;
    const target=validEvent(eventId)?`${NOVELTIES}&eventId=${eventId}`:NOVELTIES;
    const windows = await adminWindows();
    const client = windows.find(item => item.focused) ?? windows.find(item => item.visibilityState === 'visible') ?? windows[0];
    if (client) {
      client.postMessage({ type:'open-shipping-novelties', eventId:validEvent(eventId)?eventId:null });
      await client.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});
