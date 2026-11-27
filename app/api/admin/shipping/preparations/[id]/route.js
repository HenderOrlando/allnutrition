import { authorizeSession, db, errorResponse, json } from '@/lib/server.mjs';
import { getShippingPreparation } from '@/lib/business/shipping-preparations.mjs';

export const runtime = 'nodejs';

export async function GET(request,{params}) {
  try {
    await authorizeSession(request);
    const {id} = await params;
    return json(await getShippingPreparation(await db(),id));
  } catch (error) { return errorResponse(error); }
}
