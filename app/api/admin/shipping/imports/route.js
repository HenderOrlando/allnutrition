import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { prepareShippingImport } from '@/lib/business/shipping-imports.mjs';
export const runtime = 'nodejs';
export async function POST(request) { try {
  const session = await authorize(request, { write: true });
  const result = await prepareShippingImport(await db(), await jsonBody(request), session.user.id);
  return json(result, result.preparing ? 202 : 200);
} catch (error) { return errorResponse(error); } }
