import { fail } from '../validation-core.mjs';
import { instant } from './dates.mjs';
import { hash, insertRow, stamp } from './commands.mjs';

// This namespace is metadata, never runnable work. Two connections to the same
// account share a deadline, while API and browser retain independent transports.
export function socialAccountScope(connection, spec) {
  const method = connection?.integrationMethod;
  if (!['api', 'browser'].includes(method) || spec?.integrationMethod && spec.integrationMethod !== method) fail('Vía social no válida.', 409);
  const identities = spec?.identities || connection.identities;
  const paid = spec?.mode === 'paid';
  const account = paid ? identities?.adAccountId?.replace(/^act_/, '') : identities?.pageId;
  if (!/^\d{1,30}$/.test(account || '')) fail('La cuenta social no está verificada.', 409);
  return `social:account-cooldown:${method}:${paid ? 'ads' : 'page'}:${hash(account)}`;
}
export async function socialAccountNotBefore(store, connection, spec, { now = stamp() } = {}) {
  now = instant(now);
  const row = await store.db.get(`SELECT data FROM ${store.t('job_runs')} WHERE key=?`, [socialAccountScope(connection, spec)]);
  const until = row && JSON.parse(row.data).notBefore;
  return typeof until === 'string' && Number.isFinite(Date.parse(until)) && until > now ? instant(until) : null;
}
export async function deferSocialAccountTx(tx, connection, spec, until, { now = stamp() } = {}) {
  now = instant(now); until = instant(until);
  const key = socialAccountScope(connection, spec);
  const old = await tx.db.get(`SELECT data FROM ${tx.t('job_runs')} WHERE key=?`, [key]);
  const previous = old && JSON.parse(old.data).notBefore;
  if (previous && previous >= until) return previous;
  const data = JSON.stringify({ kind: 'social-account-cooldown', notBefore: until });
  if (old) await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state='succeeded',data=?,updated_at=?,version=version+1 WHERE key=?`, [data, now, key]);
  else await insertRow(tx, 'job_runs', { key, state: 'succeeded', lease_token: null, lease_until: null, started_at: null, finished_at: now, error_code: null, data, version: 1, created_at: now, updated_at: now });
  return until;
}
