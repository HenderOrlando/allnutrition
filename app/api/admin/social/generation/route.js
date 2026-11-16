import { authorize, authorizeAssistant, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { listSocialGenerations, requestSocialGeneration } from '@/lib/business/social-generation.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  const session = await authorize(request);
  return json(await listSocialGenerations(await db(), session.user.id));
} catch (error) { return errorResponse(error); } }
export async function POST(request) { try {
  const session = await authorizeAssistant(request, { write: true });
  return json(await requestSocialGeneration(await db(), await jsonBody(request, { maxBytes: 24000 }), session), 202);
} catch (error) { return errorResponse(error); } }
