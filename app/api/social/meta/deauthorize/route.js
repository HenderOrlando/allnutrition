import { db, json, bodyBytes, errorResponse } from '@/lib/server.mjs';
import { deauthorizeSocialMeta } from '@/lib/business/social-connections.mjs';
import { fail } from '@/lib/validation-core.mjs';
export const runtime = 'nodejs';
export async function POST(request) { try {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) fail('Usa el formato de callback Meta.', 415);
  const form = new URLSearchParams((await bodyBytes(request, 20000)).toString('utf8'));
  if (form.getAll('signed_request').length !== 1) fail('Solicitud Meta no válida.', 403);
  return json(await deauthorizeSocialMeta(await db(), form.get('signed_request')));
} catch (error) { return errorResponse(error); } }
