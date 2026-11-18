import { authorize, authorizeAssistant, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { listSocialGenerations, requestSocialGeneration } from '@/lib/business/social-generation.mjs';
import { fail } from '@/lib/validation-core.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  const session = await authorize(request);
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== 'campaignId') || query.getAll('campaignId').length > 1) fail('Filtro de solicitudes no válido.');
  return json(await listSocialGenerations(await db(), session.user.id, { campaignId: query.get('campaignId') }));
} catch (error) { return errorResponse(error); } }
export async function POST(request) { try {
  const session = await authorizeAssistant(request, { write: true });
  return json(await requestSocialGeneration(await db(), await jsonBody(request, { maxBytes: 24000 }), session), 202);
} catch (error) { return errorResponse(error); } }
