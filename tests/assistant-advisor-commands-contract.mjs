import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAdmin, login } from '../lib/auth.mjs';
import { assistantProposalDTO, executeAssistantProposal, prepareAssistantChange } from '../lib/assistant/actions.mjs';
import { validateAssistantReceipt, validateProposalDTO } from '../lib/assistant/contracts.mjs';
import { createAssistantEvidence } from '../lib/assistant/evidence.mjs';
import { finishAssistantTurn, getAssistantProposal, getAssistantTurn, hashAssistantInput, reserveAssistantTurn } from '../lib/assistant/repository.mjs';
import { bumpRevision, insertRow } from '../lib/business/commands.mjs';
import { generateReportSnapshot, getReportCopyRunTx, processReportTurn } from '../lib/business/reports.mjs';
import { getSocialCampaign, saveSocialCampaign } from '../lib/business/social.mjs';

const password = 'advisor-command-synthetic-passphrase';
const locked = (store, operation) => store.transaction(async tx => { await tx.lockWrites(); return operation(tx); });
const status = code => error => error.status === code;
const count = async (store, table, where = '', bindings = []) => Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)} ${where}`, bindings)).n);
const revision = async store => Number((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`)).value);

async function authenticate(store, label) {
  const email = `advisor-command-${label}@example.test`;
  await createAdmin(store, email, password);
  const { user, csrf, token } = await login(store, email, password);
  return { user, csrf, sessionTokenHash: createHash('sha256').update(token).digest('hex') };
}
async function fixture(t, factory) {
  const store = await factory();
  t.after(() => store.close());
  const session = await authenticate(store, 'alice'), other = await authenticate(store, 'bob'), at = new Date().toISOString();
  await store.db.run(`INSERT INTO ${store.t('assistant_settings')}(id,version,enabled,data,api_key_ciphertext,api_key_iv,api_key_tag,actor_id,created_at,updated_at) VALUES(1,1,1,?,?,?,?,?,?,?)`, [
    JSON.stringify({ provider:'openai-compatible', baseUrl:'http://127.0.0.1:3339/v1', model:'advisor-command-fixture', allowPrivateNetwork:true, connectionStatus:'ready', verifiedAt:at }),
    'synthetic-ciphertext', 'synthetic-iv', 'synthetic-tag', session.user.id, at, at,
  ]);
  return { store, session, other };
}
async function prepare({ store, session }, { target, message, patch, view, entityId = null, selection = null, campaignSelection = null, evidence = [] }) {
  const requestId = randomUUID();
  const turn = await locked(store, tx => reserveAssistantTurn(tx, { userId:session.user.id, sessionTokenHash:session.sessionTokenHash,
    requestId, inputHash:hashAssistantInput({ requestId, message }), configurationVersion:1, data:{ message } }));
  const proposal = await prepareAssistantChange(store, session, { threadId:turn.threadId, turnId:turn.turn.id, target, entityId, patch,
    sourceRefs:evidence.map(item => item.id), formContext:{ view, selection, campaignSelection, evidence }, intent:target === 'campaign-duplicate' ? 'duplicate' : 'save' });
  await locked(store, tx => finishAssistantTurn(tx, { userId:session.user.id, turnId:turn.turn.id, data:{ message,
    publicResult:{ threadId:turn.threadId, threadVersion:turn.threadVersion, turnId:turn.turn.id, configurationVersion:1, topic:target === 'report-snapshot' ? 'reports' : 'advertising', blocks:[], evidence, question:null, proposal, receipt:null, followUps:[] } } }));
  return { proposal, turnId:turn.turn.id };
}
const confirm = proposal => ({ proposalId:proposal.id, version:proposal.version, requestId:proposal.id, confirmation:{ proposalId:proposal.id, payloadHash:proposal.payloadHash } });
const reportQuery = { period:'month', anchorDate:'2025-09-16', filters:{ carrier:'Transportadora sintética', status:'delivered' } };
const reportView = { section:'reports', tab:'shipping', period:reportQuery.period, anchor:reportQuery.anchorDate, ...reportQuery.filters };
const reportInput = async store => ({ target:'report-snapshot', message:'Guarda una copia de esta consulta.', patch:reportQuery, view:reportView,
  selection:{ kind:'report', snapshotId:null, metric:null, issue:null, dataRevision:await revision(store) } });
const runStatus = (store, receipt) => store.readSnapshot(tx => getReportCopyRunTx(tx, receipt.queryKey, receipt.runId));
const campaignView = { section:'advertising', tab:'campaigns' };
const draftData = { mode:'paid', objective:'reach', caption:'Texto sintético', platforms:['facebook'], budgetMinor:5000,
  startAt:'2027-02-03T12:00:00.000Z', endAt:'2027-02-07T12:00:00.000Z' };
async function campaign({ store, session }, name, values = {}) {
  const result = await saveSocialCampaign(store, { name, ...draftData, ...values, requestId:randomUUID() }, session.user.id);
  return getSocialCampaign(store, result.id);
}
const campaignEvidence = row => createAssistantEvidence({ domain:'advertising', entityId:row.id, recordVersion:row.version, field:'name', label:'Nombre', value:row.name,
  href:{ ...campaignView, record:row.id } });
const duplicate = (row, extra = {}) => ({ target:'campaign-duplicate', entityId:row.id, patch:{}, view:campaignView,
  evidence:[campaignEvidence(row)], message:`Duplica la campaña «${row.name}»`, ...extra });

export async function runAdvisorCommandContracts(t, factory) {
  await t.test('C5 solicitar copia versiona la consulta; el recibo no confunde el trabajo o una copia anterior', async t => {
    const f = await fixture(t, factory), { store, session, other } = f;
    const old = await generateReportSnapshot(store, reportQuery, session.user.id);
    const input = await reportInput(store);
    await assert.rejects(prepare(f, { ...input, patch:{} }), status(422));
    await assert.rejects(prepare(f, { ...input, selection:null }), status(422));
    await assert.rejects(prepare(f, { ...input, patch:{ ...reportQuery, filters:{ ...reportQuery.filters, source:randomUUID() } } }), status(422));
    await assert.rejects(prepare(f, { ...input, view:{ ...reportView, mode:'saved' } }), status(422));
    await assert.rejects(prepare(f, { ...input, patch:{ ...reportQuery, filters:{ secret:'synthetic' } } }), status(403));
    const { proposal } = await prepare(f, input);
    assert.equal(proposal.execution, 'confirm');
    assert.equal(proposal.open.owner, 'reports');
    assert.equal(proposal.open.view.anchor, '2025-09-01');
    assert.deepEqual(proposal.patch, { ...reportQuery, anchorDate:'2025-09-01' });
    assert.equal(await count(store, 'report_snapshots'), 1);
    assert.equal(await count(store, 'job_runs', "WHERE key LIKE 'report:%'"), 0);
    await assert.rejects(executeAssistantProposal(store, session, { ...confirm(proposal), confirmation:null }), status(403));
    await assert.rejects(executeAssistantProposal(store, other, confirm(proposal)), status(404));
    const [first, replay] = await Promise.all([executeAssistantProposal(store, session, confirm(proposal)), executeAssistantProposal(store, session, confirm(proposal))]);
    assert.deepEqual(replay, first);
    const receipt = validateAssistantReceipt(first.receipt);
    assert.equal(receipt.operation, 'request-copy');
    assert.equal(receipt.entityId, null);
    assert.equal(receipt.recordVersion, null);
    assert.equal(receipt.jobKey, `report:${receipt.queryKey}`);
    assert.match(receipt.href, /mode=saved/);
    assert.equal((await runStatus(store, receipt)).state, 'queued');
    assert.equal(await count(store, 'report_snapshots'), 1);
    await assert.rejects(prepare(f, input), status(409));
    const job = await store.db.get(`SELECT data FROM ${store.t('job_runs')} WHERE key=?`, [receipt.jobKey]);
    await store.db.run(`UPDATE ${store.t('job_runs')} SET data=? WHERE key=?`, [JSON.stringify({ ...JSON.parse(job.data), query:{ period:'invalid-fixture' } }), receipt.jobKey]);
    assert.equal((await processReportTurn(store)).processed, 1);
    const failed = await runStatus(store, receipt);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.errorCode, 'REPORT_INVALID');
    assert.equal(failed.snapshotId, undefined);

    const second = await prepare(f, input);
    const { receipt:next } = await executeAssistantProposal(store, session, confirm(second.proposal));
    assert.equal(next.queryKey, receipt.queryKey);
    assert.notEqual(next.runId, receipt.runId);
    assert.equal((await runStatus(store, next)).state, 'queued');
    assert.equal((await processReportTurn(store)).processed, 1);
    const succeeded = await runStatus(store, next);
    assert.equal(succeeded.state, 'succeeded');
    assert.equal(succeeded.snapshotId, old.snapshot.id);
    assert.equal(succeeded.revision, old.snapshot.revision);
    assert.equal(succeeded.unchanged, true);
    assert.deepEqual(await runStatus(store, receipt), failed);
    assert.equal(await runStatus(store, { ...next, queryKey:'0'.repeat(64) }), null);
    const reviewed = (await getAssistantTurn(store, { userId:session.user.id, turnId:second.turnId })).data.publicResult;
    assert.equal(reviewed.receipt.runId, next.runId);
    assert.equal(reviewed.proposal.recordVersion, proposal.recordVersion);
    assert.equal(await count(store, 'report_snapshots'), 1);
    assert.equal(await count(store, 'business_requests', "WHERE scope='report:request'"), 2);
    assert.equal(await revision(store), proposal.recordVersion);
  });

  await t.test('C5 un cambio en los datos invalida la copia antes de encolarla', async t => {
    const f = await fixture(t, factory), { store, session } = f;
    const input = await reportInput(store), { proposal } = await prepare(f, input);
    await locked(store, tx => bumpRevision(tx));
    await assert.rejects(executeAssistantProposal(store, session, confirm(proposal)), status(409));
    assert.equal((await getAssistantProposal(store, { userId:session.user.id, proposalId:proposal.id })).state, 'stale');
    assert.equal(await count(store, 'job_runs', "WHERE key LIKE 'report:%'"), 0);
    assert.equal(await count(store, 'report_snapshots'), 0);
  });

  await t.test('C5 duplicar confirma un hijo local y no traslada pruebas, permisos ni actividad de Meta', async t => {
    const f = await fixture(t, factory), { store, session, other } = f;
    const connectionId = randomUUID(), assetId = randomUUID(), now = new Date().toISOString();
    const times = { version:1, created_at:now, updated_at:now };
    await insertRow(store, 'social_connections', { id:connectionId, provider:'meta', integration_method:'api', state:'connected', data:'{}', ...times });
    await insertRow(store, 'social_assets', { id:assetId, state:'ready', sha256:'a'.repeat(64), bytes:100, data:'{"kind":"image"}', ...times });
    const source = await campaign(f, 'Campaña de muestra A', { connectionId, assetId });
    const row = await store.db.get(`SELECT data FROM ${store.t('social_campaigns')} WHERE id=?`, [source.id]);
    const padded = { ...JSON.parse(row.data), rightsAccepted:true, approvedRevision:2, remoteRefs:{ campaignId:'synthetic-remote' }, forecastId:'synthetic-forecast' };
    await store.db.run(`UPDATE ${store.t('social_campaigns')} SET state='active',data=? WHERE id=?`, [JSON.stringify(padded), source.id]);
    await assert.rejects(prepare(f, duplicate(source, { message:'Duplica la campaña que prefieras.' })), status(422));
    await assert.rejects(prepare(f, duplicate(source, { evidence:[] })), status(422));
    await assert.rejects(prepare(f, duplicate(source, { patch:{ name:'Otro borrador' } })), status(400));
    const { proposal, turnId } = await prepare(f, duplicate(source));
    assert.equal(proposal.execution, 'confirm');
    assert.equal(proposal.open.owner, 'advertising');
    assert.equal(proposal.open.view.record, source.id);
    assert.deepEqual(proposal.patch, {});
    assert.deepEqual(proposal.diff, []);
    assert.equal(proposal.humanDiff[0].before, source.name);
    assert.match(proposal.humanDiff[0].after, /no publica ni activa gasto/);
    assert.equal(await count(store, 'social_campaigns'), 1);
    await assert.rejects(executeAssistantProposal(store, session, { ...confirm(proposal), confirmation:null }), status(403));
    await assert.rejects(executeAssistantProposal(store, other, confirm(proposal)), status(404));
    const [first, replay] = await Promise.all([executeAssistantProposal(store, session, confirm(proposal)), executeAssistantProposal(store, session, confirm(proposal))]);
    assert.deepEqual(replay, first);
    const receipt = validateAssistantReceipt(first.receipt), child = await getSocialCampaign(store, receipt.entityId);
    assert.equal(receipt.operation, 'duplicate');
    assert.equal(receipt.parentCampaignId, source.id);
    assert.notEqual(child.id, source.id);
    assert.equal(child.id, first.result.id);
    assert.equal(child.parentCampaignId, source.id);
    assert.equal(child.state, 'draft');
    assert.equal(child.version, 1);
    assert.equal(child.startAt, null);
    assert.equal(child.endAt, null);
    assert.equal(child.publishAt, null);
    const rawChild = JSON.parse((await store.db.get(`SELECT data FROM ${store.t('social_campaigns')} WHERE id=?`, [child.id])).data);
    for (const field of ['rightsAccepted', 'approvedRevision', 'remoteRefs', 'forecastId']) assert.equal(Object.hasOwn(rawChild, field), false, field);
    for (const table of ['social_revisions', 'social_deliveries', 'social_operations', 'job_runs', 'cash_entries']) assert.equal(await count(store, table), 0, table);
    assert.equal(await count(store, 'business_requests', 'WHERE scope=?', [`social:campaign:duplicate:${source.id}`]), 1);
    assert.equal(await count(store, 'social_campaigns'), 2);
    assert.equal((await getSocialCampaign(store, source.id)).state, 'active');
    const persisted = await getAssistantProposal(store, { userId:session.user.id, proposalId:proposal.id });
    assert.equal(assistantProposalDTO(persisted).entityId, source.id);
    const publicTurn = await getAssistantTurn(store, { userId:session.user.id, turnId });
    assert.equal(publicTurn.data.publicResult.proposal.entityId, source.id);
    assert.equal(publicTurn.data.publicResult.receipt.entityId, child.id);
    assert.throws(() => validateProposalDTO({ ...proposal, execution:'automatic' }));
    await assert.rejects(prepare(f, duplicate(source)), status(422));
  });

  await t.test('C5 una campaña seleccionada resuelve homónimos; edición pendiente y versión cambiada bloquean duplicar', async t => {
    const f = await fixture(t, factory), { store, session, other } = f;
    const source = await campaign(f, 'Nombre duplicado de prueba');
    await campaign(f, source.name);
    await assert.rejects(prepare(f, duplicate(source)), status(422));
    const selected = { target:'campaign-draft', entityId:source.id, recordVersion:source.version, busy:false, dirty:false };
    const input = duplicate(source, { view:{ ...campaignView, record:source.id }, campaignSelection:selected, evidence:[], message:'Duplica esta campaña' });
    await assert.rejects(prepare(f, { ...input, campaignSelection:{ ...selected, dirty:true } }), status(409));
    const { proposal } = await prepare(f, input);
    await saveSocialCampaign(store, { id:source.id, version:source.version, name:'Nombre revisado por B', requestId:randomUUID() }, other.user.id);
    await assert.rejects(executeAssistantProposal(store, session, confirm(proposal)), status(409));
    assert.equal((await getAssistantProposal(store, { userId:session.user.id, proposalId:proposal.id })).state, 'stale');
    assert.equal(await count(store, 'social_campaigns'), 2);
    assert.equal(await count(store, 'social_operations'), 0);
  });
}
