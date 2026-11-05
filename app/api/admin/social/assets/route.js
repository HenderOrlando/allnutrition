import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { createSocialAsset, listSocialAssets } from '@/lib/business/social-media.mjs';
import { fail } from '@/lib/validation-core.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !['state', 'limit', 'offset'].includes(key)) || ['state', 'limit', 'offset'].some(key => params.getAll(key).length > 1)) fail('Filtro de piezas no válido.');
  const filters = Object.fromEntries(params);
  return json(await listSocialAssets(await db(), filters));
} catch (error) { return errorResponse(error); } }
export async function POST(request) { try {
  const session = await authorize(request, { write: true });
  return json(await createSocialAsset(await db(), await jsonBody(request, { maxBytes: 4096 }), session.user.id), 201);
} catch (error) { return errorResponse(error); } }
