import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

const api = 'https://api.github.com';
const issues = '/repos/HenderOrlando/allnutrition/issues';
const tokenFile = '/etc/allnutrition-audit/github-issues-token';
const sha = /^[a-f0-9]{40}$/;
const login = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\[bot\])?$/i;
const stages = new Map([
  ['inventory', 'Inventario'], ['live-https', 'Sondas HTTPS'],
  ['disposable-suite', 'Suite aislada'], ['closing-inventory', 'Inventario de cierre'],
]);
const kinds = {
  'audit-failure': { title: 'Producción: revisar fallo de auditoría semanal', advice: 'Revisar el informe privado de la auditoría semanal y corregir la etapa indicada.' },
  'job-failures': { title: 'Producción: revisar trabajos fallidos recientes', advice: 'Revisar los fallos recientes en el informe privado y confirmar su resolución sin repetir operaciones inciertas.' },
};

class DeliveryError extends Error {
  constructor(code, status) { super(code); this.status = status; }
}
const ensure = (value, code) => { if (!value) throw new DeliveryError(code); };

export function auditFindings(report) {
  if (!['passed', 'failed'].includes(report?.status)) return [];
  const found = [];
  if (report.status === 'failed') found.push({ kind: 'audit-failure', count: 1, stage: stages.get(report.stage) ?? 'No determinada' });
  const failedJobs = rows => Array.isArray(rows) ? rows.filter(job => job?.state === 'failed').length : 0;
  // These are two snapshots of the same window, not disjoint counts.
  const count = Math.min(50, Math.max(failedJobs(report.recentFailures), failedJobs(report.closingRecentFailures)));
  if (count) found.push({ kind: 'job-failures', count });
  if (!found.length) return found;
  const observedAt = Date.parse(report.finishedAt);
  ensure(Number.isFinite(observedAt), 'invalid-report');
  const commit = sha.test(report.manifest?.coveredThrough) ? report.manifest.coveredThrough : null;
  return found.map(({ kind, count, stage }) => {
    const { title, advice } = kinds[kind];
    const marker = `<!-- allnutrition-weekly-audit:v1:${kind} -->`;
    const body = [marker, '', `Categoría: ${kind === 'audit-failure' ? 'Fallo de auditoría' : 'Trabajos fallidos recientes'}`,
      `Commit desplegado: ${commit ? `\`${commit.slice(0, 12)}\`` : 'no verificado'}`,
      ...(stage ? [`Etapa: ${stage}`] : []), `Hallazgos observados: ${count}${kind === 'job-failures' && count === 50 ? ' (límite de lectura)' : ''}`,
      '', advice].join('\n');
    return { kind, title, marker, body, observedAt };
  });
}

export function auditIssueCredentials() {
  let fd;
  try {
    fd = openSync(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    ensure(info.isFile() && info.uid === 0 && info.gid === 0 && (info.mode & 0o777) === 0o600 && info.size <= 512, 'invalid-credential');
    return { token: readFileSync(fd, 'utf8').trim(), actor: process.env.ALLNUTRITION_AUDIT_GITHUB_ACTOR };
  } catch { throw new DeliveryError('invalid-credential'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function publishAuditFindings({ report, credentials = auditIssueCredentials, intents, saveIntents, beforeWrite, fetchImpl = fetch }) {
  const findings = auditFindings(report);
  if (!findings.length) return [];
  const { token, actor } = credentials();
  ensure(typeof token === 'string' && /^github_pat_[A-Za-z0-9_]{20,240}$/.test(token) && typeof actor === 'string' && login.test(actor), 'invalid-credential');
  async function request(path, method = 'GET', body) {
    let res;
    try {
      res = await fetchImpl(api + path, { method, redirect: 'error', signal: AbortSignal.timeout(20_000), headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new DeliveryError('github-transport'); }
    if (res.status !== (method === 'POST' ? 201 : 200)) {
      res.body?.cancel().catch(() => {});
      throw new DeliveryError('github-response', res.status);
    }
    try { return { data: await res.json(), more: /;\s*rel="next"/.test(res.headers.get('link') ?? '') }; }
    catch { throw new DeliveryError('github-payload'); }
  }
  const { data: user } = await request('/user');
  const correctLogin = identity => typeof identity?.login === 'string' && actor.toLowerCase() === identity.login.toLowerCase();
  ensure(correctLogin(user) && Number.isSafeInteger(user.id) && user.id > 0 && user.type === (actor.toLowerCase().endsWith('[bot]') ? 'Bot' : 'User'), 'wrong-actor');
  const owned = issue => correctLogin(issue.user) && issue.user.id === user.id && issue.user.type === user.type;
  const numbered = issue => Number.isSafeInteger(issue?.number) && issue.number > 0;
  const hasMarker = (issue, marker) => !issue?.pull_request && typeof issue?.body === 'string' && issue.body.split(/\r?\n/).includes(marker);
  const sameBody = (issue, body) => typeof issue.body === 'string' && issue.body.replace(/\r\n/g, '\n').replace(/\n+$/, '') === body;
  const matches = new Map(findings.map(({ kind }) => [kind, []]));
  for (let page = 1; ; page++) {
    const { data, more } = await request(`${issues}?state=all&per_page=100&page=${page}`);
    ensure(Array.isArray(data), 'github-payload');
    for (const finding of findings) for (const issue of data) if (hasMarker(issue, finding.marker)) matches.get(finding.kind).push(issue);
    if (!more) break;
    ensure(page < 50, 'github-pagination');
  }

  function confirm(issue, finding, number) {
    ensure(numbered(issue) && (!number || issue.number === number) && owned(issue) && issue.state === 'open' &&
      issue.title === finding.title && sameBody(issue, finding.body) && !issue.pull_request, 'github-payload');
  }
  const results = [];
  for (const finding of findings) {
    const { kind, title, body, marker, observedAt } = finding;
    const candidates = matches.get(kind);
    ensure(candidates.length <= 1, 'ambiguous-marker');
    let existing = candidates[0];
    if (existing) {
      ensure(numbered(existing) && owned(existing), 'unowned-marker');
      // Re-read the exact issue before touching it; don't overwrite a newer
      // observation or a maintainer's close that is newer than this report.
      await beforeWrite();
      const number = existing.number;
      ({ data: existing } = await request(`${issues}/${number}`));
      ensure(existing?.number === number && hasMarker(existing, marker) && owned(existing), 'unowned-marker');
      if (intents.has(kind)) { intents.delete(kind); saveIntents(intents); }
      if (existing.state === 'open' && sameBody(existing, body) && existing.title === title) {
        results.push({ kind, issue: number, action: 'unchanged' }); continue;
      }
      const updatedAt = Date.parse(existing.updated_at);
      ensure(['open', 'closed'].includes(existing.state) && Number.isFinite(updatedAt), 'github-payload');
      if (Math.floor(observedAt / 1000) <= Math.floor(updatedAt / 1000)) {
        results.push({ kind, issue: number, action: 'newer-issue' }); continue;
      }
      const { data } = await request(`${issues}/${number}`, 'PATCH', { title, body, ...(existing.state === 'closed' ? { state: 'open' } : {}) });
      confirm(data, finding, number);
      results.push({ kind, issue: number, action: 'updated' });
    } else {
      // GitHub has no idempotency key for POST /issues. Persist the create
      // intent before sending it; never blindly retry an ambiguous response.
      ensure(!intents.has(kind), 'create-unconfirmed');
      await beforeWrite();
      intents.add(kind);
      saveIntents(intents);
      let data;
      try { ({ data } = await request(issues, 'POST', { title, body })); }
      catch (error) {
        if ([400, 401, 403, 404, 422, 429].includes(error.status)) { intents.delete(kind); saveIntents(intents); }
        throw error;
      }
      confirm(data, finding);
      intents.delete(kind);
      saveIntents(intents);
      results.push({ kind, issue: data.number, action: 'created' });
    }
  }
  return results;
}

export function publicationFailure(error) {
  return error instanceof DeliveryError ? error.message : 'publication-error';
}
