import { authorize, authorizeAssistant, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { createSocialCreativeThread, listSocialCreativeThreads } from '@/lib/business/social-creative-threads.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function GET(request) { try {
  const session = await authorize(request);
  const query = new URL(request.url).searchParams, keys = ['campaignId', 'cursor'];
  if ([...query.keys()].some(key => !keys.includes(key)) || keys.some(key => query.getAll(key).length > 1)) fail('Filtro del estudio no válido.');
  return json(await listSocialCreativeThreads(await db(), session.user.id, Object.fromEntries(query)));
} catch (error) { return errorResponse(error); } }

export async function POST(request) { try {
  const session = await authorizeAssistant(request, { write: true });
  return json(await createSocialCreativeThread(await db(), await jsonBody(request, { maxBytes: 4096 }), session), 201);
} catch (error) { return errorResponse(error); } }
