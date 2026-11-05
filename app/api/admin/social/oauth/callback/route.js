import { randomBytes } from 'node:crypto';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// This first document deliberately does not read the Strict administrative cookie.
// Its same-origin fetches receive the cookie without weakening the global policy.
export function GET() {
  const nonce = randomBytes(24).toString('base64');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar Meta</title></head><body><main><h1>Conectar Meta</h1><p id="status" role="status">Completando la conexión de forma segura…</p><a href="/admin?section=advertising&amp;tab=connections">Volver a Conexiones</a></main><script nonce="${nonce}">
(async () => {
  let query = new URLSearchParams(window.location.search);
  let code = query.get('code'), state = query.get('state'), denied = query.has('error');
  history.replaceState(null, '', '/api/admin/social/oauth/callback');
  query = null;
  const status = document.getElementById('status');
  try {
    const sessionResponse = await fetch('/api/admin/social/oauth/complete', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    const session = await sessionResponse.json();
    if (!sessionResponse.ok) throw new Error('La sesión administrativa venció. Inicia sesión y reinicia la conexión.');
    const response = await fetch('/api/admin/social/oauth/complete', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': session.csrf },
      body: JSON.stringify({ code, state, ...(denied ? { error: 'access_denied' } : {}) })
    });
    code = null; state = null;
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo conectar Meta. Reinicia el flujo desde Conexiones.');
    window.location.replace('/admin?section=advertising&tab=connections');
  } catch (error) {
    code = null; state = null;
    status.textContent = error.message || 'No se pudo conectar Meta. Reinicia el flujo desde Conexiones.';
  }
})();
</script></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  } });
}
