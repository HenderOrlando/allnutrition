import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { listSocialGenerationSources } from '@/lib/business/social-generation.mjs';
import { fail } from '@/lib/validation-core.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => !['query', 'offset', 'limit'].includes(key)) || ['query', 'offset', 'limit'].some(key => query.getAll(key).length > 1)) fail('Filtro de fuentes no válido.');
  return json(await listSocialGenerationSources(await db(), Object.fromEntries(query)));
} catch (error) { return errorResponse(error); } }
