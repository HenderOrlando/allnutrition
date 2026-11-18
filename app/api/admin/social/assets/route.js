import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { createSocialAsset, listSocialAssets, socialAssetClientDTO } from '@/lib/business/social-media.mjs';
import { fail } from '@/lib/validation-core.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !['state', 'limit', 'offset'].includes(key)) || ['state', 'limit', 'offset'].some(key => params.getAll(key).length > 1)) fail('Filtro de piezas no válido.');
  const filters = Object.fromEntries(params);
  const inventory = await listSocialAssets(await db(), filters);
  return json({ ...inventory, assets: inventory.assets.map(socialAssetClientDTO) });
} catch (error) { return errorResponse(error); } }
export async function POST(request) { try {
  const session = await authorize(request, { write: true });
  return json(socialAssetClientDTO(await createSocialAsset(await db(), await jsonBody(request, { maxBytes: 4096 }), session.user.id)), 201);
} catch (error) { return errorResponse(error); } }
