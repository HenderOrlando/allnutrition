import { authorizeSession, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { pageShippingRecipients } from '@/lib/business/shipping-recipients.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    await authorizeSession(request, { write: true });
    const input = await jsonBody(request, { maxBytes: 2048 });
    return json(await pageShippingRecipients(await db(), input));
  } catch (error) { return errorResponse(error); }
}
