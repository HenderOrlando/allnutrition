import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { readSocialRecommendationEvidence } from '@/lib/business/social-analysis.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function GET(request, { params }) {
  try {
    const session = await authorize(request), { id } = await params;
    const query = new URL(request.url).searchParams;
    const keys = ['campaignId', 'evidenceHash', 'captureId'];
    if (query.size !== keys.length || keys.some(key => query.getAll(key).length !== 1)) fail('Identifica la captura, la campaña y la huella de la recomendación.');
    return json(await readSocialRecommendationEvidence(await db(), id, Object.fromEntries(query), session.user.id));
  } catch (error) { return errorResponse(error); }
}
