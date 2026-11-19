import { authorize, authorizeAssistant, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { patchSocialCreativeThread } from '@/lib/business/social-creative-threads.mjs';
import { getSocialCreativeThread } from '@/lib/business/social-generation.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  const session = await authorize(request);
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== 'cursor') || query.getAll('cursor').length > 1) fail('Paginación del estudio no válida.');
  return json(await getSocialCreativeThread(await db(), (await params).id, session.user.id, { cursor: query.get('cursor') }));
} catch (error) { return errorResponse(error); } }

export async function PATCH(request, { params }) { try {
  const session = await authorizeAssistant(request, { write: true });
  return json(await patchSocialCreativeThread(await db(), (await params).id, await jsonBody(request, { maxBytes: 4096 }), session));
} catch (error) { return errorResponse(error); } }
