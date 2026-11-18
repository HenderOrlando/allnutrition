import { authorize, authorizeSession, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { HekaApiError } from '@/lib/shipping/heka-api.mjs';
import { getHekaSettings, saveHekaSettings } from '@/lib/business/heka-api.mjs';

export const runtime = 'nodejs';

function responseError(error) {
  if (error instanceof HekaApiError) return json({ error:error.message,code:error.code },error.status);
  if (error?.code?.startsWith?.('INTEGRATION_')) return json({ error:'La custodia privada de Heka no está disponible. Restaura su clave original.',code:'HEKA_CUSTODY' },422);
  return errorResponse(error);
}
export async function GET(request) {
  try { await authorize(request); return json(await getHekaSettings(await db())); }
  catch (error) { return responseError(error); }
}
export async function PUT(request) {
  try {
    const session = await authorizeSession(request,{write:true});
    return json(await saveHekaSettings(await db(),await jsonBody(request,{maxBytes:8192}),session));
  } catch (error) { return responseError(error); }
}
export async function DELETE(request) {
  try {
    const session = await authorizeSession(request,{write:true});
    return json(await saveHekaSettings(await db(),await jsonBody(request,{maxBytes:1024}),session,{clear:true}));
  } catch (error) { return responseError(error); }
}
