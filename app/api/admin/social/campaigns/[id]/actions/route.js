import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { socialCampaignAction } from '@/lib/business/social.mjs';
import { fail, text } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function POST(request, { params }) { try {
  const session = await authorize(request, { write: true });
  const input = await jsonBody(request, { maxBytes: 65536 });
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Envía una confirmación de campaña.');
  const action = text(input.action, 'Acción', 80, true);
  delete input.action;
  const result = await socialCampaignAction(await db(), (await params).id, action, input, session.user.id);
  const queued = ['approve-organic', 'prepare-paid', 'activate-paid', 'pause', 'resume', 'reconcile', 'link-remote', 'confirm-absent', 'resume-restored', 'sync', 'analyze'].includes(action) || Boolean(result.operationId);
  const status = action === 'duplicate' ? 201 : queued ? 202 : 200;
  return json(result, status);
} catch (error) { return errorResponse(error); } }
