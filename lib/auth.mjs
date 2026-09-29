import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fail, text } from './validation.mjs';
const scrypt = promisify(scryptCallback);
const digest = value => createHash('sha256').update(value).digest('hex');
export const SESSION_COOKIE = 'allnutrition_session';
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 200) fail('La contraseña debe tener entre 14 y 200 caracteres.');
  const salt = randomBytes(16).toString('hex'), key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function passwordMatches(password, encoded) {
  if (typeof password !== 'string' || password.length > 200 || typeof encoded !== 'string') return false;
  const [algorithm, salt, hex] = encoded.split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hex)) return false;
  const expected = Buffer.from(hex, 'hex'), key = await scrypt(password, salt, 64);
  return timingSafeEqual(key, expected);
}
export async function createAdmin(store, email, password, { reset = false } = {}) {
  const mail = text(email, 'Correo de administrador', 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) fail('Correo de administrador no válido.');
  const hashed = await hashPassword(password);
  await store.transaction(async tx => {
    const existing = await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE email=?`, [mail]);
    if (existing && !reset) fail('El administrador ya existe. Usa admin:password para cambiar la contraseña.');
    if (!existing && reset) fail('No existe esa cuenta. Usa admin:add para crearla.');
    if (existing) {
      await tx.db.run(`UPDATE ${tx.t('users')} SET password=?,active=1 WHERE id=?`, [hashed, existing.id]);
      await tx.db.run(`DELETE FROM ${tx.t('sessions')} WHERE user_id=?`, [existing.id]);
    } else await tx.db.run(`INSERT INTO ${tx.t('users')}(id,email,password) VALUES(?,?,?)`, [randomUUID(), mail, hashed]);
  });
  return mail;
}
export async function login(store, email, password) {
  const mail = text(email, 'Correo', 254, true).toLowerCase(), key = digest(mail), time = Date.now();
  // Incremento atómico persistente: no depende de memoria de una instancia serverless.
  const attempt = await store.db.get(`INSERT INTO ${store.t('attempts')}(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN attempts.reset_at<? THEN 1 ELSE attempts.count+1 END,reset_at=CASE WHEN attempts.reset_at<? THEN excluded.reset_at ELSE attempts.reset_at END RETURNING count,reset_at`, [key, time + 15 * 60 * 1000, time, time]);
  if (Number(attempt.count) > 8) fail('Demasiados intentos. Espera 15 minutos.', 429);
  const user = await store.db.get(`SELECT * FROM ${store.t('users')} WHERE email=? AND active=1`, [mail]);
  const fake = 'scrypt:' + '00'.repeat(16) + ':' + '00'.repeat(64);
  const matches = await passwordMatches(password, user?.password || fake);
  if (!user || !matches) fail('Correo o contraseña incorrectos.', 401);
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex'), expires = time + 8 * 60 * 60 * 1000;
  await store.transaction(async tx => {
    const current=await tx.db.get(`SELECT password,active FROM ${tx.t('users')} WHERE id=?${tx.provider==='supabase'?' FOR UPDATE':''}`,[user.id]);
    if(!current||current.active!==1||current.password!==user.password)fail('La cuenta cambió durante el acceso. Intenta iniciar sesión de nuevo.',401);
    await tx.db.run(`DELETE FROM ${tx.t('attempts')} WHERE key=? OR reset_at<?`, [key, time]);
    await tx.db.run(`DELETE FROM ${tx.t('sessions')} WHERE expires<?`, [time]);
    await tx.db.run(`INSERT INTO ${tx.t('sessions')}(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)`, [digest(token), user.id, csrf, expires]);
  });
  return { token, csrf, expires, user: { id: user.id, email: user.email } };
}
export async function getSession(store, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await store.db.get(`SELECT s.*,u.email FROM ${store.t('sessions')} s JOIN ${store.t('users')} u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>? AND u.active=1`, [digest(token), Date.now()]);
  return row ? { csrf: row.csrf, expires: Number(row.expires), user: { id: row.user_id, email: row.email } } : null;
}
export async function logout(store, token) { if (typeof token === 'string') await store.db.run(`DELETE FROM ${store.t('sessions')} WHERE token_hash=?`, [digest(token)]); }
export function assertOrigin(origin, expected) {
  const allowed = Array.isArray(expected) ? expected : [new URL(expected).origin];
  if (!origin || !allowed.includes(origin)) fail('Origen de solicitud no permitido.', 403);
}
export function assertCSRF(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string' || Buffer.byteLength(received) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) fail('La sesión del formulario no es válida. Recarga la página.', 403);
}
