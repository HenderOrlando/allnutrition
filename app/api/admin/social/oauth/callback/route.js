import { randomBytes } from 'node:crypto';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// This first document deliberately does not read the Strict administrative cookie.
// Its same-origin fetches receive the cookie without weakening the global policy.
export function GET() {
  const nonce = randomBytes(24).toString('base64');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar Meta</title></head><body><main><h1>Conectar Meta</h1><p id="status" role="status">Completando la conexión de forma segura…</p><a href="/admin?section=business&amp;tab=social">Volver a Negocio → Cuentas conectadas</a></main><script nonce="${nonce}">
(async () => {
  let query = new URLSearchParams(window.location.search);
  let code = query.get('code'), state = query.get('state'), denied = query.has('error');
  history.replaceState(null, '', '/api/admin/social/oauth/callback');
  query = null;
  const status = document.getElementById('status');
  if (!state || !denied && !code) {
    status.textContent = 'Para conectar, usa Conectar con Facebook desde Negocio → Cuentas conectadas.';
    return;
  }
  try {
    const sessionResponse = await fetch('/api/admin/social/oauth/complete', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    const session = await sessionResponse.json();
    if (!sessionResponse.ok) {
      status.textContent = 'La sesión administrativa venció. Inicia sesión y reinicia la conexión.';
      return;
    }
    const response = await fetch('/api/admin/social/oauth/complete', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': session.csrf },
      body: JSON.stringify(denied ? { state, error: 'access_denied' } : { code, state })
    });
    code = null; state = null;
    const result = await response.json();
    if (!response.ok) {
      status.textContent = typeof result.error === 'string' ? result.error : 'No se pudo conectar Meta. Reinicia el flujo desde Cuentas conectadas.';
      return;
    }
    const next = result.redirectTo;
    if (typeof next !== 'string' || !/^\\/admin\\?section=business&tab=social&record=[\\da-f]{8}(?:-[\\da-f]{4}){3}-[\\da-f]{12}$/i.test(next)) {
      status.textContent = 'No se pudo abrir la ficha de la conexión. Búscala en Cuentas conectadas.';
      return;
    }
    window.location.replace(next);
  } catch {
    code = null; state = null;
    status.textContent = 'No se pudo completar la comunicación. Reinicia la conexión desde Cuentas conectadas.';
  }
})();
</script></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Meta-OAuth-Diagnostic': 'operation-v1',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  } });
}
