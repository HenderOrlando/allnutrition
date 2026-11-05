import { authorize, db, errorResponse, json } from '@/lib/server.mjs';
import { fail, text } from '@/lib/validation-core.mjs';
import { getSocialConnection } from '@/lib/business/social.mjs';
import { loadCredentials } from '@/lib/social/credentials.mjs';
import { createSocialConnector } from '@/lib/social/connectors.mjs';

export const runtime = 'nodejs';
export async function GET(request) {
  try {
    await authorize(request);
    const url = new URL(request.url), kind = url.searchParams.get('kind'), q = text(url.searchParams.get('q'), 'Búsqueda', 100, true);
    if (!['location', 'interest'].includes(kind) || q.length < 2) fail('Indica tipo y al menos dos caracteres de búsqueda.');
    const store = await db(), connection = await getSocialConnection(store, url.searchParams.get('connection'));
    if (connection.integrationMethod !== 'api') fail('La vía navegador busca candidatos mediante el preflight del borrador.', 409);
    if (connection.state !== 'connected') fail('Reconecta la cuenta antes de buscar audiencia.', 409);
    const connector = await createSocialConnector({ connection, credentials: await loadCredentials(store, connection) });
    return json({ candidates: await connector.searchTargeting({ kind, q, signal: request.signal }) });
  } catch (error) { return errorResponse(error); }
}
