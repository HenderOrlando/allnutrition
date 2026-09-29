import { authorize, json, errorResponse } from '@/lib/server.mjs';
export const runtime = 'nodejs';
export async function POST(request) { try {
  await authorize(request, { write: true });
  return json({ error: 'Las cargas de archivos están desactivadas. Pega un enlace HTTPS en el editor; solo se guarda la URL.' }, 410);
} catch (error) { return errorResponse(error); } }
