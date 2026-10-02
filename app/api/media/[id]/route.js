import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { productImagePath } from '@/lib/media.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  const { id } = await params;
  const path = await productImagePath(id);
  if (!path) return Response.json({ error: 'Imagen no encontrada.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const file = await stat(path);
  return new Response(Readable.toWeb(createReadStream(path)), {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(file.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
