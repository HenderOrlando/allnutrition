import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { auditFindings, publicationFailure, publishAuditFindings } from '../scripts/audit-issues.mjs';

const path = '/repos/HenderOrlando/allnutrition/issues';
const actor = { login: 'fixture-audit', id: 17, type: 'User' };
const token = 'github_pat_fixture_AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const privateCanary = 'RAW_ private.internal secret customer/123 jobs:private';
const report = (props = {}) => ({ status: 'failed', stage: 'disposable-suite', finishedAt: '2026-11-22T09:00:00.000Z',
  manifest: { coveredThrough: 'a'.repeat(40), private: privateCanary }, error: privateCanary,
  cohort: { web: privateCanary }, heartbeat: [{ key: privateCanary }], ...props });
const row = { state: 'failed', key: privateCanary, errorCode: privateCanary, updatedAt: privateCanary };
const existing = (finding, props = {}) => ({ ...finding, number: 5, user: actor, state: 'open', updated_at: '2026-11-21T09:00:00.000Z', ...props });

async function fake(t) {
  const records = [], requests = [];
  const behavior = { actor, ambiguous: false, loseCreated: false, rejectCreate: false, paginated: false, swapOwner: false, redirect: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const method = req.method;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ path: url.pathname, method, body, auth: req.headers.authorization, page: url.searchParams.get('page') });
    const send = (status, data, headers) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/user') {
      if (behavior.redirect) return send(302, { message: privateCanary }, { location: '/redirect-must-not-follow' });
      return send(200, behavior.actor);
    }
    if (url.pathname === path && method === 'GET') {
      if (behavior.paginated && url.searchParams.get('page') === '1') return send(200, [], { link: '<https://private.invalid/never-follow>; rel="next"' });
      return send(200, records);
    }
    if (url.pathname === path && method === 'POST') {
      if (behavior.rejectCreate) return send(403, { message: privateCanary });
      const issue = existing(body, { number: records.length + 50 });
      issue.body = issue.body.replace(/\n/g, '\r\n') + '\r\n';
      if (!behavior.loseCreated) records.push(issue);
      if (behavior.ambiguous) return send(502, { message: privateCanary });
      return send(201, issue);
    }
    const issue = records.find(issue => url.pathname === `${path}/${issue.number}`);
    if (!issue) return send(404, { message: privateCanary });
    if (method === 'GET') return send(200, behavior.swapOwner ? { ...issue, user: { ...actor, id: 19 } } : issue);
    Object.assign(issue, body);
    return send(200, issue);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const fetchImpl = (url, init) => {
    const fixed = new URL(url);
    assert.equal(fixed.origin, 'https://api.github.com');
    assert.equal(init.redirect, 'error');
    return fetch(`http://127.0.0.1:${server.address().port}${fixed.pathname}${fixed.search}`, init);
  };
  let disk = [], writes = 0;
  const publish = (value, overrides = {}) => publishAuditFindings({ report: value, fetchImpl, credentials: () => ({ token, actor: actor.login }),
    intents: new Set(disk), saveIntents: intents => { disk = [...intents]; writes++; }, beforeWrite: () => {}, ...overrides });
  return { records, requests, behavior, publish, state: () => ({ disk, writes }), mutations: () => requests.filter(req => req.method !== 'GET') };
}

test('public projection only includes allowed labels, bounded count and validated short commit', () => {
  const [audit, jobs] = auditFindings(report({ stage: privateCanary, recentFailures: Array(60).fill(row) }));
  assert.match(audit.body, /^<!-- allnutrition-weekly-audit:v1:audit-failure -->/);
  assert.match(audit.body, /Etapa: No determinada/);
  assert.match(audit.body, /Commit desplegado: `aaaaaaaaaaaa`\n/);
  assert.match(jobs.body, /Hallazgos observados: 50 \(límite de lectura\)/);
  assert(!`${audit.body}\n${jobs.body}`.includes(privateCanary));
  assert(!`${audit.body}\n${jobs.body}`.includes('2026-11-22'));
  assert.match(auditFindings(report({ manifest: { coveredThrough: privateCanary } }))[0].body, /Commit desplegado: no verificado/);
});

test('clean, running and superseded reports never load credentials or contact GitHub', async () => {
  for (const status of ['passed', 'running', 'superseded']) {
    const result = await publishAuditFindings({ report: report({ status, recentFailures: status === 'passed' ? [] : [row] }), credentials: () => assert.fail('read secret'), fetchImpl: () => assert.fail('connected') });
    assert.deepEqual(result, []);
  }
});

test('a passed audit still creates one jobs issue; repeats reuse it and leaks no raw fields', async t => {
  const f = await fake(t);
  const passed = report({ status: 'passed', recentFailures: [row, { state: 'succeeded', key: privateCanary }], closingRecentFailures: [] });
  assert.deepEqual(await f.publish(passed), [{ kind: 'job-failures', issue: 50, action: 'created' }]);
  assert.deepEqual(auditFindings({ ...passed, recentFailures: [], closingRecentFailures: [row] }), auditFindings(passed));
  assert.deepEqual(await f.publish(passed), [{ kind: 'job-failures', issue: 50, action: 'unchanged' }]);
  assert.equal(f.mutations().length, 1);
  const [post] = f.mutations();
  assert.equal(post.auth, `Bearer ${token}`);
  assert.deepEqual(Object.keys(post.body).sort(), ['body', 'title']);
  assert.match(post.body.body, /Hallazgos observados: 1/);
  assert(!JSON.stringify(post.body).includes(privateCanary));
  assert.deepEqual(f.state().disk, []);
});

test('failed suite with failed jobs registers both stable families', async t => {
  const f = await fake(t);
  assert.deepEqual(await f.publish(report({ recentFailures: [row] })), [
    { kind: 'audit-failure', issue: 50, action: 'created' }, { kind: 'job-failures', issue: 51, action: 'created' },
  ]);
  assert.equal(f.mutations().length, 2);
});

test('recurrences update the verified issue, respect pagination and ignore older observations', async t => {
  const f = await fake(t);
  f.behavior.paginated = true;
  f.records.push(existing(auditFindings(report({ stage: 'inventory' }))[0], { state: 'closed' }));
  assert.deepEqual(await f.publish(report()), [{ kind: 'audit-failure', issue: 5, action: 'updated' }]);
  assert.equal(f.mutations().at(-1).body.state, 'open');
  assert(f.requests.some(req => req.page === '2'));
  f.records[0].updated_at = '2026-11-22T09:05:00.000Z';
  assert.deepEqual(await f.publish(report({ stage: 'closing-inventory' })), [{ kind: 'audit-failure', issue: 5, action: 'newer-issue' }]);
  assert.equal(f.mutations().length, 1);
});

test('author, actor and additional marker mismatches never mutate Issues', async t => {
  const f = await fake(t);
  const finding = auditFindings(report())[0];
  f.behavior.actor = { ...actor, login: 'unexpected' };
  await assert.rejects(f.publish(report()), /wrong-actor/);
  f.behavior.actor = actor;
  f.records.push(existing(finding, { user: { ...actor, id: 19 } }));
  await assert.rejects(f.publish(report()), /unowned-marker/);
  f.records[0].user = actor;
  f.behavior.swapOwner = true;
  await assert.rejects(f.publish(report()), /unowned-marker/);
  f.behavior.swapOwner = false;
  f.records.push(existing(finding, { number: 6 }));
  await assert.rejects(f.publish(report()), /ambiguous-marker/);
  assert.equal(f.mutations().length, 0);
});

test('a lost successful POST reconciles without duplication; unknown absence stays blocked under durable intent', async t => {
  const f = await fake(t);
  f.behavior.ambiguous = true;
  await assert.rejects(f.publish(report()), error => publicationFailure(error) === 'github-response' && error.status === 502);
  assert.deepEqual(f.state().disk, ['audit-failure']);
  assert.deepEqual(await f.publish(report()), [{ kind: 'audit-failure', issue: 50, action: 'unchanged' }]);
  assert.deepEqual(f.state().disk, []);
  f.records.length = 0;
  f.behavior.loseCreated = true;
  await assert.rejects(f.publish(report()), /github-response/);
  await assert.rejects(f.publish(report()), /create-unconfirmed/);
  assert.equal(f.mutations().length, 2);
});

test('explicit refusal remains retryable, pre-write cohort change and redirects fail closed', async t => {
  const f = await fake(t);
  f.behavior.redirect = true;
  await assert.rejects(f.publish(report()), /github-transport/);
  assert(!f.requests.some(req => req.path === '/redirect-must-not-follow'));
  f.behavior.redirect = false;
  await assert.rejects(f.publish(report(), { beforeWrite: () => { throw Error('fixture changed'); } }), /fixture changed/);
  assert.equal(f.mutations().length, 0);
  f.behavior.rejectCreate = true;
  await assert.rejects(f.publish(report()), error => publicationFailure(error) === 'github-response' && error.status === 403);
  assert.deepEqual(f.state().disk, []);
  f.behavior.rejectCreate = false;
  assert.equal((await f.publish(report()))[0].action, 'created');
  await assert.rejects(f.publish(report(), { credentials: () => ({ actor: actor.login }) }), /invalid-credential/);
});
