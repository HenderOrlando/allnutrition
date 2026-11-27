import { authorize, db, errorResponse, json } from '@/lib/server.mjs';
import { getShippingFinance } from '@/lib/business/shipping-finance.mjs';

export const runtime='nodejs';

export async function GET(request,{params}) {
  try {
    await authorize(request);
    const {id}=await params;
    return json(await getShippingFinance(await db(),id));
  } catch(error) {return errorResponse(error);}
}
