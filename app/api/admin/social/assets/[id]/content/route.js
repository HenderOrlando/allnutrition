import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { uploadSocialAsset, openSocialAssetContent } from '@/lib/business/social-media.mjs';
import { socialMediaResponse } from '@/lib/social/media-http.mjs';
import { fail } from '@/lib/validation-core.mjs';
export const runtime = 'nodejs';
export async function PUT(request, { params }) { try {
  const session = await authorize(request, { write: true }), { id } = await params;
  if (!request.body) fail('Envía los bytes del archivo.');
  const rawLength = request.headers.get('content-length');
  if (rawLength !== null && !/^\d+$/.test(rawLength)) fail('Longitud del archivo no válida.');
  const input = {
    body: request.body,
    version: Number(request.headers.get('x-asset-version')),
    requestId: request.headers.get('x-request-id'),
    contentType: request.headers.get('content-type') || '',
    contentLength: rawLength === null ? undefined : Number(rawLength),
  };
  return json(await uploadSocialAsset(await db(), id, input, session.user.id, { signal: request.signal }), 202);
} catch (error) { return errorResponse(error); } }
async function preview(request, { params }) { try {
  await authorize(request);
  const { id } = await params, query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== 'variant') || query.getAll('variant').length > 1) fail('Variante de vista previa no válida.');
  const variant = query.get('variant') ?? 'derivative';
  if (!['original', 'derivative'].includes(variant)) fail('Variante de vista previa no válida.');
  const file = await openSocialAssetContent(await db(), id, { variant });
  return await socialMediaResponse(file, request);
} catch (error) { return errorResponse(error); } }
export const GET = preview;
export const HEAD = preview;
