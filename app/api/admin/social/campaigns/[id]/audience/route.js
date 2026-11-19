import { authorizeAssistant, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { fail } from '@/lib/validation-core.mjs';
import { actOnSocialAudience, getSocialAudience } from '@/lib/business/social-audience.mjs';

export const runtime = 'nodejs';
export async function GET(request, { params }) {
  try {
    const session = await authorizeAssistant(request), { id } = await params;
    const query = new URL(request.url).searchParams;
    const keys = ['mode', 'requestId'];
    if ([...query.keys()].some(key => !keys.includes(key)) || keys.some(key => query.getAll(key).length > 1)) fail('Filtro de audiencia no válido.');
    return json(await getSocialAudience(await db(), id, session, Object.fromEntries(query)));
  } catch (error) { return errorResponse(error); }
}
export async function POST(request, { params }) {
  try {
    const session = await authorizeAssistant(request, { write: true }), { id } = await params;
    const input = await jsonBody(request, { maxBytes: 8192 });
    const result = await actOnSocialAudience(await db(), id, input, session, { signal: request.signal });
    return json(result, result.status === 'reserved' ? 202 : 200);
  } catch (error) { return errorResponse(error); }
}
