import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { getSocialGenerationBrief } from '@/lib/business/social-generation.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  const query = new URL(request.url).searchParams, allowed = ['campaignId', 'baseAssetId'];
  if ([...query.keys()].some(key => !allowed.includes(key)) || allowed.some(key => query.getAll(key).length > 1)) fail('Filtro de encargo no válido.');
  return json(await getSocialGenerationBrief(await db(), Object.fromEntries(query)));
} catch (error) { return errorResponse(error); } }
