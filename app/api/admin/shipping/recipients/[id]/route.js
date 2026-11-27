import { authorizeSession, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { getShippingRecipient, saveShippingRecipient } from '@/lib/business/shipping-recipients.mjs';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    await authorizeSession(request);
    const { id } = await params;
    return json(await getShippingRecipient(await db(), id));
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request, { params }) {
  try {
    const session = await authorizeSession(request, { write: true });
    const { id } = await params, input = await jsonBody(request, { maxBytes: 16_384 });
    return json(await saveShippingRecipient(await db(), input, session.user.id, id));
  } catch (error) { return errorResponse(error); }
}
