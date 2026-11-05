import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { listSocialCampaigns, saveSocialCampaign } from '@/lib/business/social.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  const params = new URL(request.url).searchParams;
  const keys = ['q', 'network', 'objective', 'status', 'mode', 'page'];
  if ([...params.keys()].some(key => !keys.includes(key)) || keys.some(key => params.getAll(key).length > 1)) fail('Filtro de campañas no válido.');
  return json(await listSocialCampaigns(await db(), Object.fromEntries(params)));
} catch (error) { return errorResponse(error); } }

export async function POST(request) { try {
  const session = await authorize(request, { write: true });
  const input = await jsonBody(request, { maxBytes: 65536 });
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Envía un objeto de campaña.');
  if (input.id != null || input.version != null && input.version !== 0) fail('Una campaña nueva no puede reemplazar otra existente.');
  return json(await saveSocialCampaign(await db(), input, session.user.id), 201);
} catch (error) { return errorResponse(error); } }
