import { attachment, authorize, authorizeSession, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { HekaApiError } from '@/lib/shipping/heka-api.mjs';
import { listHekaMutations, operateHeka } from '@/lib/business/heka-api.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try { await authorize(request); return json(await listHekaMutations(await db())); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request) {
  try {
    const session = await authorizeSession(request,{write:true});
    const result = await operateHeka(await db(),await jsonBody(request,{maxBytes:16384}),session,{signal:request.signal});
    return result.pdf ? attachment(result.pdf,'heka-sticker.pdf','application/pdf') : json(result.data,result.status);
  } catch (error) {
    if (error instanceof HekaApiError) return json({ error:error.message,code:error.code },error.status);
    if (error?.code?.startsWith?.('INTEGRATION_')) return json({ error:'La custodia privada de Heka no está disponible. Restaura su clave original.',code:'HEKA_CUSTODY' },422);
    return errorResponse(error);
  }
}
