import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { getSocialMeasurement, saveSocialMeasurement, verifySocialMeasurement } from '@/lib/business/social-measurement.mjs';
export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  await authorize(request); const { id } = await params;
  return json(await getSocialMeasurement(await db(), id));
} catch (error) { return errorResponse(error); } }
export async function POST(request, { params }) { try {
  const session = await authorize(request, { write: true }), { id } = await params;
  const input = await jsonBody(request, { maxBytes: 16384 });
  if (!['save', 'verify'].includes(input?.action)) return json({ error: 'Acción de medición no válida.' }, 400);
  const action = input.action === 'save' ? saveSocialMeasurement : verifySocialMeasurement;
  return json(await action(await db(), id, input, session.user.id, { signal: request.signal }));
} catch (error) { return errorResponse(error); } }
