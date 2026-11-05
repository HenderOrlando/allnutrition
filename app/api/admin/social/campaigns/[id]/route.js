import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { getSocialCampaign, saveSocialCampaign } from '@/lib/business/social.mjs';
import { getSocialAnalysis } from '@/lib/business/social-analysis.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  await authorize(request);
  const store = await db(), id = (await params).id;
  const campaign = await getSocialCampaign(store, id);
  return json({ ...campaign, analysis: await getSocialAnalysis(store, id) });
} catch (error) { return errorResponse(error); } }

export async function PATCH(request, { params }) { try {
  const session = await authorize(request, { write: true });
  const id = (await params).id;
  const input = await jsonBody(request, { maxBytes: 65536 });
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Envía un objeto de campaña.');
  if (input.id != null && input.id !== id) fail('La campaña enviada no corresponde a esta URL.');
  return json(await saveSocialCampaign(await db(), { ...input, id }, session.user.id));
} catch (error) { return errorResponse(error); } }
