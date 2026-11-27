import { authorizeSession, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { saveShippingRecipient } from '@/lib/business/shipping-recipients.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    const session = await authorizeSession(request, { write: true });
    const input = await jsonBody(request, { maxBytes: 16_384 });
    return json(await saveShippingRecipient(await db(), input, session.user.id), 201);
  } catch (error) { return errorResponse(error); }
}
