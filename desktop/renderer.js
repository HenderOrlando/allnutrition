'use strict';
const byId = id => document.getElementById(id);
const api = window.shippingBridge;
let state = null, working = false, refreshing = false;
function setText(id, value) { if (byId(id).textContent !== value) byId(id).textContent = value; }
function enteredOrigin() {
  try {
    const value = byId('origin').value.trim(), url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch { return ''; }
}
function previewOrigin() {
  const origin = enteredOrigin();
  setText('origin-preview', origin || 'Introduce un origen HTTPS válido');
  byId('pair-button').disabled = working || Boolean(state?.busy) || Boolean(state?.vaultBlocked) || !origin || !byId('confirm-origin').checked || !/^[A-Za-z0-9_-]{43}$/.test(byId('pair-code').value);
}
function render(next) {
  state = next;
  const busy = working || next.busy;
  setText('status', next.message);
  byId('binding-details').hidden = !next.paired;
  byId('pairing').hidden = next.paired;
  byId('session-actions').hidden = !next.paired;
  byId('disconnect').hidden = !next.paired && !next.vaultBlocked;
  setText('bound-origin', next.origin);
  setText('source', next.sourceName || next.sourceId || 'Se mostrará después de informar la identidad');
  setText('account', next.account ? `${next.account.centerCost} · ID ${next.account.userId}` : 'Sin sesión verificada');
  setText('confirmation', next.confirmed ? 'Cuenta fijada por el panel' : 'Pendiente de confirmación explícita en el panel');
  setText('capture', next.lastCaptureAt ? new Date(next.lastCaptureAt).toLocaleString('es-CO') : 'Sin captura aceptada en esta sesión');
  setText('login', next.hekaOpen ? 'Mostrar ventana oficial de Heka' : 'Iniciar sesión en Heka');
  byId('login').disabled = busy || !next.paired;
  byId('disconnect').disabled = busy;
  byId('origin').disabled = busy || next.vaultBlocked;
  byId('pair-code').disabled = busy || next.vaultBlocked;
  byId('confirm-origin').disabled = busy || next.vaultBlocked;
  previewOrigin();
}
function showActionError() {
  setText('action-error', 'No se pudo completar la acción. La aplicación no comparte credenciales con esta interfaz. Reabre el complemento si dejó de responder.');
  byId('action-error').hidden = false;
}
async function action(operation) {
  if (working) return;
  working = true; byId('action-error').hidden = true;
  if (state) render(state);
  try { const result = await operation(); render(result.state); }
  catch { showActionError(); }
  finally { working = false; await refresh(); }
}
async function refresh() {
  if (refreshing || working) return;
  refreshing = true;
  try { render(await api.getState()); } catch { showActionError(); }
  finally { refreshing = false; }
}
byId('origin').addEventListener('input', () => { byId('confirm-origin').checked = false; previewOrigin(); });
byId('pair-code').addEventListener('input', previewOrigin);
byId('confirm-origin').addEventListener('change', previewOrigin);
byId('pair-form').addEventListener('submit', event => {
  event.preventDefault();
  const origin = enteredOrigin(), code = byId('pair-code').value;
  if (!origin || !byId('confirm-origin').checked || !/^[A-Za-z0-9_-]{43}$/.test(code)) return;
  byId('pair-code').value = '';
  void action(() => api.pair({ origin, confirmedOrigin: origin, code }));
});
byId('login').addEventListener('click', () => { void action(() => api.openHeka()); });
byId('disconnect').addEventListener('click', () => { void action(() => api.disconnect()); });
void refresh();
const stateTimer = setInterval(() => { void refresh(); }, 1000);
window.addEventListener('pagehide', () => clearInterval(stateTimer), { once: true });
