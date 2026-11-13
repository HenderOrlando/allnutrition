import { randomBytes } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cross-site navigation must not weaken the panel's Strict session cookie.
export function GET() {
  const nonce = randomBytes(24).toString('base64');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar Google con Ali</title></head><body><main><h1>Conectar Google con Ali</h1><p id="status" role="status">Autenticación recibida. Comprobando el acceso al modelo antes de habilitar Ali…</p><p>Si la cuenta no permite consultas, Ali elimina la conexión nueva. Esto no cierra tu cuenta de Google ni la sesión del panel.</p><a href="/admin?section=business&amp;tab=assistant">Volver a la configuración de Ali</a></main><script nonce="${nonce}">
(async () => {
  let query = new URLSearchParams(window.location.search);
  let code = query.get('code'), state = query.get('state'), denied = query.has('error') || query.getAll('state').length !== 1 || query.getAll('code').length > 1;
  history.replaceState(null, '', '/api/admin/assistant/oauth/callback');
  query = null;
  const status = document.getElementById('status');
  try {
    const sessionResponse = await fetch('/api/admin/assistant/oauth/complete', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    const session = await sessionResponse.json();
    if (!sessionResponse.ok) throw new Error('La sesión del panel venció. Inicia sesión y vuelve a conectar Google. No se habilitó Ali.');
    const response = await fetch('/api/admin/assistant/oauth/complete', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': session.csrf },
      body: JSON.stringify({ state, ...(denied ? { error: 'access_denied' } : { code }) })
    });
    code = null; state = null;
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo conectar Google. La conexión OAuth nueva no se habilitó.');
    window.location.replace('/admin?section=business&tab=assistant');
  } catch (error) {
    code = null; state = null;
    status.setAttribute('role', 'alert');
    status.textContent = error.message || 'No se pudo comprobar el acceso a Google. Vuelve a la configuración de Ali.';
  }
})();
</script></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  } });
}
