import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { getSocialLearnings } from '@/lib/business/social-learnings.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  const params = new URL(request.url).searchParams;
  if (params.size !== new Set(params.keys()).size) fail('Filtro de aprendizajes no válido.');
  return json(await getSocialLearnings(await db(), Object.fromEntries(params)));
} catch (error) { return errorResponse(error); } }
