import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { allowedOrigins } from '@/lib/db/config.mjs';
import { getSocialSettings, saveSocialSettings } from '@/lib/business/social-settings.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  return json(await getSocialSettings(await db()));
} catch (error) { return errorResponse(error); } }
export async function PUT(request) { try {
  const session = await authorize(request, { write: true });
  const input = await jsonBody(request, { maxBytes: 16384 });
  return json(await saveSocialSettings(await db(), input, session.user.id, { allowedOrigins: allowedOrigins() }));
} catch (error) { return errorResponse(error); } }
