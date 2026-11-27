import { authorize, authorizeSession, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { listShippingQuoteConnections, quoteShipping } from '@/lib/business/shipping-quotes.mjs';
import { HekaApiError } from '@/lib/shipping/heka-api.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try { await authorize(request); return json(await listShippingQuoteConnections(await db())); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request) {
  try {
    const session = await authorizeSession(request,{write:true});
    return json(await quoteShipping(await db(),await jsonBody(request,{maxBytes:16384}),session,{signal:request.signal}));
  } catch (error) {
    if (error instanceof HekaApiError || error?.code?.startsWith?.('SHIPPING_QUOTE_')) return json({error:error.message,code:error.code},error.status);
    return errorResponse(error);
  }
}
