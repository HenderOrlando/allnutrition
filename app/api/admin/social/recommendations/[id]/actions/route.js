import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { socialRecommendationAction } from '@/lib/business/social.mjs';
import { fail, text } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function POST(request, { params }) { try {
  const session = await authorize(request, { write: true });
  const input = await jsonBody(request, { maxBytes: 65536 });
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Envía una acción de recomendación.');
  const action = text(input.action, 'Acción', 80, true);
  delete input.action;
  const result = await socialRecommendationAction(await db(), (await params).id, action, input, session.user.id);
  return json(result, action === 'duplicate-from-recommendation' ? 201 : 200);
} catch (error) { return errorResponse(error); } }
