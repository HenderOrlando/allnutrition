import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { estimateSocialCampaign } from '@/lib/business/social-analysis.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function POST(request, { params }) { try {
  const session = await authorize(request, { write: true }), input = await jsonBody(request, { maxBytes: 8192 });
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['version', 'requestId', 'manualScenario'].includes(key))) fail('Envía la versión y el escenario opcional de la previsión.');
  return json(await estimateSocialCampaign(await db(), (await params).id, input, session.user.id), 201);
} catch (error) { return errorResponse(error); } }
