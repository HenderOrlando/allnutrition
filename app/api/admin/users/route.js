import { authorize, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { fail } from '@/lib/validation.mjs';
import { createAdmin } from '@/lib/auth.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    await authorize(request);
    const store = await db();
    const rows = await store.db.all(`SELECT id,email,active FROM ${store.t('users')} ORDER BY email`);
    return json({ users: rows.map(({ id, email, active }) => ({ id, email, active: Boolean(active), role: 'administrator' })) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request) {
  try {
    await authorize(request, { write: true });
    const data = await jsonBody(request);
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Datos de usuario no válidos.');
    if (data.role !== 'administrator') fail('Por ahora solo se pueden crear usuarios con rol Administrador.');
    const email = await createAdmin(await db(), data.email, data.password);
    return json({ user: { email, role: 'administrator' } }, 201);
  } catch (error) {
    if (error?.code === '23505' || /UNIQUE constraint failed/.test(error?.message || '')) return json({ error: 'Ya existe una cuenta con ese correo.' }, 409);
    return errorResponse(error);
  }
}
