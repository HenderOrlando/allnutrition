import { authorizeSession, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { HekaApiError } from '@/lib/shipping/heka-api.mjs';
import { countHekaGuides } from '@/lib/business/heka-api.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    const session = await authorizeSession(request,{write:true});
    return json(await countHekaGuides(await db(),await jsonBody(request,{maxBytes:1024}),session,{signal:request.signal}));
  } catch (error) {
    if (error instanceof HekaApiError) return json({ error:error.message,code:error.code },error.status);
    if (error?.code?.startsWith?.('INTEGRATION_')) return json({ error:'La custodia privada de Heka no está disponible. Restaura su clave original.',code:'HEKA_CUSTODY' },422);
    return errorResponse(error);
  }
}
