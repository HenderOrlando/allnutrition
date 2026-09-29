import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { fail } from '@/lib/validation.mjs';
export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  await authorize(request); const { kind, id } = await params, store = await db();
  const result = await (kind === 'orders' ? store.order(id) : store.get(kind, id));
  if (!result) fail('Registro no encontrado.', 404); return json(result);
} catch (error) { return errorResponse(error); } }
export async function PUT(request, { params }) { try {
  const user = await authorize(request, { write: true }), { kind, id } = await params, data = await jsonBody(request), store = await db();
  return json(await (kind === 'orders' ? store.saveOrder(data, user.user.id, id, data?.version) : store.save(kind, data, id, data?.version)));
} catch (error) { return errorResponse(error); } }
export async function DELETE(request, { params }) { try {
  await authorize(request, { write: true }); const { kind, id } = await params;
  if (kind === 'orders') fail('Los pedidos conservan su historial. Usa Cancelado.', 405);
  const data = await jsonBody(request); return json(await (await db()).remove(kind, id, data?.version));
} catch (error) { return errorResponse(error); } }
