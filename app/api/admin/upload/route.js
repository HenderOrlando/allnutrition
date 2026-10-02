import { authorize, json, errorResponse, bodyBytes, jsonBody, db } from '@/lib/server.mjs';
import { MAX_PRODUCT_IMAGE_UPLOAD_BYTES, productImageUsage, removeUnusedProductImage, saveProductImage } from '@/lib/media.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request) { try {
  await authorize(request);
  return json(await productImageUsage());
} catch (error) { return errorResponse(error); } }
export async function POST(request) { try {
  await authorize(request, { write: true });
  const image = await bodyBytes(request, MAX_PRODUCT_IMAGE_UPLOAD_BYTES, 'La imagen supera el límite de 10 MiB.');
  const saved = await saveProductImage(image);
  return json({ url: saved.url, usage: saved.usage }, 201);
} catch (error) { return errorResponse(error); } }
export async function DELETE(request) { try {
  await authorize(request, { write: true });
  const { url } = await jsonBody(request), store = await db();
  const deleted = await removeUnusedProductImage(store, url);
  return json({ deleted, usage: await productImageUsage() });
} catch (error) { return errorResponse(error); } }
