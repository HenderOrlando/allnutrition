import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAdmin, login } from '../lib/auth.mjs';
import { emptyRecord } from '../lib/schema.mjs';
import { createBusinessBasics, createBusinessFixture, businessOrderInput } from './business-fixtures.mjs';
import { saveAccount, accountBalance, recordIncome } from '../lib/business/cash.mjs';
import { getBusinessSettings } from '../lib/business/settings.mjs';
import { recordExpense } from '../lib/business/expenses.mjs';
import { preparePayroll } from '../lib/business/payroll.mjs';
import { saveSocialCampaign, getSocialCampaign } from '../lib/business/social.mjs';
import { getShipment, saveShipment } from '../lib/business/shipments.mjs';
import { formatMoneyMinor } from '../lib/business/money.mjs';
import { serializeAssistantForm, serializeAssistantHumanAcknowledgements, assistantEconomicFieldKind } from '../lib/assistant/forms.mjs';
import { createAssistantEvidence } from '../lib/assistant/evidence.mjs';
import { prepareAssistantChange, reviseAssistantProposal, executeAssistantProposal, assistantProposalDTO } from '../lib/assistant/actions.mjs';
import { reserveAssistantTurn, finishAssistantTurn, hashAssistantInput, hashAssistantProposalPayload, getAssistantProposal, cancelAssistantTurn, updateAssistantThread } from '../lib/assistant/repository.mjs';

const password = 'synthetic-actions-password-only';
const locked = (store, fn) => store.transaction(async tx => { await tx.lockWrites(); return fn(tx); });
async function actor(store, email = `actions-${randomUUID()}@example.test`) {
  await createAdmin(store, email, password);
  const authenticated = await login(store, email, password);
  const user = await store.db.get(`SELECT id,email FROM ${store.t('users')} WHERE email=?`, [email]);
  return { user, csrf: authenticated.csrf, sessionTokenHash: createHash('sha256').update(authenticated.token).digest('hex') };
}
async function fixture(t, factory, { basics = false } = {}) {
  const store = await factory();
  t.after(() => store.close());
  const session = await actor(store), at = new Date().toISOString();
  // Action contracts never infer or decrypt credentials. A synthetic ready row
  // exercises the access guard without contacting any provider or key custody.
  await store.db.run(`INSERT INTO ${store.t('assistant_settings')}(id,version,enabled,data,api_key_ciphertext,api_key_iv,api_key_tag,actor_id,created_at,updated_at) VALUES(1,1,1,?,?,?,?,?,?,?)`, [JSON.stringify({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:3339/v1', model: 'fixture-a', allowPrivateNetwork: true, connectionStatus: 'ready', verifiedAt: at }), 'synthetic-ciphertext-only', 'synthetic-iv-only', 'synthetic-tag-only', session.user.id, at, at]);
  const business = basics ? await createBusinessBasics(store, { actorId: session.user.id }) : null;
  return { store, session, business };
}
function recordEvidence(record, kind = 'products', field = 'title') {
  return createAssistantEvidence({ domain: 'catalog', entityId: record.id, recordVersion: record.version, field, label: field === 'title' ? 'Nombre' : 'Descripción', value: record[field], href: { section: kind, record: record.id } });
}
async function product(f, changes = {}) {
  return f.store.save('products', { ...emptyRecord('products'), title: 'Borrador sintético', slug: `draft-${randomUUID()}`, status: 'draft', price: 50000, presentation: 'Unidad', stockQuantity: 10, description: 'Descripción anterior', ...changes }, null, null, f.session.user.id);
}
async function proposal(f, { target, entityId = null, recordVersion = null, patch, values = null, dirty = false, message = 'Revisa el cambio solicitado.', intent = 'save', evidence = [], literal = false, sourceRefs = [], complete = true, formId = 'actions-contract-form' }) {
  const financialSpans = [];
  const collect = (value, path = '', field = '') => {
    if (Array.isArray(value)) return value.forEach((item, index) => collect(item, `${path}.${index}`, field));
    if (value && typeof value === 'object') return Object.entries(value).forEach(([key, item]) => collect(item, path ? `${path}.${key}` : key, key));
    if (value == null || value === '') return;
    const kind = assistantEconomicFieldKind(field);
    if (kind === 'money' || kind === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(value)) {
      const text = typeof value === 'number' ? field === 'price' ? String(value) : formatMoneyMinor(value).replace(/[^\d,.-]/gu, '') : value;
      financialSpans.push({ field: path, text, money: kind === 'money' });
    }
  };
  if (message === 'Revisa el cambio solicitado.') {
    collect(patch);
    for (const item of financialSpans) {
      message += ` ${item.field}: `;
      item.start = message.length;
      message += item.text;
      item.end = message.length;
      if (item.money) message += ' COP';
    }
  }
  const requestId = randomUUID();
  const turn = await locked(f.store, tx => reserveAssistantTurn(tx, { userId: f.session.user.id, sessionTokenHash: f.session.sessionTokenHash, requestId, inputHash: hashAssistantInput({ message, requestId }), configurationVersion: 1, data: { message } }));
  const suppliedSources = typeof sourceRefs === 'function' ? sourceRefs(turn.turn.id, message) : sourceRefs;
  sourceRefs = [...suppliedSources, ...financialSpans.map(({ field, start, end }) => ({ field, turnId: turn.turn.id, start, end }))];
  if (literal) sourceRefs = Object.entries(patch).filter(([, value]) => typeof value === 'string' && message.includes(value)).map(([field, value]) => ({ field, turnId: turn.turn.id, start: message.indexOf(value), end: message.indexOf(value) + value.length }));
  const form = values === null ? null : { formId, target, entityId, recordVersion, generation: 0, values: serializeAssistantForm(target, values), dirty, busy: false };
  const prepared = await prepareAssistantChange(f.store, f.session, { threadId: turn.threadId, turnId: turn.turn.id, target, entityId, patch, sourceRefs, formContext: { view: { section: 'orders', tab: 'list' }, form, evidence }, intent });
  if (complete) await locked(f.store, tx => finishAssistantTurn(tx, { userId: f.session.user.id, turnId: turn.turn.id, data: { message, publicResult: { threadId: turn.threadId, threadVersion: turn.threadVersion, turnId: turn.turn.id, configurationVersion: 1, topic: target.startsWith('record:') ? 'catalog' : 'cash', blocks: [], evidence, question: null, proposal: prepared, receipt: null, followUps: [] } } }));
  return { proposal: prepared, turn, binding: { formId: prepared.formId || formId, target, entityId: prepared.entityId, recordVersion: prepared.recordVersion, generation: prepared.generation ?? 0 } };
}
const executeInput = p => ({ proposalId: p.id, version: p.version, requestId: p.id, confirmation: p.execution === 'automatic' ? null : { proposalId: p.id, payloadHash: p.payloadHash } });
const execute = (f, p) => executeAssistantProposal(f.store, f.session, executeInput(p));
async function persisted(f, p) { return getAssistantProposal(f.store, { userId: f.session.user.id, proposalId: p.id }); }
async function command(f, action, input, { entityId = null, recordVersion = null } = {}) {
  const { requestId: ignoredRequest, version: ignoredVersion, ...patch } = input;
  const current = await proposal(f, { target: `business-action:${action}`, entityId, recordVersion, patch });
  assert.deepEqual(current.proposal.missingFields, [], `${action} has complete explicit inputs`);
  const result = await execute(f, current.proposal);
  assert.equal(result.receipt.proposalId, current.proposal.id);
  return { ...result, proposal: current.proposal };
}
async function pendingOrder(f, { sourceSession = f.session, sourceState = 'completed', separateThread = false, authorized = true, target = 'order', matchingAnswer = true, currency = 'COP' } = {}) {
  const { a, year } = f.business, placedOn = `${year}-09-09`, price = String(a.price);
  const sourceMessage = `Crea un pedido del producto ${a.id}, precio ${price} ${currency}, fecha ${placedOn}, teléfono 3001234567, ciudad Bogotá. Falta el nombre.`;
  const question = { id: randomUUID(), prompt: '¿A nombre de quién va el pedido?', input: 'text', options: [], allowText: true };
  const reserve = (session, message, thread = null, answer = null) => {
    const requestId = randomUUID();
    return locked(f.store, tx => reserveAssistantTurn(tx, { userId: session.user.id, sessionTokenHash: session.sessionTokenHash, threadId: thread?.threadId ?? null, threadVersion: thread?.threadVersion ?? null, requestId, inputHash: hashAssistantInput({ requestId, message, answer }), configurationVersion: 1, data: { message, answer } }));
  };
  const publicResult = (turn, proposal = null) => ({ threadId: turn.threadId, threadVersion: turn.threadVersion, turnId: turn.turn.id, configurationVersion: 1, topic: 'orders', blocks: [], evidence: [], question: proposal ? null : question, proposal, receipt: null, followUps: [] });
  const source = await reserve(sourceSession, sourceMessage);
  await locked(f.store, tx => finishAssistantTurn(tx, { userId: sourceSession.user.id, turnId: source.turn.id, state: sourceState, data: { message: sourceMessage, ...(sourceState === 'completed' ? { publicResult: publicResult(source) } : {}) } }));
  let questionTurn = source;
  if (sourceSession.user.id !== f.session.user.id || separateThread || sourceState !== 'completed') {
    const sameThread = sourceSession.user.id === f.session.user.id && !separateThread ? source : null;
    questionTurn = await reserve(f.session, question.prompt, sameThread);
    await locked(f.store, tx => finishAssistantTurn(tx, { userId: f.session.user.id, turnId: questionTurn.turn.id, data: { message: question.prompt, publicResult: publicResult(questionTurn) } }));
  }
  const pending = await locked(f.store, tx => updateAssistantThread(tx, { userId: f.session.user.id, threadId: questionTurn.threadId, version: questionTurn.threadVersion, data: { pendingQuestion: question, pendingQuestionContext: { kind: 'missing_field', target, field: 'customerName', sourceTurnIds: authorized ? [source.turn.id] : [] } } }));
  const message = 'Cliente continuidad QA', answer = { questionId: matchingAnswer ? question.id : randomUUID(), optionId: null, text: message };
  const current = await reserve(f.session, message, { threadId: questionTurn.threadId, threadVersion: pending.version }, answer);
  const span = (field, literal) => {
    const start = sourceMessage.indexOf(literal, field === 'items.0.unitPriceMinor' ? sourceMessage.indexOf('precio ') + 7 : 0);
    return { field, turnId: source.turn.id, start, end: start + literal.length };
  };
  const patch = { customerName: message, phone: '3001234567', city: 'Bogotá', placedOn, items: [{ kind: 'products', itemId: a.id, quantity: 1, unitPriceMinor: a.price * 100 }] };
  const prepared = await prepareAssistantChange(f.store, f.session, { threadId: current.threadId, turnId: current.turn.id, target: 'order', entityId: null, patch, sourceRefs: [span('placedOn', placedOn), span('items.0.unitPriceMinor', price)], formContext: { view: { section: 'orders', tab: 'list' }, form: null, evidence: [], allowedInputTurnIds: [source.turn.id] }, intent: 'save' });
  await locked(f.store, async tx => {
    const row = await tx.db.get(`SELECT data,version FROM ${tx.t('assistant_threads')} WHERE id=? AND user_id=?`, [current.threadId, f.session.user.id]);
    const updated = await updateAssistantThread(tx, { userId: f.session.user.id, threadId: current.threadId, version: row.version, data: { ...JSON.parse(row.data), pendingQuestion: null, pendingQuestionContext: null } });
    await finishAssistantTurn(tx, { userId: f.session.user.id, turnId: current.turn.id, data: { message, answer, publicResult: { ...publicResult(current, prepared), threadVersion: updated.version } } });
  });
  return { proposal: prepared, source, current, patch };
}
async function campaignConnection(f, currency) {
  const id = randomUUID(), at = new Date().toISOString();
  await f.store.db.run(`INSERT INTO ${f.store.t('social_connections')}(id,provider,integration_method,state,data,version,created_at,updated_at) VALUES(?,'meta','api','connected',?,1,?,?)`, [id, JSON.stringify({ currency, timeZone: 'America/Bogota', identities: { userId: '201', businessId: '301', pageId: '101', adAccountId: 'act_401' }, sessionEpoch: 0 }), at, at]);
  return id;
}
async function campaign(f, connectionId, changes = {}) {
  const saved = await saveSocialCampaign(f.store, { requestId: randomUUID(), name: `Pauta QA ${randomUUID()}`, connectionId, mode: 'paid', objective: 'reach', platforms: ['facebook'], caption: 'Texto anterior', headline: '', budgetMinor: 5000, targetCostMinor: 200, ...changes }, f.session.user.id);
  return getSocialCampaign(f.store, saved.id);
}

export async function runAssistantActionsContracts(t, factory) {
  await t.test('literal draft changes prepare without writes, commit a real receipt, and recover it across later changes', async t => {
    const f = await fixture(t, factory), row = await product(f), text = 'Descripción literal nueva';
    const { proposal: p, turn } = await proposal(f, { target: 'record:products', entityId: row.id, patch: { description: text }, message: `Actualiza la descripción de ${row.title}: «${text}»`, literal: true, evidence: [recordEvidence(row)] });
    assert.equal(p.formId, null, 'an editor does not need to be mounted');
    assert.equal(p.execution, 'automatic');
    assert.equal((await f.store.get('products', row.id)).description, row.description);
    const result = await execute(f, p);
    assert.equal(result.result.description, text);
    assert.equal(result.result.version, row.version + 1);
    assert.equal(result.receipt.entityId, row.id);
    assert.equal(result.receipt.recordVersion, result.result.version);
    const origin = await f.store.db.get(`SELECT data FROM ${f.store.t('assistant_turns')} WHERE id=?`, [turn.turn.id]);
    assert.deepEqual(JSON.parse(origin.data).publicResult.receipt, result.receipt);
    const thread = await f.store.db.get(`SELECT data FROM ${f.store.t('assistant_threads')} WHERE id=?`, [turn.threadId]);
    assert.ok(JSON.parse(thread.data).workMemory.completedReceiptIds.includes(p.id));
    const audits = await f.store.db.all(`SELECT data,actor_id FROM ${f.store.t('business_audit')} WHERE entity_id=?`, [row.id]);
    assert.ok(audits.some(item => item.actor_id === f.session.user.id && JSON.parse(item.data).source === 'assistant'));
    assert.equal(JSON.stringify(audits).includes(`Actualiza la descripción de ${row.title}`), false);
    await f.store.save('products', { ...result.result, description: 'Edición posterior humana' }, row.id, result.result.version, f.session.user.id);
    await f.store.db.run(`UPDATE ${f.store.t('assistant_settings')} SET version=2,enabled=0 WHERE id=1`);
    assert.deepEqual(await execute(f, p), result, 'retry recovers the exact committed response before disabled/config/business guards');
    assert.equal((await f.store.get('products', row.id)).description, 'Edición posterior humana');
    const publicCommitted = assistantProposalDTO(await persisted(f, p));
    assert.equal(publicCommitted.entityId, result.receipt.entityId);
    assert.equal(publicCommitted.recordVersion, result.receipt.recordVersion);
    await assert.rejects(() => executeAssistantProposal(f.store, f.session, { ...executeInput(p), confirmation: { proposalId: p.id, payloadHash: p.payloadHash } }), error => error.status === 409);
    const other = await actor(f.store);
    await assert.rejects(() => executeAssistantProposal(f.store, other, executeInput(p)), error => error.status === 404);
    await f.store.db.run(`DELETE FROM ${f.store.t('sessions')} WHERE token_hash=?`, [f.session.sessionTokenHash]);
    await assert.rejects(() => execute(f, p), error => error.status === 401);
  });
  await t.test('automatic execution never saves form-only prices, and public, dirty, hypothetical or unproven edits require confirmation', async t => {
    const f = await fixture(t, factory), row = await product(f), description = 'Texto exacto indicado';
    const clean = await proposal(f, { target: 'record:products', entityId: row.id, recordVersion: row.version, values: { ...row, price: 1 }, patch: { description }, message: `Actualiza la descripción de ${row.title}: «${description}»`, literal: true });
    assert.equal(clean.proposal.execution, 'automatic');
    await execute(f, clean.proposal);
    const saved = await f.store.get('products', row.id);
    assert.equal(saved.price, row.price, 'client form values are not evidence of saved facts or permission to change money');
    for (const scenario of [
      { message: `¿Actualiza la descripción de ${saved.title}: «${description}»?`, literal: true },
      { message: `Actualiza la descripción de ${saved.title}: «${description}» si fuera apropiado`, literal: true },
      { message: `Actualiza la descripción de ${saved.title}: «${description}»`, literal: false },
      { message: `Actualiza la descripción de ${saved.title}: «${description}»`, literal: true, dirty: true },
      { message: `Actualiza la descripción de ${saved.title}: «${description}»`, literal: true, patch: { price: 1 } },
    ]) {
      const next = await proposal(f, { target: 'record:products', entityId: saved.id, recordVersion: saved.version, values: saved, patch: { description }, ...scenario });
      assert.notEqual(next.proposal.execution, 'automatic');
      await assert.rejects(() => executeAssistantProposal(f.store, f.session, { ...executeInput(next.proposal), confirmation: null }), error => error.status === 403);
    }
    const published = await product(f, { status: 'published', image: '/brand/creatina-vital-force.jpg' });
    const publicChange = await proposal(f, { target: 'record:products', entityId: published.id, patch: { description }, message: `Actualiza la descripción de ${published.title}: «${description}»`, literal: true, evidence: [recordEvidence(published)] });
    assert.equal(publicChange.proposal.execution, 'confirm');
  });
  await t.test('literal-source authorization cannot hide a condition, an unrelated field or the entity selector', async t => {
    const f = await fixture(t, factory), row = await product(f), replacement = 'Texto exacto';
    const message = `Actualiza la descripción de ${row.title} a «${replacement}» si lo confirmo`;
    const refs = (turnId, body, extraField) => [
      { field: 'description', turnId, start: body.indexOf(replacement), end: body.indexOf(replacement) + replacement.length },
      { field: extraField, turnId, start: body.indexOf('si lo confirmo'), end: body.length },
    ];
    await assert.rejects(() => proposal(f, { target: 'record:products', entityId: row.id, patch: { description: replacement }, message, evidence: [recordEvidence(row)], sourceRefs: (turnId, body) => refs(turnId, body, 'authorization') }), error => error.status === 422);
    await assert.rejects(() => proposal(f, { target: 'record:products', entityId: row.id, patch: { description: replacement }, message, evidence: [recordEvidence(row)], sourceRefs: (turnId, body) => refs(turnId, body, 'description') }), error => error.status === 422);
    const conditional = await proposal(f, { target: 'record:products', entityId: row.id, patch: { description: `${replacement} si lo confirmo` }, message: `Actualiza la descripción de ${row.title} a ${replacement} si lo confirmo`, literal: true, evidence: [recordEvidence(row)] });
    assert.equal(conditional.proposal.execution, 'confirm');
    const wrongField = await proposal(f, { target: 'record:products', entityId: row.id, patch: { description: replacement }, message: `Actualiza el título de ${row.title} a «${replacement}»`, literal: true, evidence: [recordEvidence(row)] });
    assert.equal(wrongField.proposal.execution, 'confirm');
    const hiddenEntity = await proposal(f, { target: 'record:products', entityId: row.id, patch: { description: row.title }, message: `Actualiza la descripción a «${row.title}»`, literal: true, evidence: [recordEvidence(row)] });
    assert.equal(hiddenEntity.proposal.execution, 'confirm');
    const actualQuotedText = 'No modificar si lo confirmo';
    const explicit = await proposal(f, { target: 'record:products', entityId: row.id, patch: { description: actualQuotedText }, message: `Actualiza la descripción de ${row.title} a «${actualQuotedText}»`, literal: true, evidence: [recordEvidence(row)] });
    assert.equal(explicit.proposal.execution, 'automatic', 'explicit quoted business text is data, not a conditional authorization');
    const committed = await execute(f, explicit.proposal);
    assert.equal(committed.result.description, actualQuotedText);
    assert.equal(committed.result.title, row.title);
  });
  await t.test('closed automatic grammar rejects every unconsumed instruction and binds an explicit entity even with a clean mounted form', async t => {
    const f = await fixture(t, factory), alfa = await product(f, { title: 'Producto Alfa' }), beta = await product(f, { title: 'Producto Beta' });
    const description = 'Texto nuevo explícito';
    for (const suffix of ['; espera mi autorización', '; consulta conmigo antes de hacerlo', '; deja pendiente el guardado']) {
      const pending = await proposal(f, { target: 'record:products', entityId: beta.id, recordVersion: beta.version, values: beta, patch: { description }, message: `Actualiza la descripción de ${beta.title} a «${description}»${suffix}`, literal: true });
      assert.equal(pending.proposal.execution, 'confirm');
    }
    const different = await proposal(f, { target: 'record:products', entityId: beta.id, recordVersion: beta.version, values: beta, patch: { description }, message: `Actualiza la descripción de ${alfa.title} a «${description}»`, literal: true, evidence: [recordEvidence(alfa), recordEvidence(beta)] });
    assert.equal(different.proposal.execution, 'confirm');
    const ambiguous = await proposal(f, { target: 'record:products', entityId: beta.id, recordVersion: beta.version, values: beta, patch: { description }, message: `Actualiza la descripción de ${alfa.title} o ${beta.title} a «${description}»`, literal: true });
    assert.equal(ambiguous.proposal.execution, 'confirm');
    await product(f, { title: beta.title });
    const duplicateName = await proposal(f, { target: 'record:products', entityId: beta.id, recordVersion: beta.version, values: beta, patch: { description }, message: `Actualiza la descripción de ${beta.title} a «${description}»`, literal: true });
    assert.equal(duplicateName.proposal.execution, 'confirm', 'a mounted form cannot resolve an explicitly ambiguous name');
    const exactId = await proposal(f, { target: 'record:products', entityId: beta.id, recordVersion: beta.version, values: beta, patch: { description }, message: `Actualiza la descripción de ${beta.id} a «${description}»`, literal: true });
    assert.equal(exactId.proposal.execution, 'automatic');
    const implicit = await proposal(f, { target: 'record:products', entityId: beta.id, recordVersion: beta.version, values: beta, patch: { description }, message: `Actualiza la descripción a «${description}»`, literal: true });
    assert.equal(implicit.proposal.execution, 'automatic', 'only an omitted entity selector may resolve to the current clean form');
    const result = await execute(f, exactId.proposal);
    assert.equal(result.result.id, beta.id);
    assert.equal(result.result.description, description);
    assert.equal((await f.store.get('products', alfa.id)).description, alfa.description);
  });
  await t.test('entity names use the same exact accented case-sensitive identity in grammar and database lookup', async t => {
    const f = await fixture(t, factory), upper = await product(f, { title: 'Producto Á' }), lower = await product(f, { title: 'Producto á' });
    const description = 'Texto con identidad precisa';
    const wrongCase = await proposal(f, { target: 'record:products', entityId: upper.id, recordVersion: upper.version, values: upper, patch: { description }, message: `Actualiza la descripción de ${lower.title} a «${description}»`, literal: true });
    assert.equal(wrongCase.proposal.execution, 'confirm');
    const exact = await proposal(f, { target: 'record:products', entityId: lower.id, recordVersion: lower.version, values: lower, patch: { description }, message: `Actualiza la descripción de ${lower.title} a «${description}»`, literal: true });
    assert.equal(exact.proposal.execution, 'automatic');
    assert.equal((await execute(f, exact.proposal)).result.id, lower.id);
    assert.equal((await f.store.get('products', upper.id)).description, upper.description);
  });
  await t.test('a fully consumed quoted multi-field command commits only the explicitly named values', async t => {
    const f = await fixture(t, factory), row = await product(f);
    const patch = { description: 'Descripción escrita por el usuario', presentation: 'Tarro indicado' };
    const prepared = await proposal(f, { target: 'record:products', entityId: row.id, patch, message: `Actualiza la descripción de ${row.title}: «${patch.description}»; la presentación: «${patch.presentation}».`, literal: true, evidence: [recordEvidence(row)] });
    assert.equal(prepared.proposal.execution, 'automatic');
    const result = await execute(f, prepared.proposal);
    assert.equal(result.result.description, patch.description);
    assert.equal(result.result.presentation, patch.presentation);
    assert.equal(result.result.title, row.title);
    assert.equal(result.result.price, row.price);
  });
  await t.test('manual revise binds the entire visible payload, keeps same revision on equality, and invalidates the old confirmation', async t => {
    const f = await fixture(t, factory), row = await product(f);
    const prepared = await proposal(f, { target: 'record:products', entityId: row.id, recordVersion: row.version, values: row, patch: { description: 'Texto propuesto' } });
    const payload = { ...row, description: 'Texto propuesto' }, firstRequest = randomUUID();
    const equal = await reviseAssistantProposal(f.store, f.session, { proposalId: prepared.proposal.id, version: prepared.proposal.version, requestId: firstRequest, formBinding: prepared.binding, payload, humanAcknowledgements: serializeAssistantHumanAcknowledgements('record:products', payload) });
    assert.equal(equal.unchanged, true);
    assert.equal(equal.proposal.version, prepared.proposal.version);
    const editedPayload = { ...payload, price: 51000, slug: 'slug-elegido-por-humano' }, requestId = randomUUID(), binding = { ...prepared.binding, generation: 2 };
    const request = { proposalId: prepared.proposal.id, version: equal.proposal.version, requestId, formBinding: binding, payload: editedPayload, humanAcknowledgements: serializeAssistantHumanAcknowledgements('record:products', editedPayload) };
    const revised = await reviseAssistantProposal(f.store, f.session, request);
    assert.equal(revised.unchanged, false);
    assert.notEqual(revised.proposal.payloadHash, prepared.proposal.payloadHash);
    assert.ok(revised.proposal.diff.some(item => item.field === 'price' && item.after === 51000));
    assert.ok(revised.proposal.humanDiff.some(item => item.field === 'slug' && item.after === editedPayload.slug));
    assert.deepEqual(await reviseAssistantProposal(f.store, f.session, request), revised);
    await assert.rejects(() => reviseAssistantProposal(f.store, f.session, { ...request, payload: { ...editedPayload, price: 52000 } }), error => error.status === 409);
    await assert.rejects(() => execute(f, prepared.proposal), error => error.status === 409);
    const result = await execute(f, revised.proposal);
    assert.equal(result.result.price, editedPayload.price);
    assert.equal(result.result.slug, editedPayload.slug);
  });
  await t.test('a full human submission consumes staged reviewBase even when its commercial payload is unchanged', async t => {
    const f = await fixture(t, factory), row = await product(f);
    const prepared = await proposal(f, { target: 'record:products', entityId: row.id, recordVersion: row.version, values: row, patch: { description: 'Texto propuesto para revisar' } });
    const stored = await persisted(f, prepared.proposal);
    const staged = { ...stored.data, execution: 'prefill', reviewBase: { description: 'Edición local antes del parche' } };
    staged.payloadHash = hashAssistantProposalPayload(staged);
    await f.store.db.run(`UPDATE ${f.store.t('assistant_proposals')} SET data=? WHERE id=? AND user_id=?`, [JSON.stringify(staged), prepared.proposal.id, f.session.user.id]);
    const revised = await reviseAssistantProposal(f.store, f.session, { proposalId: prepared.proposal.id, version: prepared.proposal.version, requestId: randomUUID(), formBinding: prepared.binding, payload: staged.payload });
    assert.equal(revised.unchanged, false);
    assert.equal(revised.proposal.version, prepared.proposal.version + 1);
    assert.equal(revised.proposal.execution, 'confirm');
    assert.equal((await persisted(f, revised.proposal)).data.reviewBase, null);
    assert.notEqual(revised.proposal.payloadHash, staged.payloadHash);
    assert.equal((await f.store.get('products', row.id)).description, row.description);
    assert.equal((await execute(f, revised.proposal)).result.description, 'Texto propuesto para revisar');
  });
  await t.test('new order missing data stays prefill; a real human submission produces one order and one reservation', async t => {
    const f = await fixture(t, factory, { basics: true });
    const prepared = await proposal(f, { target: 'order', patch: { customerName: 'Cliente sintético nuevo' } });
    assert.equal(prepared.proposal.execution, 'prefill');
    assert.ok(prepared.proposal.missingFields.includes('phone'));
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('orders')}`)).n), 0);
    const payload = { ...businessOrderInput(f.business.a, { year: f.business.year, customerName: 'Cliente sintético nuevo' }), version: 0 };
    const revision = await reviseAssistantProposal(f.store, f.session, { proposalId: prepared.proposal.id, version: prepared.proposal.version, requestId: randomUUID(), formBinding: prepared.binding, payload, humanAcknowledgements: serializeAssistantHumanAcknowledgements('order', payload) });
    assert.equal(revision.proposal.execution, 'confirm');
    const response = await execute(f, revision.proposal);
    assert.equal(response.result.customerName, payload.customerName);
    assert.equal(response.result.items[0].quantity, 1);
    assert.equal((await f.store.get('products', f.business.a.id)).stockReserved, 1);
    assert.deepEqual(await execute(f, revision.proposal), response);
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('orders')}`)).n), 1);
    assert.equal((await f.store.get('products', f.business.a.id)).stockReserved, 1);
  });
  await t.test('answering the actual pending question reuses exact earlier economic inputs without granting an automatic write', async t => {
    const f = await fixture(t, factory, { basics: true });
    const prepared = await pendingOrder(f);
    assert.deepEqual(prepared.proposal.missingFields, []);
    assert.equal(prepared.proposal.execution, 'confirm');
    assert.equal(prepared.proposal.patch.placedOn, prepared.patch.placedOn);
    assert.equal(prepared.proposal.patch.items[0].unitPriceMinor, prepared.patch.items[0].unitPriceMinor);
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('orders')}`)).n), 0);
    await assert.rejects(() => executeAssistantProposal(f.store, f.session, { ...executeInput(prepared.proposal), confirmation: null }), error => error.status === 403);
    const response = await execute(f, prepared.proposal);
    assert.equal(response.result.customerName, prepared.patch.customerName);
    assert.equal(response.result.placedOn, prepared.patch.placedOn);
    assert.equal(response.result.items[0].unitPriceMinor, prepared.patch.items[0].unitPriceMinor);
    assert.deepEqual(await execute(f, prepared.proposal), response);
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('orders')}`)).n), 1);
    const current = await f.store.db.get(`SELECT data FROM ${f.store.t('assistant_turns')} WHERE id=?`, [prepared.current.turn.id]);
    assert.deepEqual(JSON.parse(current.data).publicResult.receipt, response.receipt);
  });
  await t.test('pending-question source authority excludes unrelated, foreign, interrupted and wrong-question input turns', async t => {
    const f = await fixture(t, factory, { basics: true }), foreign = await actor(f.store);
    for (const options of [
      { authorized: false },
      { sourceSession: foreign },
      { separateThread: true },
      { sourceState: 'failed' },
      { sourceState: 'cancelled' },
      { target: 'business-action:income' },
      { matchingAnswer: false },
    ]) {
      const prepared = await pendingOrder(f, options);
      assert.equal(prepared.proposal.execution, 'prefill');
      assert.ok(prepared.proposal.missingFields.includes('placedOn'));
      assert.ok(prepared.proposal.missingFields.includes('items'));
      assert.equal(Object.hasOwn(prepared.proposal.patch, 'placedOn'), false);
      assert.equal(Object.hasOwn(prepared.proposal.patch, 'items'), false);
      await assert.rejects(() => execute(f, prepared.proposal), error => error.status === 403);
    }
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('orders')}`)).n), 0);
  });
  await t.test('editing an existing order preserves saved line snapshots and reserves inventory only once', async t => {
    const f = await fixture(t, factory, { basics: true });
    const order = await f.store.saveOrder(businessOrderInput(f.business.a, { year: f.business.year }), f.session.user.id);
    const originalLine = order.items[0], reserved = (await f.store.get('products', f.business.a.id)).stockReserved;
    const prepared = await proposal(f, { target: 'order', entityId: order.id, patch: { notes: 'Instrucción administrativa explícita' } });
    const result = await execute(f, prepared.proposal);
    assert.equal(result.result.notes, 'Instrucción administrativa explícita');
    assert.deepEqual(result.result.items[0], originalLine);
    assert.equal(result.result.version, order.version + 1);
    assert.equal((await f.store.get('products', f.business.a.id)).stockReserved, reserved);
    assert.deepEqual(await execute(f, prepared.proposal), result);
  });
  await t.test('income and transfer use original handlers, preserve minor units, and balance their real entries exactly once', async t => {
    const f = await fixture(t, factory, { basics: true }), { account, person, year } = f.business;
    const destination = await saveAccount(f.store, { requestId: randomUUID(), name: 'Destino sintético', type: 'bank', responsibleId: person.id, openingOn: `${year}-09-01`, openingBalanceMinor: 0 }, f.session.user.id);
    const income = await proposal(f, { target: 'business-action:income', patch: { accountId: account.id, effectiveOn: `${year}-09-10`, amountMinor: '1.234,56', concept: 'owner_funding', description: 'Aporte sintético' } });
    assert.equal((await persisted(f, income.proposal)).data.payload.amountMinor, 123456);
    const before = await accountBalance(f.store, account.id);
    const received = await execute(f, income.proposal);
    assert.equal(received.result.amountMinor, 123456);
    assert.equal(await accountBalance(f.store, account.id), before + 123456);
    const transfer = await proposal(f, { target: 'business-action:transfer', patch: { fromAccountId: account.id, toAccountId: destination.id, effectiveOn: `${year}-09-11`, amountMinor: '1.000,00', concept: 'Traslado sintético' } });
    assert.equal(transfer.proposal.execution, 'confirm');
    const total = await accountBalance(f.store, account.id) + await accountBalance(f.store, destination.id);
    await assert.rejects(() => executeAssistantProposal(f.store, f.session, { ...executeInput(transfer.proposal), confirmation: null }), error => error.status === 403);
    assert.equal(await accountBalance(f.store, destination.id), 0);
    const [moved, concurrent] = await Promise.all([execute(f, transfer.proposal), execute(f, transfer.proposal)]);
    assert.deepEqual(concurrent, moved);
    assert.equal(moved.result.entries.length, 2);
    assert.equal(moved.result.entries[0].amountMinor + moved.result.entries[1].amountMinor, 0);
    assert.equal(await accountBalance(f.store, account.id) + await accountBalance(f.store, destination.id), total);
    assert.deepEqual(await execute(f, transfer.proposal), moved);
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('cash_entries')} WHERE transfer_id=?`, [moved.result.transferId])).n), 2);
  });
  await t.test('financial values without literal or factual origin are asked rather than invented; explicit unknown is not zero', async t => {
    const f = await fixture(t, factory, { basics: true }), { account, year, a } = f.business;
    const unproven = await proposal(f, { target: 'business-action:income', message: 'Quiero registrar un ingreso; todavía no tengo el importe ni la fecha.', patch: { accountId: account.id, amountMinor: 12345, effectiveOn: `${year}-09-10`, concept: 'owner_funding' } });
    assert.equal(unproven.proposal.execution, 'prefill');
    assert.ok(unproven.proposal.missingFields.includes('amountMinor'));
    assert.ok(unproven.proposal.missingFields.includes('effectiveOn'));
    assert.equal(Object.hasOwn(unproven.proposal.patch, 'amountMinor'), false);
    await assert.rejects(() => execute(f, unproven.proposal), error => error.status === 403);
    const order = await f.store.saveOrder(businessOrderInput(a, { year }), f.session.user.id);
    const shipment = await saveShipment(f.store, { requestId: randomUUID(), orderId: order.id, carrier: 'Transportadora sin costo', tracking: 'SIN-COSTO-QA' }, f.session.user.id);
    const unknown = await proposal(f, { target: 'business-action:expense', patch: { category: 'shipping_out', amountMinor: null, shipmentId: shipment.id, orderId: order.id, concept: 'Costo aún desconocido' } });
    const result = await execute(f, unknown.proposal);
    assert.equal(result.result.amountMinor, null);
    assert.equal(result.result.costStatus, 'unknown');
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('expenses')} WHERE shipment_id=?`, [shipment.id])).n), 0);
    const freshness = await proposal(f, { target: 'shipment-event', entityId: shipment.id, message: 'Revisa el hecho sin inventar una fecha de corte.', patch: { detail: 'Hecho pendiente de fecha', sourceAsOf: `${year}-09-10T12:00:00.000Z` } });
    assert.ok(freshness.proposal.missingFields.includes('sourceAsOf'));
    assert.equal(Object.hasOwn(freshness.proposal.patch, 'sourceAsOf'), false);
    const person = f.business.person;
    const agreement = await proposal(f, { target: 'settings:person', entityId: person.id, recordVersion: person.version, values: person, message: 'Revisa el convenio sin inventar las vigencias.', patch: { name: person.name, salaryAgreements: person.salaryAgreements.map(row => ({ ...row, effectiveFrom: `${year}-10-01`, effectiveTo: `${year}-10-31` })) } });
    assert.ok(agreement.proposal.missingFields.includes('salaryAgreements'));
    assert.equal(Object.hasOwn(agreement.proposal.patch, 'salaryAgreements'), false);
  });
  await t.test('numeric-only source spans cannot hide foreign currency; current and resumed inputs require COP', async t => {
    const f = await fixture(t, factory, { basics: true }), { account, year } = f.business, date = `${year}-09-10`;
    const balance = await accountBalance(f.store, account.id);
    for (const message of [
      `Registra un ingreso de 1.000 USD el ${date}.`,
      `Registra un ingreso de USD 1.000 el ${date}.`,
      `Todo está en USD. Registra un ingreso de 1.000 el ${date}.`,
      `La moneda será USD. Registra un ingreso de 1.000 el ${date}.`,
      `La moneda será ZZZ. Registra un ingreso de 1.000 el ${date}.`,
      `Registra un ingreso de 1.000 ZZZ el ${date}.`,
      `Registra un ingreso de USD$ 1.000 el ${date}.`,
      `Registra un ingreso de 1.000 EUR el ${date}.`,
      `Registra un ingreso de 1.000 MXN el ${date}.`,
      `Registra un ingreso de 1.000 dólares el ${date}.`,
      `Registra un ingreso de US$ 1.000 el ${date}.`,
      `Registra un ingreso de 1.000 € el ${date}.`,
    ]) {
      const prepared = await proposal(f, { target: 'business-action:income', message, patch: { accountId: account.id, effectiveOn: date, amountMinor: '1.000', concept: 'owner_funding' }, sourceRefs: turnId => [{ field: 'amountMinor', turnId, start: message.indexOf('1.000'), end: message.indexOf('1.000') + 5 }, { field: 'effectiveOn', turnId, start: message.indexOf(date), end: message.indexOf(date) + date.length }] });
      assert.equal(prepared.proposal.execution, 'prefill');
      assert.ok(prepared.proposal.missingFields.includes('amountMinor'));
      assert.equal(Object.hasOwn(prepared.proposal.patch, 'amountMinor'), false);
      await assert.rejects(() => execute(f, prepared.proposal), error => error.status === 403);
    }
    const resumed = await pendingOrder(f, { currency: 'USD' });
    assert.ok(resumed.proposal.missingFields.includes('items'));
    assert.equal(Object.hasOwn(resumed.proposal.patch, 'items'), false);
    assert.equal(resumed.proposal.patch.placedOn, resumed.patch.placedOn);
    await assert.rejects(() => execute(f, resumed.proposal), error => error.status === 403);
    assert.equal(await accountBalance(f.store, account.id), balance);
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('orders')}`)).n), 0);
  });
  await t.test('explicit COP decimal and zero literals preserve their exact monetary meaning', async t => {
    const f = await fixture(t, factory, { basics: true }), { account, person, year } = f.business, date = `${year}-09-10`;
    const sourceRefs = (moneyField, amount) => (turnId, message) => {
      const start = message.indexOf(amount, message.indexOf('$') + 1);
      return [{ field: moneyField, turnId, start, end: start + amount.length }, { field: moneyField === 'amountMinor' ? 'effectiveOn' : 'openingOn', turnId, start: message.indexOf(date), end: message.indexOf(date) + date.length }];
    };
    const income = await proposal(f, { target: 'business-action:income', message: `Registra un ingreso de $ 1.234,56 COP el ${date}.`, patch: { accountId: account.id, amountMinor: '1.234,56', effectiveOn: date, concept: 'owner_funding' }, sourceRefs: sourceRefs('amountMinor', '1.234,56') });
    assert.deepEqual(income.proposal.missingFields, []);
    assert.equal(income.proposal.execution, 'confirm');
    assert.deepEqual(income.proposal.moneyCurrency, { before: 'COP', after: 'COP' });
    const before = await accountBalance(f.store, account.id), received = await execute(f, income.proposal);
    assert.equal(received.result.amountMinor, 123456);
    assert.equal(await accountBalance(f.store, account.id), before + 123456);
    const pesos = await proposal(f, { target: 'business-action:income', message: `Registra un ingreso el ${date} por $ 1.000.`, patch: { accountId: account.id, amountMinor: '1.000', effectiveOn: date, concept: 'owner_funding' }, sourceRefs: sourceRefs('amountMinor', '1.000') });
    assert.deepEqual(pesos.proposal.missingFields, []);
    assert.equal((await execute(f, pesos.proposal)).result.amountMinor, 100000);
    assert.equal(await accountBalance(f.store, account.id), before + 123456 + 100000);
    const opening = await proposal(f, { target: 'business-action:account-save', values:{type:'cash'}, message: `Abre Caja cero COP QA, responsable ${person.name}, con saldo $ 0 COP el ${date}.`, patch: { name: 'Caja cero COP QA', responsibleId: person.id, openingBalanceMinor: '0', openingOn: date }, sourceRefs: sourceRefs('openingBalanceMinor', '0') });
    assert.deepEqual(opening.proposal.missingFields, []);
    const created = await execute(f, opening.proposal);
    assert.equal(created.result.balanceMinor, 0);
    assert.equal(created.result.minimumMinor, null);
  });
  await t.test('USD draft budgets retain their actual unit and connection switches disclose native monetary resets before commit', async t => {
    const f = await fixture(t, factory), usd = await campaignConnection(f, 'USD'), cop = await campaignConnection(f, 'COP');
    const original = await campaign(f, usd), message = 'Cambia el presupuesto a 100 USD.';
    for (const text of ['Cambia el presupuesto a 100 COP.', 'Cambia el presupuesto a $ 100.']) {
      const rejected = await proposal(f, { target: 'campaign-draft', entityId: original.id, patch: { budgetMinor: '100' }, message: text, sourceRefs: turnId => [{ field: 'budgetMinor', turnId, start: text.indexOf('100'), end: text.indexOf('100') + 3 }] });
      assert.ok(rejected.proposal.missingFields.includes('budgetMinor'));
      assert.equal(Object.hasOwn(rejected.proposal.patch, 'budgetMinor'), false);
      await assert.rejects(() => execute(f, rejected.proposal), error => error.status === 403);
    }
    const prepared = await proposal(f, { target: 'campaign-draft', entityId: original.id, patch: { budgetMinor: '100' }, message, sourceRefs: turnId => [{ field: 'budgetMinor', turnId, start: message.indexOf('100'), end: message.indexOf('100') + 3 }] });
    assert.deepEqual(prepared.proposal.missingFields, []);
    assert.equal(prepared.proposal.execution, 'confirm');
    assert.deepEqual(prepared.proposal.moneyCurrency, { before: 'USD', after: 'USD' });
    assert.equal(prepared.proposal.diff.find(item => item.field === 'budgetMinor').after, 10000);
    assert.equal((await getSocialCampaign(f.store, original.id)).budgetMinor, 5000);
    await execute(f, prepared.proposal);
    const current = await getSocialCampaign(f.store, original.id);
    assert.equal(current.currency, 'USD');
    assert.equal(current.budgetMinor, 10000);
    const change = await proposal(f, { target: 'campaign-draft', entityId: current.id, patch: { connectionId: cop } });
    assert.deepEqual(change.proposal.moneyCurrency, { before: 'USD', after: 'COP' });
    assert.ok(change.proposal.humanDiff.some(item => item.field === 'budgetMinor' && item.before === 10000 && item.after === 0));
    assert.ok(change.proposal.humanDiff.some(item => item.field === 'targetCostMinor' && item.before === 200 && item.after === null));
    const reviewed = await reviseAssistantProposal(f.store, f.session, { proposalId: change.proposal.id, version: change.proposal.version, requestId: randomUUID(), formBinding: change.binding, payload: { id: current.id, version: current.version, connectionId: cop, budgetMinor: 10000, targetCostMinor: 200 } });
    assert.deepEqual(reviewed.proposal.moneyCurrency, { before: 'USD', after: 'COP' });
    assert.ok(reviewed.proposal.diff.some(item => item.field === 'budgetMinor' && item.before === 10000 && item.after === 0));
    assert.ok([...reviewed.proposal.diff, ...reviewed.proposal.humanDiff].some(item => item.field === 'targetCostMinor' && item.after === null));
    assert.equal((await getSocialCampaign(f.store, current.id)).currency, 'USD');
    await execute(f, reviewed.proposal);
    const switched = await getSocialCampaign(f.store, current.id);
    assert.equal(switched.currency, 'COP');
    assert.equal(switched.budgetMinor, 0);
    assert.equal(switched.targetCostMinor, null);
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('social_operations')}`)).n), 0);
  });
  await t.test('generic minor-unit evidence only copies between verified matching campaign currencies', async t => {
    const f = await fixture(t, factory), usd = await campaignConnection(f, 'USD'), cop = await campaignConnection(f, 'COP');
    const source = await campaign(f, usd), target = await campaign(f, usd, { budgetMinor: 2500 });
    const copTarget = await campaign(f, cop, { budgetMinor: 2500 }), unknownSource = await campaign(f, null);
    const unknownTarget = await campaign(f, null, { budgetMinor: 2500 });
    for (const [from, to, accepted] of [[source, target, true], [source, copTarget, false], [unknownSource, copTarget, false], [source, unknownTarget, false]]) {
      const fact = createAssistantEvidence({ domain: 'advertising', entityId: from.id, recordVersion: from.version, field: 'budgetMinor', label: 'Presupuesto', value: from.budgetMinor, unit: 'minor', href: { section: 'advertising', tab: 'campaigns', record: from.id } });
      const prepared = await proposal(f, { target: 'campaign-draft', entityId: to.id, patch: { budgetMinor: from.budgetMinor }, message: `Copia el presupuesto de ${from.name} a ${to.name}.`, evidence: [fact], sourceRefs: [{ field: 'budgetMinor', evidenceId: fact.id, sourceField: 'budgetMinor' }] });
      if (accepted) {
        assert.deepEqual(prepared.proposal.missingFields, []);
        assert.deepEqual(prepared.proposal.moneyCurrency, { before: 'USD', after: 'USD' });
        await execute(f, prepared.proposal);
        assert.equal((await getSocialCampaign(f.store, to.id)).budgetMinor, from.budgetMinor);
      } else {
        assert.ok(prepared.proposal.missingFields.includes('budgetMinor'));
        assert.equal(Object.hasOwn(prepared.proposal.patch, 'budgetMinor'), false);
        await assert.rejects(() => execute(f, prepared.proposal), error => error.status === 403);
        assert.equal((await getSocialCampaign(f.store, to.id)).budgetMinor, to.budgetMinor);
      }
    }
  });
  await t.test('a connection currency change cannot hide monetary resets behind an otherwise autonomous caption edit', async t => {
    const f = await fixture(t, factory), connectionId = await campaignConnection(f, 'USD'), original = await campaign(f, connectionId);
    const row = await f.store.db.get(`SELECT data FROM ${f.store.t('social_connections')} WHERE id=?`, [connectionId]);
    await f.store.db.run(`UPDATE ${f.store.t('social_connections')} SET data=?,version=version+1 WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), currency: 'COP' }), connectionId]);
    const caption = 'Texto local autorizado';
    const prepared = await proposal(f, { target: 'campaign-draft', entityId: original.id, recordVersion: original.version, values: original, patch: { caption }, message: `Actualiza el texto: «${caption}»`, literal: true });
    assert.equal(prepared.proposal.execution, 'confirm');
    assert.deepEqual(prepared.proposal.moneyCurrency, { before: 'USD', after: 'COP' });
    assert.ok(prepared.proposal.humanDiff.some(item => item.field === 'budgetMinor' && item.after === 0));
    assert.equal((await getSocialCampaign(f.store, original.id)).budgetMinor, 5000);
    await execute(f, prepared.proposal);
    const actual = await getSocialCampaign(f.store, original.id);
    assert.equal(actual.currency, 'COP');
    assert.equal(actual.budgetMinor, 0);
    assert.equal(actual.targetCostMinor, null);
    assert.equal(actual.caption, caption);
  });
  await t.test('exact copied draft text is revalidated and duplicate entity labels never authorize an automatic choice', async t => {
    const f = await fixture(t, factory), target = await product(f), source = await product(f, { title: 'Fuente inequívoca', description: 'Texto registrado para copiar' });
    const fact = recordEvidence(source, 'products', 'description');
    const copied = await proposal(f, { target: 'record:products', entityId: target.id, patch: { description: source.description }, message: `Actualiza la descripción de ${target.title}: copia Descripción de Fuente inequívoca`, evidence: [recordEvidence(target), fact], sourceRefs: [{ field: 'description', evidenceId: fact.id, sourceField: 'description' }] });
    assert.equal(copied.proposal.execution, 'automatic');
    await f.store.save('products', { ...source, description: 'Fuente cambiada' }, source.id, source.version, f.session.user.id);
    await assert.rejects(() => execute(f, copied.proposal), error => error.status === 409);
    assert.equal((await f.store.get('products', target.id)).description, target.description);
    const currentSource = await f.store.get('products', source.id), currentFact = recordEvidence(currentSource, 'products', 'description');
    const refreshedCopy = await proposal(f, { target: 'record:products', entityId: target.id, patch: { description: currentSource.description }, message: `Actualiza la descripción de ${target.title}: copia Descripción de ${currentSource.title}`, evidence: [recordEvidence(target), currentFact], sourceRefs: [{ field: 'description', evidenceId: currentFact.id, sourceField: 'description' }] });
    assert.equal(refreshedCopy.proposal.execution, 'automatic');
    const committedCopy = await execute(f, refreshedCopy.proposal);
    assert.equal(committedCopy.result.description, currentSource.description);
    await product(f, { title: target.title });
    const ambiguous = await proposal(f, { target: 'record:products', entityId: target.id, patch: { description: 'Texto explícito' }, message: `Actualiza la descripción de ${target.title}: «Texto explícito»`, literal: true, evidence: [recordEvidence(committedCopy.result)] });
    assert.equal(ambiguous.proposal.execution, 'confirm');
  });
  await t.test('cash and payroll previews are real reads and become stale after a financial revision', async t => {
    const f = await fixture(t, factory, { basics: true }), { person, year, account } = f.business;
    const cash = await saveAccount(f.store, { requestId: randomUUID(), name: 'Caja sintética', type: 'cash', responsibleId: person.id, openingOn: `${year}-09-01`, openingBalanceMinor: 100000 }, f.session.user.id);
    const close = await proposal(f, { target: 'business-action:cash-close', entityId: cash.id, recordVersion: cash.version, patch: { accountId: cash.id, closingOn: `${year}-09-20`, countedMinor: 100000 } });
    const preview = (await persisted(f, close.proposal)).data.preview;
    assert.deepEqual(close.proposal.missingFields, []);
    assert.ok(preview, 'complete explicit input produces the real cash preview');
    assert.equal(preview.result.expectedMinor, 100000);
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('cash_closings')}`)).n), 0);
    await recordIncome(f.store, { requestId: randomUUID(), accountId: cash.id, effectiveOn: `${year}-09-19`, amountMinor: 100, concept: 'owner_funding' }, f.session.user.id);
    await assert.rejects(() => execute(f, close.proposal), error => error.status === 409);
    assert.equal((await persisted(f, close.proposal)).state, 'stale');
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('cash_closings')}`)).n), 0);
    const payroll = await proposal(f, { target: 'business-action:payroll-confirm', patch: { personId: person.id, startOn: `${year}-09-01`, endOnExclusive: `${year}-10-01`, bonusMinor: 0, discountMinor: 0 } });
    const payrollPreview = (await persisted(f, payroll.proposal)).data.preview;
    assert.deepEqual(payroll.proposal.missingFields, []);
    assert.ok(payrollPreview, 'complete explicit input produces the real payroll preview');
    assert.deepEqual(payrollPreview.result, await preparePayroll(f.store, payrollPreview.inputs, f.session.user.id));
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('payroll_periods')}`)).n), 0);
    await recordExpense(f.store, { requestId: randomUUID(), category: 'operating', personId: person.id, amountMinor: 500, incurredOn: `${year}-09-15`, concept: 'Hecho posterior' }, f.session.user.id);
    await assert.rejects(() => execute(f, payroll.proposal), error => error.status === 409);
    assert.equal((await persisted(f, payroll.proposal)).state, 'stale');
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('payroll_periods')}`)).n), 0);
    assert.equal(await accountBalance(f.store, account.id), 10000000);
  });
  await t.test('all ordinary financial command families retain their original response contracts', async t => {
    const f = await fixture(t, factory, { basics: true }), { a, person, account, year } = f.business;
    let order = await f.store.saveOrder(businessOrderInput(a, { year }), f.session.user.id);
    const collection = await command(f, 'collection', { orderId: order.id, amountMinor: 100000, occurredOn: `${year}-09-02`, holder: 'business', accountId: account.id, method: 'Transferencia', reference: 'Cobro sintético' }, { entityId: order.id, recordVersion: order.version });
    assert.equal(collection.result.order.id, order.id);
    order = collection.result.order;
    const refund = await command(f, 'refund', { orderId: order.id, amountMinor: 10000, occurredOn: `${year}-09-03`, holder: 'business', accountId: account.id, method: 'Transferencia', reference: 'Reembolso sintético', reason: 'Corrección sintética' }, { entityId: order.id, recordVersion: order.version });
    order = refund.result.order;
    const costs = await command(f, 'complete-costs', { orderId: order.id, reason: 'Costo explícito sintético', lineCosts: [{ lineId: order.items[0].lineId, unitCostMinor: 2400000, components: [] }] }, { entityId: order.id, recordVersion: order.version });
    assert.equal(costs.result.items[0].unitCostMinor, 2400000);
    order = costs.result;
    const returned = await command(f, 'return', { orderId: order.id, occurredOn: `${year}-09-04`, reason: 'Unidad devuelta sintética', shippingCreditMinor: 0, lines: [{ lineId: order.items[0].lineId, quantity: 1, condition: 'recoverable' }] }, { entityId: order.id, recordVersion: order.version });
    assert.equal(returned.result.order.id, order.id);
    const expense = await command(f, 'expense', { category: 'operating', amountMinor: 10000, incurredOn: `${year}-09-05`, concept: 'Gasto sintético' });
    const paid = await command(f, 'pay-expense', { expenseId: expense.result.id, amountMinor: 10000, accountId: account.id, effectiveOn: `${year}-09-06` }, { entityId: expense.result.id, recordVersion: expense.result.version });
    assert.equal(paid.result.expense.outstandingMinor, 0);
    const changedExpense = await command(f, 'expense', { expenseId: expense.result.id, category: 'operating', amountMinor: 5000, incurredOn: `${year}-09-05`, concept: 'Gasto sintético', reason: 'Corrección explícita' }, { entityId: expense.result.id, recordVersion: expense.result.version });
    assert.equal(changedExpense.result.creditMinor, 5000);
    const recovery = await command(f, 'expense-recovery', { expenseId: expense.result.id, amountMinor: 5000, accountId: account.id, effectiveOn: `${year}-09-07`, reason: 'Sobrepago recuperado' }, { entityId: expense.result.id, recordVersion: changedExpense.result.version });
    assert.equal(recovery.result.expense.creditMinor, 0);
    const advance = await command(f, 'advance', { personId: person.id, accountId: account.id, effectiveOn: `${year}-09-08`, amountMinor: 1000, concept: 'Anticipo sintético' });
    assert.equal(advance.result.kind, 'advance');
    const reversed = await command(f, 'document-reverse', { documentType: 'advance', documentId: advance.result.id, effectiveOn: `${year}-09-09`, reason: 'Reversión sintética' });
    assert.ok(reversed.result.id);
    const income = await command(f, 'income', { accountId: account.id, effectiveOn: `${year}-09-10`, amountMinor: 1000, concept: 'other_non_sale' });
    const reverse = await command(f, 'cash-reverse', { cashEntryId: income.result.id, effectiveOn: `${year}-09-11`, reason: 'Ingreso duplicado sintético' }, { entityId: income.result.id });
    assert.equal(reverse.result.amountMinor, -1000);
    const cash = await saveAccount(f.store, { requestId: randomUUID(), name: 'Caja cierre', type: 'cash', responsibleId: person.id, openingOn: `${year}-09-01`, openingBalanceMinor: 0 }, f.session.user.id);
    const closed = await command(f, 'cash-close', { accountId: cash.id, closingOn: `${year}-09-12`, countedMinor: 0 }, { entityId: cash.id, recordVersion: cash.version });
    assert.equal(closed.result.state, 'closed');
    const reopened = await command(f, 'cash-reopen', { closingId: closed.result.id, reason: 'Revisión sintética' }, { entityId: closed.result.id, recordVersion: closed.result.version });
    assert.equal(reopened.result.state, 'reopened');
    const payroll = await command(f, 'payroll-confirm', { personId: person.id, startOn: `${year}-09-01`, endOnExclusive: `${year}-10-01`, bonusMinor: 0, discountMinor: 0 });
    assert.ok(payroll.result.id);
    const payrollPaid = await command(f, 'payroll-pay', { payrollId: payroll.result.id, accountId: account.id, effectiveOn: `${year}-10-01`, amountMinor: payroll.result.amountToPayMinor }, { entityId: payroll.result.id, recordVersion: payroll.result.version });
    assert.equal(payrollPaid.result.state, 'paid');
  });
  await t.test('settlement declarations/receipts, orphan shipment linking and legacy resolution preserve original facts', async t => {
    const f = await fixture(t, factory), business = await createBusinessFixture(f.store, { actorId: f.session.user.id });
    const { year, account, a, settlement } = business;
    const declaration = await command(f, 'settlement-save', { settlementId: settlement.id, reportedOn: `${year}-09-06`, reason: 'Corregir fecha declarada' }, { entityId: settlement.id, recordVersion: settlement.version });
    assert.equal(declaration.result.reportedOn, `${year}-09-06`);
    const receipt = await command(f, 'settlement-confirm', { settlementId: declaration.result.id, receivedOn: `${year}-09-07`, accountId: account.id, externalKey: 'RECIBO-ASISTIDO-QA', lines: declaration.result.lines }, { entityId: declaration.result.id, recordVersion: declaration.result.version });
    assert.equal(receipt.result.settlement.state, 'confirmed');
    assert.equal(receipt.result.receipt.netMinor, settlement.netMinor);
    assert.equal(receipt.receipt.entityId, receipt.result.receipt.id);
    const order = await f.store.saveOrder(businessOrderInput(a, { year }), f.session.user.id);
    const orphan = await saveShipment(f.store, { requestId: randomUUID(), carrier: 'Transportadora huérfana QA', tracking: 'HUERFANA-QA-1' }, f.session.user.id);
    const linked = await command(f, 'link-shipment', { shipmentId: orphan.id, orderId: order.id, reason: 'Pedido verificado', assignments: order.items.map(line => ({ lineId: line.lineId, quantity: line.quantity })) }, { entityId: orphan.id, recordVersion: orphan.version });
    assert.equal(linked.result.orderId, order.id);
    assert.equal(linked.proposal.open.owner, 'order-editor');
    assert.equal(linked.proposal.open.refs.order.id, order.id);
    assert.equal(linked.proposal.open.refs.shipment.id, orphan.id);
    const legacy = await f.store.saveOrder(businessOrderInput(a, { year }), f.session.user.id);
    await locked(f.store, async tx => {
      const row = await tx.db.get(`SELECT data FROM ${tx.t('orders')} WHERE id=?`, [legacy.id]);
      await tx.db.run(`UPDATE ${tx.t('orders')} SET data=?,version=version+1 WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), legacyFinancialReview: { required: true, state: 'pending', reason: 'legacy_payment_unreconciled' } }), legacy.id]);
      await tx.db.run(`INSERT INTO ${tx.t('order_collections')}(id,order_id,shipment_id,kind,holder,amount_minor,occurred_on,cash_entry_id,reversal_of,external_key,recorded_at,data) VALUES(?,?,NULL,'receipt','legacy',10000,?,NULL,NULL,?,?,?)`, [randomUUID(), legacy.id, `${year}-09-02`, `legacy:${legacy.id}:payment`, new Date().toISOString(), JSON.stringify({ source: 'legacy', requiresReconciliation: true })]);
    });
    const historical = await f.store.order(legacy.id), before = await accountBalance(f.store, account.id);
    const resolved = await command(f, 'resolve-legacy-payment', { orderId: legacy.id, mode: 'opening_balance', reason: 'Incluido en apertura sintética' }, { entityId: legacy.id, recordVersion: historical.version });
    assert.equal(resolved.result.order.paymentSummary.legacyReview, false);
    assert.equal(await accountBalance(f.store, account.id), before);
    assert.equal(resolved.result.documents[0].cashEntryId, null);
  });
  await t.test('account controls, policy agreements and alert configuration are saved only after human review', async t => {
    const f = await fixture(t, factory, { basics: true }), { person, year, account } = f.business;
    const prepared = await proposal(f, { target: 'business-action:account-save', patch: { name: 'Cuenta humana QA', responsibleId: person.id, openingOn: `${year}-09-01`, openingBalanceMinor: 0 } });
    assert.ok(prepared.proposal.missingFields.includes('type'));
    const payload = { version: 1, name: 'Cuenta humana QA', type: 'cash', responsibleId: person.id, openingOn: `${year}-09-01`, openingBalanceMinor: 0, minimumMinor: null, closingEnabled: false, toleranceMinor: 0, active: true };
    const reviewed = await reviseAssistantProposal(f.store, f.session, { proposalId: prepared.proposal.id, version: prepared.proposal.version, requestId: randomUUID(), formBinding: prepared.binding, payload, humanAcknowledgements: serializeAssistantHumanAcknowledgements('business-action:account-save', payload) });
    const saved = await execute(f, reviewed.proposal);
    assert.equal(saved.result.balanceMinor, 0);
    assert.equal(saved.result.minimumMinor, null);
    const platform = await proposal(f, { target: 'settings:platform', patch: { name: 'Plataforma asistida QA' } });
    const savedPlatform = await execute(f, platform.proposal);
    const source = await proposal(f, { target: 'settings:source', values: { name: '', platformId: savedPlatform.result.id }, patch: { name: 'Cuenta de plataforma QA' } });
    assert.equal(source.proposal.open.refs.platform.id, savedPlatform.result.id);
    const savedSource = await execute(f, source.proposal);
    assert.equal(savedSource.result.platformId, savedPlatform.result.id);
    const current = await getBusinessSettings(f.store);
    const policy = { effectiveOn: `${year}-10-01`, saleRecognition: 'confirmed', commission: { enabled: false, mode: 'percent', rateBps: 0, fixedMinor: 0, basis: 'net_products', earnWhen: 'business_received' }, shippingExpenseDate: 'dispatch_date', returnExpenseDate: 'charge_date', platformFeeExpenseDate: 'charge_date', reason: 'Nueva vigencia explícita' };
    const proposedPolicy = await proposal(f, { target: 'settings:policy', patch: policy });
    const policyPayload = { version: current.version, rulesVersions: [...current.rulesVersions, { ...policy, id: randomUUID() }], setupPolicyConfirmed: true, reason: policy.reason };
    const policyRevision = await reviseAssistantProposal(f.store, f.session, { proposalId: proposedPolicy.proposal.id, version: proposedPolicy.proposal.version, requestId: randomUUID(), formBinding: proposedPolicy.binding, payload: policyPayload, humanAcknowledgements: serializeAssistantHumanAcknowledgements('settings:policy', policyPayload) });
    const policySaved = await execute(f, policyRevision.proposal);
    assert.equal(policySaved.result.rulesVersions.at(-1).effectiveOn, policy.effectiveOn);
    assert.deepEqual(policySaved.result.rulesVersions.slice(0, -1), current.rulesVersions);
    const rule = await f.store.db.get(`SELECT id FROM ${f.store.t('alert_rules')} WHERE type='stock_low'`);
    const configured = await proposal(f, { target: 'settings:alert-rule', entityId: rule.id, patch: { reminderHours: 48, reason: 'Aviso verificado' } });
    assert.equal((await execute(f, configured.proposal)).result.reminderHours, 48);
    const preferences = await proposal(f, { target: 'settings:preferences', patch: { reportGenerationTime: '07:30', reason: 'Horario explícito' } });
    assert.equal((await execute(f, preferences.proposal)).result.reportGenerationTime, '07:30');
    const now = new Date().toISOString(), alertId = randomUUID();
    await f.store.db.run(`INSERT INTO ${f.store.t('alerts')}(id,rule_id,entity_type,entity_id,episode,state,severity,first_seen_at,last_seen_at,responsible_id,version,created_at,updated_at,data) VALUES(?,?,?,?,1,'open','warning',?,?,NULL,1,?,?,?)`, [alertId, rule.id, 'product', f.business.a.id, now, now, now, now, JSON.stringify({ title: 'Aviso sintético', reason: 'Dato de prueba' })]);
    const alert = await proposal(f, { target: 'settings:alert', entityId: alertId, patch: { responsibleId: person.id, reason: 'Responsable explícito' } });
    assert.equal((await execute(f, alert.proposal)).result.responsibleId, person.id);
    assert.equal(await accountBalance(f.store, account.id), 10000000);
  });
  await t.test('new financial serializers may carry contextual version one without authorizing any existing-record overwrite', async t => {
    const f = await fixture(t, factory, { basics: true }), { account, year } = f.business;
    const createPayload = { version: 1, category: 'operating', amountMinor: 10000, incurredOn: `${year}-09-08`, concept: 'Gasto humano explícito', supplier: '', reason: '' };
    const prepared = await proposal(f, { target: 'business-action:expense', values: { ...createPayload, concept: '' }, patch: { concept: createPayload.concept } });
    assert.equal(prepared.proposal.entityId, null);
    assert.equal(prepared.proposal.recordVersion, null);
    const revised = await reviseAssistantProposal(f.store, f.session, { proposalId: prepared.proposal.id, version: prepared.proposal.version, requestId: randomUUID(), formBinding: prepared.binding, payload: createPayload });
    const created = await execute(f, revised.proposal);
    assert.equal(created.result.concept, createPayload.concept);
    assert.equal(created.result.amountMinor, 10000);
    assert.equal(created.result.version, 1);
    const edit = await proposal(f, { target: 'business-action:expense', entityId: created.result.id, patch: { concept: 'Concepto corregido', reason: 'Corrección humana' } });
    const editPayload = (await persisted(f, edit.proposal)).data.payload;
    await assert.rejects(() => reviseAssistantProposal(f.store, f.session, { proposalId: edit.proposal.id, version: edit.proposal.version, requestId: randomUUID(), formBinding: edit.binding, payload: { ...editPayload, version: 0 } }), error => error.status === 409);
    const accountEdit = await proposal(f, { target: 'business-action:account-save', entityId: account.id, patch: { name: 'Cuenta con nombre revisado' } });
    const accountPayload = (await persisted(f, accountEdit.proposal)).data.payload;
    await assert.rejects(() => reviseAssistantProposal(f.store, f.session, { proposalId: accountEdit.proposal.id, version: accountEdit.proposal.version, requestId: randomUUID(), formBinding: accountEdit.binding, payload: { ...accountPayload, version: 0 } }), error => error.status === 409);
    assert.equal((await f.store.db.get(`SELECT version FROM ${f.store.t('expenses')} WHERE id=?`, [created.result.id])).version, 1);
    assert.equal((await f.store.db.get(`SELECT version FROM ${f.store.t('cash_accounts')} WHERE id=?`, [account.id])).version, account.version);
  });
  await t.test('content deletion is explicitly described, always confirmed, and idempotent', async t => {
    const f = await fixture(t, factory), row = await f.store.save('faqs', { ...emptyRecord('faqs'), title: 'FAQ eliminable QA', slug: 'faq-eliminable-qa', answer: 'Respuesta sintética' }, null, null, f.session.user.id);
    const prepared = await proposal(f, { target: 'record:faqs', entityId: row.id, patch: {}, intent: 'delete', message: `Elimina ${row.title}` });
    assert.equal(prepared.proposal.execution, 'confirm');
    assert.ok(prepared.proposal.humanDiff.some(item => item.field === 'operation'));
    await assert.rejects(() => executeAssistantProposal(f.store, f.session, { ...executeInput(prepared.proposal), confirmation: null }), error => error.status === 403);
    assert.ok(await f.store.get('faqs', row.id));
    const result = await execute(f, prepared.proposal);
    assert.deepEqual(result.result, { ok: true });
    assert.equal(result.receipt.operation, 'remove');
    assert.equal(await f.store.get('faqs', row.id), null);
    assert.deepEqual(await execute(f, prepared.proposal), result);
  });
  await t.test('resources, storefront, shipment forms and local campaign drafts execute through their real handlers', async t => {
    const f = await fixture(t, factory, { basics: true }), { a, person, account, year } = f.business;
    const created = await proposal(f, { target: 'settings:person', patch: { name: 'Persona nueva sintética' } });
    const savedPerson = await execute(f, created.proposal);
    assert.equal(savedPerson.result.name, 'Persona nueva sintética');
    assert.equal(savedPerson.result.active, true);
    const name = await proposal(f, { target: 'settings:person', entityId: person.id, patch: { name: 'Responsable corregido' } });
    assert.equal((await execute(f, name.proposal)).result.name, 'Responsable corregido');
    const settings = await f.store.settings();
    const storefront = await proposal(f, { target: 'storefront-settings', patch: { tagline: 'Texto sintético de vitrina' } });
    assert.equal(storefront.proposal.execution, 'confirm');
    const updated = await execute(f, storefront.proposal);
    assert.equal(updated.result.tagline, 'Texto sintético de vitrina');
    assert.equal(updated.result.version, settings.version + 1);
    const order = await f.store.saveOrder(businessOrderInput(a, { year }), f.session.user.id);
    const shipment = await proposal(f, { target: 'shipment-create', entityId: order.id, patch: { carrier: 'Transportadora QA', tracking: '00000001', estimatedDeliveryOn: `${year}-09-04` } });
    assert.equal(shipment.proposal.open.owner, 'order-editor');
    assert.equal(shipment.proposal.open.refs.order.id, order.id);
    const savedShipment = await execute(f, shipment.proposal);
    assert.equal(savedShipment.result.orderId, order.id);
    const metadata = await proposal(f, { target: 'shipment-metadata', entityId: savedShipment.result.id, patch: { notes: 'Nota logística explícita' } });
    assert.equal(metadata.proposal.open.owner, 'shipments');
    const noted = await execute(f, metadata.proposal);
    assert.equal(noted.result.notes, 'Nota logística explícita');
    const event = await proposal(f, { target: 'shipment-event', entityId: noted.result.id, patch: { occurredOn: `${year}-09-02`, detail: 'Recogida confirmada por humano' } });
    assert.equal(event.proposal.execution, 'prefill');
    const input = { version: noted.result.version, status: 'collected', occurredOn: `${year}-09-02`, detail: 'Recogida confirmada por humano' };
    const revised = await reviseAssistantProposal(f.store, f.session, { proposalId: event.proposal.id, version: event.proposal.version, requestId: randomUUID(), formBinding: event.binding, payload: input, humanAcknowledgements: serializeAssistantHumanAcknowledgements('shipment-event', input) });
    const collected = await execute(f, revised.proposal);
    assert.equal(collected.result.status, 'collected');
    assert.equal((await getShipment(f.store, collected.result.id)).events.length, 1);
    const campaign = await saveSocialCampaign(f.store, { requestId: randomUUID(), name: 'Campaña borrador QA', mode: 'organic', objective: 'reach', platforms: [], caption: 'Texto anterior', headline: '' }, f.session.user.id);
    const caption = 'Texto local nuevo';
    const local = await proposal(f, { target: 'campaign-draft', entityId: campaign.id, recordVersion: campaign.version, values: { name: 'Campaña borrador QA', caption: 'Texto anterior', headline: '' }, patch: { caption }, message: `Actualiza el texto: «${caption}»`, literal: true });
    assert.equal(local.proposal.execution, 'automatic');
    const campaignResult = await execute(f, local.proposal);
    assert.deepEqual(Object.keys(campaignResult.result).sort(), ['id', 'state', 'version']);
    assert.equal(campaignResult.result.state, 'draft');
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('social_operations')}`)).n), 0);
    assert.equal(await accountBalance(f.store, account.id), 10000000);
  });
  await t.test('human campaign disclosure survives canonical revision, diff, payload hash and the original draft handler', async t => {
    const f = await fixture(t, factory);
    const draft = await saveSocialCampaign(f.store, { requestId: randomUUID(), name: 'Declaración humana QA', mode: 'organic', objective: 'reach', platforms: [], caption: 'Texto anterior', headline: '', aiDisclosure: false }, f.session.user.id);
    const prepared = await proposal(f, { target: 'campaign-draft', entityId: draft.id, patch: { caption: 'Texto corregido visible' } });
    const payload = { id: draft.id, version: draft.version, caption: 'Texto corregido visible', aiDisclosure: true };
    const reviewed = await reviseAssistantProposal(f.store, f.session, { proposalId: prepared.proposal.id, version: prepared.proposal.version, requestId: randomUUID(), formBinding: prepared.binding, payload, humanAcknowledgements: serializeAssistantHumanAcknowledgements('campaign-draft', payload) });
    assert.notEqual(reviewed.proposal.payloadHash, prepared.proposal.payloadHash);
    assert.ok(reviewed.proposal.humanDiff.some(change => change.field === 'aiDisclosure' && change.before === false && change.after === true));
    const committed = await execute(f, reviewed.proposal);
    assert.equal(committed.result.state, 'draft');
    const row = await f.store.db.get(`SELECT data FROM ${f.store.t('social_campaigns')} WHERE id=?`, [draft.id]);
    assert.equal(JSON.parse(row.data).aiDisclosure, true);
  });
  await t.test('human-only onboarding never prefills invented money or opening dates, but accepts exact COP inputs without executing', async t => {
    const f = await fixture(t, factory, { basics: true }), { account, year } = f.business, date = `${year}-09-10`;
    const balance = await accountBalance(f.store, account.id), accounts = Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('cash_accounts')}`)).n);
    const invented = await proposal(f, { target: 'onboarding:cash', message: 'Ayúdame con Caja de apertura QA; todavía no tengo importe ni fecha.', patch: { accountName: 'Caja de apertura QA', openingBalanceMinor: 123456, openingOn: date } });
    assert.equal(invented.proposal.execution, 'human-only');
    assert.equal(invented.proposal.patch.accountName, 'Caja de apertura QA');
    for (const field of ['openingBalanceMinor', 'openingOn']) {
      assert.ok(invented.proposal.missingFields.includes(field));
      assert.equal(Object.hasOwn(invented.proposal.patch, field), false);
    }
    await assert.rejects(() => execute(f, invented.proposal), error => error.status === 403);
    const message = `Completa Caja de apertura QA con saldo $ 1.234,56 COP y apertura ${date}.`;
    const supplied = await proposal(f, { target: 'onboarding:cash', message, patch: { accountName: 'Caja de apertura QA', openingBalanceMinor: '1.234,56', openingOn: date }, sourceRefs: turnId => [{ field: 'openingBalanceMinor', turnId, start: message.indexOf('1.234,56'), end: message.indexOf('1.234,56') + 8 }, { field: 'openingOn', turnId, start: message.indexOf(date), end: message.indexOf(date) + date.length }] });
    assert.equal(supplied.proposal.execution, 'human-only');
    assert.equal(supplied.proposal.patch.openingBalanceMinor, 123456);
    assert.equal(supplied.proposal.patch.openingOn, date);
    assert.equal(Object.hasOwn(supplied.proposal.patch, 'openingConfirmed'), false);
    await assert.rejects(() => execute(f, supplied.proposal), error => error.status === 403);
    assert.equal((await persisted(f, supplied.proposal)).data.executionResponse, undefined);
    assert.equal(await accountBalance(f.store, account.id), balance);
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('cash_accounts')}`)).n), accounts);
  });
  await t.test('cancelled origins, conflicting versions, human-only forms and secret patches cannot produce writes or fake receipts', async t => {
    const f = await fixture(t, factory), row = await product(f);
    const active = await proposal(f, { target: 'record:products', entityId: row.id, patch: { description: 'No se debe guardar' }, complete: false });
    await locked(f.store, tx => cancelAssistantTurn(tx, { userId: f.session.user.id, turnId: active.turn.turn.id }));
    await assert.rejects(() => execute(f, active.proposal), error => error.status === 409);
    const stale = await proposal(f, { target: 'record:products', entityId: row.id, patch: { description: 'Revisión antigua' } });
    await f.store.save('products', { ...row, title: 'Nombre posterior' }, row.id, row.version, f.session.user.id);
    await assert.rejects(() => execute(f, stale.proposal), error => error.status === 409);
    assert.equal((await persisted(f, stale.proposal)).state, 'stale');
    for (const [target, patch] of [['asset-metadata', { name: 'Nombre humano' }], ['advertising-result-action', { reason: 'Motivo visible' }], ['import-source-name', { name: 'Fuente propuesta' }], ['onboarding:product', { title: 'Producto de inicio' }]]) {
      const human = await proposal(f, { target, patch });
      assert.equal(human.proposal.execution, 'human-only');
      await assert.rejects(() => execute(f, human.proposal), error => error.status === 403);
      assert.equal((await persisted(f, human.proposal)).data.executionResponse, undefined);
    }
    await assert.rejects(() => proposal(f, { target: 'record:products', entityId: row.id, patch: { apiKey: 'secret-canary-never-saved' } }), error => error.status === 403);
    assert.equal((await f.store.get('products', row.id)).description, row.description);
  });
  await t.test('a receipt persistence failure rolls the entire business mutation back', async t => {
    const f = await fixture(t, factory), row = await product(f);
    const prepared = await proposal(f, { target: 'record:products', entityId: row.id, patch: { description: 'Texto que debe revertirse' } });
    // Corrupt only the disposable conversation projection: real receipt validation
    // must fail after the handler rather than accept an unrelated turn proposal.
    const turnRow = await f.store.db.get(`SELECT data FROM ${f.store.t('assistant_turns')} WHERE id=?`, [prepared.turn.turn.id]);
    const data = JSON.parse(turnRow.data);
    data.publicResult.configurationVersion = -1;
    await f.store.db.run(`UPDATE ${f.store.t('assistant_turns')} SET data=? WHERE id=?`, [JSON.stringify(data), prepared.turn.turn.id]);
    await assert.rejects(() => execute(f, prepared.proposal));
    assert.equal((await f.store.get('products', row.id)).description, row.description);
    assert.equal((await persisted(f, prepared.proposal)).state, 'prepared');
    assert.equal((await persisted(f, prepared.proposal)).data.executionResponse, undefined);
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('business_requests')} WHERE request_id=?`, [prepared.proposal.id])).n), 0);
  });
}
