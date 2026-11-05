import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { getSocialCampaignLinks, saveSocialLink } from '@/lib/business/social-links.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  await authorize(request);
  const query = new URL(request.url).searchParams, allowed = new Set(['kind', 'q', 'page', 'asOf']), options = {};
  for (const [key, value] of query) {
    if (!allowed.has(key) || query.getAll(key).length !== 1) fail('Filtro de vínculos no permitido o duplicado.');
    options[key] = key === 'page' ? Number(value) : value;
  }
  return json(await getSocialCampaignLinks(await db(), (await params).id, options));
} catch (error) { return errorResponse(error); } }

export async function POST(request, { params }) { try {
  const session = await authorize(request, { write: true }), store = await db(), campaignId = (await params).id;
  const input = await jsonBody(request, { maxBytes: 8192 });
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['order', 'expense'].includes(input.kind) || input.campaignId !== null && input.campaignId !== campaignId) fail('El vínculo debe pertenecer a esta campaña o retirarse explícitamente.');
  const result = await saveSocialLink(store, input, session.user.id, { scopeCampaignId: campaignId });
  return json({ ...result, analysisQueued: true, analysisCampaignIds: [...new Set([result.previousCampaignId, result.campaignId].filter(Boolean))] }, 202);
} catch (error) { return errorResponse(error); } }
