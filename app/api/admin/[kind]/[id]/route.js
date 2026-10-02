import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { removeUnusedProductImage } from '@/lib/media.mjs';
import { fail } from '@/lib/validation.mjs';
export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  await authorize(request); const { kind, id } = await params, store = await db();
  const result = await (kind === 'orders' ? store.order(id) : store.get(kind, id));
  if (!result) fail('Registro no encontrado.', 404); return json(result);
} catch (error) { return errorResponse(error); } }
export async function PUT(request, { params }) { try {
  const user = await authorize(request, { write: true }), { kind, id } = await params, data = await jsonBody(request), store = await db();
  const old = kind === 'products' ? await store.get(kind, id) : null;
  const saved = kind === 'orders' ? await store.saveOrder(data, user.user.id, id, data?.version) : await store.save(kind, data, id, data?.version);
  if (old?.image && old.image !== saved.image) await removeUnusedProductImage(store, old.image).catch(error => console.error('No se pudo liberar una imagen de producto:', error.code || error.name || 'unknown'));
  return json(saved);
} catch (error) { return errorResponse(error); } }
export async function DELETE(request, { params }) { try {
  await authorize(request, { write: true }); const { kind, id } = await params;
  if (kind === 'orders') fail('Los pedidos conservan su historial. Usa Cancelado.', 405);
  const data = await jsonBody(request), store = await db(), old = kind === 'products' ? await store.get(kind, id) : null;
  const removed = await store.remove(kind, id, data?.version);
  if (old?.image) await removeUnusedProductImage(store, old.image).catch(error => console.error('No se pudo liberar una imagen de producto:', error.code || error.name || 'unknown'));
  return json(removed);
} catch (error) { return errorResponse(error); } }
