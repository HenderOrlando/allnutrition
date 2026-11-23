import { authorizeAssistant, db, json, jsonBody } from '@/lib/server.mjs';
import { readAdvisorRecommendations } from '@/lib/assistant/advisor-recommendations.mjs';
import { reserveAdvisorTask } from '@/lib/assistant/advisor-tasks.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';

function privateResponse(response) {
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export async function GET(request) {
  try {
    const session = await authorizeAssistant(request);
    if (new URL(request.url).searchParams.size) fail('Consulta de recomendaciones no válida.', 422);
    return privateResponse(json(await readAdvisorRecommendations(await db(), session)));
  } catch (error) { return privateResponse(assistantHTTPError(error)); }
}

export async function POST(request) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    if (new URL(request.url).searchParams.size) fail('Solicitud de seguimiento no válida.', 422);
    const input = await jsonBody(request, { maxBytes: 2048 });
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3
      || !Object.hasOwn(input, 'id') || !Object.hasOwn(input, 'recommendationId') || input.capabilityId !== 'advisor.follow-recommendation') {
      fail('Solicitud de seguimiento no válida.', 422);
    }
    return privateResponse(json(await reserveAdvisorTask(await db(), session, input)));
  } catch (error) { return privateResponse(assistantHTTPError(error)); }
}
