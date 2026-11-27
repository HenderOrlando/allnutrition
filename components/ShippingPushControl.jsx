'use client';

import { useEffect, useState } from 'react';

const PATH = '/api/admin/shipping/push';
const SCOPE = '/admin';
const SCRIPT = '/shipping-notifications-sw.js';
const supported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const post = (api, data) => api(PATH, { method:'POST', body:JSON.stringify(data) });
const environmentLabel = value => value === 'test' ? 'Pruebas' : 'Producción';
const publicKeyBytes = key => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4-key.length%4)%4)), char => char.charCodeAt(0));

async function inactiveOnBrowser() {
  if (!supported() || Notification.permission !== 'granted') return true;
  const registration = await navigator.serviceWorker.getRegistration(SCOPE);
  return !await registration?.pushManager.getSubscription();
}

// Call on admin focus and on SW permission-change messages, not in the public site.
export async function reconcileShippingPushPermission(api) {
  if (!supported() || !await inactiveOnBrowser()) return;
  if ((await api(PATH)).deviceEnvironment) await post(api, { action:'disable' });
}

export function watchShippingPushPermission(onChange) {
  let status, stopped = false;
  navigator.permissions?.query({ name:'notifications' }).then(current => {
    if (stopped) return;
    status = current;
    status.addEventListener('change', onChange);
  }).catch(() => {});
  return () => {
    stopped = true;
    status?.removeEventListener('change', onChange);
  };
}

async function pushRegistration() {
  const registration = await navigator.serviceWorker.register(SCRIPT, { scope:SCOPE, updateViaCache:'none' });
  if (registration.active) return registration;
  let timer;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => { timer=setTimeout(() => reject(new Error('No se activó el servicio de avisos de este sitio. Vuelve a intentarlo.')), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export default function ShippingPushControl({ api, config }) {
  const [status, setStatus] = useState(null);
  const [permission, setPermission] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const [prepared, setPrepared] = useState(null);
  const [needsInstall, setNeedsInstall] = useState(false);
  const environment = config?.environment;
  const version = config?.version;

  useEffect(() => {
    let active = true;
    const sync = async () => {
      const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
      setNeedsInstall(iOS && !navigator.standalone && !window.matchMedia('(display-mode: standalone)').matches);
      setPermission(supported() ? Notification.permission : 'unsupported');
      try {
        const current = await api(PATH);
        if (active && current.deviceEnvironment && supported() && await inactiveOnBrowser() && active) {
          await post(api, { action:'disable' });
          current.deviceEnvironment = null;
        }
        if (active) setStatus(current);
      } catch (error) { if (active) setMessage(error.message); }
    };
    const workerMessage = event => { if (event.data?.type === 'shipping-novelties-changed') sync(); };
    window.addEventListener('focus', sync);
    navigator.serviceWorker?.addEventListener('message', workerMessage);
    const stopPermission = watchShippingPushPermission(sync);
    sync();
    return () => {
      active = false;
      stopPermission();
      window.removeEventListener('focus', sync);
      navigator.serviceWorker?.removeEventListener('message', workerMessage);
    };
  }, [api, environment, version, reload]);

  async function enable() {
    setBusy(true); setMessage('');
    try {
      const consent = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      setPermission(consent);
      if (consent !== 'granted') return;
      const scope = { environment, version };
      let ready = prepared?.environment === environment && prepared?.version === version ? prepared : null;
      if (!ready) {
        const { publicKey } = await post(api, { action:'prepare', ...scope });
        ready = { ...scope, publicKey, registration:await pushRegistration() };
        setPrepared(ready);
      }
      const key = publicKeyBytes(ready.publicKey);
      const push = ready.registration.pushManager;
      let subscription;
      if (!ready.confirmDirectly) {
        subscription = await push.getSubscription();
        const existing = subscription?.options.applicationServerKey && new Uint8Array(subscription.options.applicationServerKey);
        if (existing && (existing.length !== key.length || existing.some((value, index) => value !== key[index]))) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
      if (!subscription) {
        try { subscription = await push.subscribe({ userVisibleOnly:true, applicationServerKey:key }); }
        catch (error) {
          if (error.name === 'NotAllowedError' && Notification.permission === 'granted') setPrepared({ ...ready, confirmDirectly:true });
          throw error;
        }
      }
      const data = await post(api, { action:'subscribe', ...scope, publicKey:ready.publicKey, subscription:subscription.toJSON() });
      setStatus(current => ({ ...current, ...data }));
      setMessage(`Avisos activados en este dispositivo para ${environmentLabel(environment)}.`);
    } catch (error) {
      setMessage(error.name === 'NotAllowedError' && Notification.permission === 'granted' ? 'Pulsa de nuevo «Notificar en este dispositivo» para confirmar la activación en el navegador.' : error.message);
    } finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true); setMessage('');
    try {
      const data = await post(api, { action:'disable' });
      setStatus(current => ({ ...current, ...data }));
      if (supported()) {
        const registration = await navigator.serviceWorker.getRegistration(SCOPE);
        const subscription = await registration?.pushManager.getSubscription();
        await subscription?.unsubscribe();
      }
      setMessage('Avisos desactivados en este dispositivo. La bandeja sigue disponible.');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  const selected = status?.deviceEnvironment;
  const ready = status?.available && config?.configured && status.environment === environment;
  const canEnable = ready && !needsInstall && !['loading','unsupported','denied'].includes(permission) && selected !== environment;
  return <div>
    {needsInstall && <p>En iPhone o iPad, usa «Añadir a pantalla de inicio» y abre el administrador desde ese icono para activar avisos.</p>}
    {!needsInstall && permission === 'unsupported' && <p>Este navegador no admite avisos en este dispositivo. Puedes seguir usando la bandeja.</p>}
    {permission === 'denied' && <p>El navegador bloqueó los avisos. Puedes cambiar el permiso en los ajustes del sitio o seguir usando la bandeja.</p>}
    {status && !ready && permission !== 'unsupported' && <p>{config?.configured ? 'Abre el administrador desde su dirección HTTPS configurada para activar avisos.' : 'Conecta Heka para activar avisos en este dispositivo.'}</p>}
    {selected && <p>Avisos en este dispositivo: <strong>{environmentLabel(selected)}</strong>.</p>}
    {canEnable && <button type="button" className="button secondary small" disabled={busy} onClick={enable}>{selected ? `Cambiar avisos a ${environmentLabel(environment)}` : 'Notificar en este dispositivo'}</button>}
    {selected && <button type="button" className="button secondary small" disabled={busy} onClick={disable}>Desactivar en este dispositivo</button>}
    {!status && message && <button type="button" className="button secondary small" onClick={() => { setMessage(''); setReload(count => count+1); }}>Reintentar estado de avisos</button>}
    <div role="status">{busy ? 'Actualizando avisos del dispositivo…' : message}</div>
  </div>;
}
