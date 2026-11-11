import { randomUUID } from 'node:crypto';
import { fail, integer, text } from '../validation-core.mjs';
import { emptyRecord, schemas } from '../schema.mjs';
import { validateRecord, validateSettings, validateOrder } from '../validation.mjs';
import { adminHref, readAdminView } from '../admin-view.mjs';
import { parseMoneyMinor } from '../business/money.mjs';
import { audit, entity, hash, runCommand, stamp } from '../business/commands.mjs';
import * as finance from '../business/finance.mjs';
import { getCashClosingPreview, saveAccount } from '../business/cash.mjs';
import { getBusinessSettings, getResource, saveResource, saveBusinessSettings } from '../business/settings.mjs';
import { getAlert, getAlertRule, saveAlertRule, updateAlert } from '../business/alerts.mjs';
import { getShipment, saveShipment, recordShipmentEvent, validateShipmentMetadata } from '../business/shipments.mjs';
import { loadOrderData } from '../business/orders.mjs';
import { getSocialConnection, saveSocialCampaign } from '../business/social.mjs';
import { normalizeSocialCampaignInput } from '../business/social-spec.mjs';
import { removeUnusedProductImage } from '../media.mjs';
import * as forms from './forms.mjs';
import { validateProposalDTO } from './contracts.mjs';
import { assertAssistantSession, assertAssistantAccess } from './settings.mjs';
import { getAssistantProposal, saveAssistantProposal, transitionAssistantProposal, hashAssistantProposalPayload, canonicalAssistantJSON, recordAssistantExecution, recoverAssistantExecution } from './repository.mjs';

const own = (value, key) => Object.hasOwn(value, key);
const same = (left, right) => canonicalAssistantJSON(left) === canonicalAssistantJSON(right);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
// Native SQLite rows have no prototype; project them before command hashing.
const rowDigest = row => hash({ ...row });
const creationTarget = (target, entityId) => target === 'shipment-create' || entityId == null
  && (target.startsWith('record:') || ['order', 'campaign-draft', 'settings:person', 'settings:platform', 'settings:source',
    'business-action:account-save', 'business-action:expense', 'business-action:settlement-save', 'business-action:payroll-confirm'].includes(target));
const currencyCodes = new Set(Intl.supportedValuesOf('currency'));
const currencyAliases = [
  ['COP', 'pesos?\\s+colombianos?|COL\\s*\\$'],
  ['USD', 'd[oó]lar(?:es)?|dollars?|US\\s*\\$|U\\.S\\.\\s*\\$|\\$\\s*US(?:D)?'],
  ['EUR', 'euros?|€'], ['GBP', 'libras?\\s+esterlinas?|£'], ['JPY', 'yen(?:es)?'],
  ['CNY', 'yuan(?:es)?|renminbi'], ['RUB', 'rublos?|₽'], ['INR', 'rupias?|rupees?|₹'],
  ['ARS', 'pesos?\\s+argentinos?'], ['CLP', 'pesos?\\s+chilenos?'], ['MXN', 'pesos?\\s+mexicanos?|MX\\s*\\$'],
  ['UYU', 'pesos?\\s+uruguayos?'], ['DOP', 'pesos?\\s+dominicanos?|RD\\s*\\$'], ['CUP', 'pesos?\\s+cubanos?'],
  ['CAD', 'CA\\s*\\$'], ['AUD', 'AU\\s*\\$'], ['NZD', 'NZ\\s*\\$'], ['HKD', 'HK\\s*\\$'], ['SGD', 'SG\\s*\\$'],
  ['BRL', 'reales?\\s+brasileños?|R\\s*\\$'], ['VES', 'bol[ií]vares?'], ['BOB', 'bolivianos?'],
  ['PYG', 'guaran[ií](?:es)?'], ['GTQ', 'quetzales?'], ['HNL', 'lempiras?'], ['NIO', 'c[oó]rdobas?'],
  ['PAB', 'balboas?'], ['PEN', 'soles?'], ['CHF', 'francos?'],
  [null, 'BTC|XBT|ETH|USDT|USDC|dirhams?|dinares?|(?![$€£₽₹])\\p{Sc}'],
];
const currencyGap = `[\\s"'«»“”()\\[\\]:=;,.$-]*`;
const currencyCodePrefix = new RegExp(`(?<![\\p{L}_])([A-Z]{3})${currencyGap}$`, 'u');
const currencyCodeSuffix = new RegExp(`^${currencyGap}([A-Z]{3})(?![\\p{L}_])`, 'u');
const currencyDeclaration = /\b(?:moneda|divisa)\s*(?:(?:es|será|seran|serán|en|de)\s+|[:=]\s*)?([A-Z]{3})(?![\p{L}_])/giu;
const knownCurrency = value => currencyCodes.has(value) ? value : null;
function currencyPolicy(currency) {
  if (!currency) return null;
  const unit = patterns => `(?<![\\p{L}_])(?:${patterns.join('|')})(?![\\p{L}_])`;
  const foreign = unit([...currencyCodes].filter(code => code !== currency).concat(currencyAliases.filter(([code]) => code !== currency).map(([, pattern]) => pattern)));
  const explicit = unit([currency, ...currencyAliases.filter(([code]) => code === currency).map(([, pattern]) => pattern)]);
  const statement = units => new RegExp(`(?:\\ben\\s*[:=]?\\s*${units}|\\b(?:moneda|divisa|denominad[oa]s?|expresad[oa]s?)[^\\n]*?${units}|^\\s*${units}\\s*[:;,.]|${units}\\s*(?:(?:es|será|como)\\s+)?(?:la\\s+)?(?:moneda|divisa)\\b)`, 'iu');
  return { currency, prefix: new RegExp(`${foreign}${currencyGap}$`, 'iu'), suffix: new RegExp(`^${currencyGap}(?:en\\s+)?${foreign}`, 'iu'), statement: statement(foreign),
    explicitPrefix: new RegExp(`${explicit}${currencyGap}$`, 'iu'), explicitSuffix: new RegExp(`^${currencyGap}(?:en\\s+)?${explicit}`, 'iu'), explicitStatement: statement(explicit) };
}
function economicSource(message, policy) {
  const source = { message, foreignCurrency: !policy || typeof message !== 'string' || policy.statement.test(message), explicitCurrency: typeof message === 'string' && Boolean(policy?.explicitStatement.test(message)) };
  if (typeof message === 'string') for (const declaration of message.matchAll(currencyDeclaration)) {
    if (declaration[1].toUpperCase() !== policy?.currency) source.foreignCurrency = true;
    else source.explicitCurrency = true;
  }
  return source;
}
function isCurrencyLiteral(source, ref, policy) {
  const { message } = source;
  // A numeric-only citation cannot hide another currency or part of an amount.
  if (!policy || source.foreignCurrency) return false;
  const before = message[ref.start - 1] || '', after = message[ref.end] || '';
  if (/[\d+-]/u.test(before) || /[\d+-]/u.test(after)
    || /[.,]/u.test(before) && /\d/u.test(message[ref.start - 2] || '')
    || /[.,]/u.test(after) && /\d/u.test(message[ref.end + 1] || '')) return false;
  const prefix = message.slice(0, ref.start), suffix = message.slice(ref.end);
  const precedingCode = currencyCodePrefix.exec(prefix)?.[1], followingCode = currencyCodeSuffix.exec(suffix)?.[1];
  if (precedingCode && precedingCode !== policy.currency || followingCode && followingCode !== policy.currency) return false;
  if (policy.prefix.test(prefix) || policy.suffix.test(suffix)) return false;
  return policy.currency === 'COP' || source.explicitCurrency || policy.explicitPrefix.test(prefix) || policy.explicitSuffix.test(suffix);
}
function assistantError(message, code = 'ASSISTANT_CONFLICT', status = 409) {
  return Object.assign(new Error(message), { code, status });
}
const conflict = message => { throw assistantError(message); };
const denied = message => { throw assistantError(message, 'ASSISTANT_SCOPE_DENIED', 403); };
const humanOnly = target => /^(?:import-|onboarding:)/.test(target) || ['asset-metadata', 'advertising-result-action', 'business-action:payroll-prepare'].includes(target);
const FINANCIAL = Object.freeze({
  collection: finance.recordCollection, refund: finance.recordRefund, expense: finance.recordExpense,
  'expense-recovery': finance.recordExpenseRecovery, 'pay-expense': finance.payExpense,
  'settlement-save': finance.saveSettlement, 'settlement-confirm': finance.confirmSettlement,
  transfer: finance.transferMoney, 'cash-close': finance.closeCash, 'cash-reopen': finance.reopenCash,
  'cash-reverse': finance.reverseCashEntry, 'document-reverse': finance.reverseFinancialDocument,
  'resolve-legacy-payment': finance.resolveLegacyPayment, return: finance.registerReturn,
  'payroll-confirm': finance.confirmPayroll, 'payroll-pay': finance.payPayroll,
  advance: finance.recordAdvance, income: finance.recordIncome,
  'complete-costs': finance.completeOrderCosts, 'link-shipment': finance.linkShipment,
});
const RESOURCES = Object.freeze({ person: 'people', platform: 'platforms', source: 'sources' });
const AUTO_FIELDS = Object.freeze({
  'record:products': ['title', 'description', 'presentation', 'flavor', 'productInfo'],
  'record:combos': ['title', 'description', 'conditions'], 'record:catalogs': ['title', 'description'],
  'record:faqs': ['title', 'answer'], 'record:messages': ['title', 'body', 'buttonText'],
  'record:shipping': ['title', 'zone', 'costText', 'estimatedTime', 'cashOnDelivery', 'details'],
  'campaign-draft': ['name', 'caption', 'headline'],
});
const REF_TABLES = Object.freeze({
  order: 'orders', shipment: 'shipments', expense: 'expenses', settlement: 'settlements',
  payroll: 'payroll_periods', account: 'cash_accounts', closing: 'cash_closings', entry: 'cash_entries',
  person: 'people', platform: 'platforms', source: 'platform_sources',
  collection: 'order_collections', settlement_receipt: 'settlement_receipts', expense_payment: 'expense_payments',
  payroll_payment: 'cash_entries', advance: 'cash_entries', connection: 'social_connections', asset: 'social_assets',
});
const FIELD_ROLE = Object.freeze({
  orderId: 'order', shipmentId: 'shipment', replacesShipmentId: 'shipment', expenseId: 'expense',
  settlementId: 'settlement', payrollId: 'payroll', accountId: 'account', fromAccountId: 'account',
  toAccountId: 'account', defaultReceiptAccountId: 'account', defaultPaymentAccountId: 'account',
  closingId: 'closing', cashEntryId: 'entry', personId: 'person', responsibleId: 'person', sellerId: 'person',
  platformId: 'platform', sourceId: 'source', collectionId: 'collection',
  connectionId: 'connection', assetId: 'asset',
});
const ACTION_PRIMARY = Object.freeze({
  collection: ['order', 'orderId'], refund: ['order', 'orderId'], return: ['order', 'orderId'],
  'complete-costs': ['order', 'orderId'], 'resolve-legacy-payment': ['order', 'orderId'],
  'link-shipment': ['shipment', 'shipmentId'], expense: ['expense', 'expenseId'],
  'pay-expense': ['expense', 'expenseId'], 'expense-recovery': ['expense', 'expenseId'],
  'settlement-save': ['settlement', 'settlementId'], 'settlement-confirm': ['settlement', 'settlementId'],
  'payroll-confirm': ['payroll', 'payrollId'], 'payroll-pay': ['payroll', 'payrollId'],
  'cash-reopen': ['closing', 'closingId'], 'cash-reverse': ['entry', 'cashEntryId'],
  'account-save': ['account', 'accountId'],
});
const REQUIRED = Object.freeze({
  order: ['customerName', 'phone', 'city', 'placedOn', 'items'],
  'shipment-create': ['orderId'], 'shipment-metadata': [],
  'shipment-event': ['status'], 'campaign-draft': ['name'],
  'settings:person': ['name'], 'settings:platform': ['name'], 'settings:source': ['name', 'platformId'],
  'settings:policy': ['effectiveOn', 'saleRecognition', 'commission'], 'settings:preferences': [],
  'settings:alert-rule': [], 'settings:alert': [], 'storefront-settings': [],
  'business-action:account-save': ['name', 'type', 'responsibleId', 'openingOn', 'openingBalanceMinor'],
  'business-action:collection': ['orderId', 'amountMinor', 'occurredOn', 'holder', 'method', 'reference'],
  'business-action:refund': ['orderId', 'amountMinor', 'occurredOn', 'holder', 'method', 'reference', 'reason'],
  'business-action:expense': ['category', 'amountMinor'],
  'business-action:expense-recovery': ['expenseId', 'amountMinor', 'accountId', 'effectiveOn', 'reason'],
  'business-action:pay-expense': ['expenseId', 'amountMinor', 'accountId', 'effectiveOn'],
  'business-action:settlement-save': ['sourceId', 'netMinor', 'lines'],
  'business-action:settlement-confirm': ['settlementId', 'receivedOn', 'lines'],
  'business-action:transfer': ['fromAccountId', 'toAccountId', 'effectiveOn', 'amountMinor', 'concept'],
  'business-action:cash-close': ['accountId', 'closingOn', 'countedMinor'],
  'business-action:cash-reopen': ['closingId', 'reason'], 'business-action:cash-reverse': ['cashEntryId', 'effectiveOn', 'reason'],
  'business-action:document-reverse': ['documentType', 'documentId', 'effectiveOn', 'reason'],
  'business-action:resolve-legacy-payment': ['orderId', 'mode', 'reason'],
  'business-action:return': ['orderId', 'occurredOn', 'reason', 'lines'],
  'business-action:payroll-confirm': ['personId', 'startOn', 'endOnExclusive'],
  'business-action:payroll-pay': ['payrollId', 'amountMinor', 'accountId', 'effectiveOn'],
  'business-action:advance': ['personId', 'accountId', 'effectiveOn', 'amountMinor', 'concept'],
  'business-action:income': ['accountId', 'effectiveOn', 'amountMinor', 'concept'],
  'business-action:complete-costs': ['orderId', 'reason', 'lineCosts'],
  'business-action:link-shipment': ['orderId', 'shipmentId', 'reason'],
});

// Original handlers receive a Store-compatible facade over the already locked transaction.
// Their runCommand/transaction/readSnapshot calls never open a second database transaction.
function transactionStore(tx) {
  const facade = Object.create(tx);
  facade.transaction = fn => fn(facade);
  facade.readSnapshot = fn => fn(facade);
  return facade;
}
function normalizeMoney(value, key = '') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' && (/Minor$/.test(key) || key === 'price')) {
    if (!value.trim()) return null;
    const minor = parseMoneyMinor(value);
    if (key === 'price') {
      if (minor % 100 !== 0) fail('El precio de catálogo debe expresarse en pesos enteros.');
      return minor / 100;
    }
    return minor;
  }
  if (Array.isArray(value)) return value.map(item => normalizeMoney(item));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, normalizeMoney(item, field)]));
  return value;
}
function safeInput(input) {
  if (!plain(input) || Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) fail('Datos de propuesta no válidos.');
  const visit = (value, depth = 0) => {
    if (depth > 12) fail('Datos de propuesta demasiado profundos.');
    if (Array.isArray(value)) { if (value.length > 200) fail('Demasiados elementos en la propuesta.'); for (const item of value) visit(item, depth + 1); }
    else if (plain(value)) for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || /(?:password|token|secret|csrf|credential|ciphertext|apiKey)/i.test(key)) denied('La propuesta contiene campos privados o no admitidos.');
      visit(item, depth + 1);
    }
    else if (value !== null && !['string', 'boolean', 'number'].includes(typeof value)) fail('Valor de propuesta no válido.');
    else if (typeof value === 'number' && !Number.isFinite(value)) fail('Número no válido.');
  };
  visit(input);
  return normalizeMoney(input);
}
async function ownedOrigin(tx, session, threadId, turnId) {
  const row = await tx.db.get(`SELECT t.*,h.data AS thread_data FROM ${tx.t('assistant_turns')} t JOIN ${tx.t('assistant_threads')} h ON h.id=t.thread_id AND h.user_id=t.user_id WHERE t.id=? AND t.thread_id=? AND t.user_id=?`, [turnId, threadId, session.user.id]);
  if (!row) fail('Conversación no encontrada.', 404);
  return { ...row, data: JSON.parse(row.data), threadData: JSON.parse(row.thread_data) };
}
async function economicInputMessages(tx, session, origin, target, sourceRefs, policy) {
  const messages = new Map([[origin.id, economicSource(origin.data.message, policy)]]);
  const question = origin.threadData.pendingQuestion, context = origin.threadData.pendingQuestionContext;
  if (!question?.id || origin.data.answer?.questionId !== question.id || !plain(context)
    || context.target != null && context.target !== target
    || !Array.isArray(context.sourceTurnIds) || context.sourceTurnIds.length > 20) return messages;
  const allowed = new Set(context.sourceTurnIds.filter(id => typeof id === 'string'));
  const ids = [...new Set(sourceRefs.filter(ref => plain(ref) && ref.turnId !== origin.id && allowed.has(ref.turnId)).map(ref => ref.turnId))];
  if (!ids.length) return messages;
  // The private question chain authorizes input reuse, not prior permissions or facts.
  const rows = await tx.db.all(`SELECT id,data FROM ${tx.t('assistant_turns')} WHERE user_id=? AND thread_id=? AND state='completed' AND started_at<=? AND id IN (${ids.map(() => '?').join(',')})`, [session.user.id, origin.thread_id, origin.started_at, ...ids]);
  for (const row of rows) {
    const message = JSON.parse(row.data).message;
    if (typeof message === 'string' && message.length <= 8000) messages.set(row.id, economicSource(message, policy));
  }
  return messages;
}
async function reference(tx, kind, id) {
  text(id, 'Referencia', 200, true);
  if (!own(REF_TABLES, kind)) denied('Tipo de referencia no permitido.');
  let row = kind === 'payroll_payment'
    ? await tx.db.get(`SELECT * FROM ${tx.t('cash_entries')} WHERE (id=? OR source_id=?) AND source_type='payroll_payment' AND reversal_of IS NULL`, [id, id])
    : await tx.db.get(`SELECT * FROM ${tx.t(REF_TABLES[kind])} WHERE id=?`, [id]);
  if (!row && kind === 'payroll_payment') {
    row = await tx.db.get(`SELECT * FROM ${tx.t('payroll_periods')} WHERE id=?`, [id]);
    if (row) return { kind, id, version: Number(row.version), digest: rowDigest(row), value: entity(row) };
  }
  if (!row) fail('La referencia seleccionada no existe.', 404);
  if (kind === 'payroll_payment' && row.source_type !== 'payroll_payment' || kind === 'advance' && row.kind !== 'advance') denied('El documento no corresponde a su tipo.');
  return { kind, id, version: row.version == null ? null : Number(row.version), digest: rowDigest(row), value: entity(row) };
}
async function recordReference(tx, kind, id) {
  const row = await tx.db.get(`SELECT * FROM ${tx.t('records')} WHERE kind=? AND id=?`, [kind, id]);
  if (!row) fail('Referencia de catálogo no encontrada.', 404);
  return { kind: `record:${kind}`, id, version: Number(row.version), digest: rowDigest(row), value: await tx.get(kind, id) };
}
async function referencesFor(tx, payload, { primary = null, existing = [] } = {}) {
  const references = new Map(existing.map(ref => [`${ref.kind}:${ref.id}`, ref]));
  const choices = {};
  const add = async (kind, id, field) => {
    const ref = kind.startsWith('record:') ? await recordReference(tx, kind.slice(7), id) : await reference(tx, kind, id);
    references.set(`${kind}:${id}`, ref);
    if (field) (choices[field] ||= []).push(id);
    return ref;
  };
  const walk = async (value, parent = '', context = {}) => {
    if (Array.isArray(value)) { for (const item of value) await walk(item, parent, context); return; }
    if (!plain(value)) return;
    const local = { ...context, ...(value.kind ? { kind: value.kind } : {}) };
    for (const [field, item] of Object.entries(value)) {
      if (FIELD_ROLE[field] && typeof item === 'string' && item) await add(FIELD_ROLE[field], item, field);
      else if (field === 'itemId' && item) await add(`record:${local.kind}`, item, 'items.itemId');
      else if (field === 'productId' && item) await add('record:products', item, 'productId');
      else if (field === 'catalogIds' && Array.isArray(item)) for (const id of item) await add('record:catalogs', id, 'catalogIds');
      else if (field === 'documentId' && item) {
        const type = value.documentType;
        if (!['collection', 'refund', 'settlement', 'settlement_receipt', 'expense_payment', 'payroll_payment', 'advance'].includes(type)) denied('Tipo de documento no permitido.');
        const ref = await add(type === 'refund' ? 'collection' : type, item, 'documentId');
        if (['collection', 'refund'].includes(type) && ref.value.kind !== (type === 'refund' ? 'refund' : 'receipt')) denied('El documento no coincide con su tipo.');
      }
      await walk(item, field, local);
    }
  };
  await walk(payload);
  const orderId = payload.orderId || (primary?.kind === 'order' ? primary.id : null);
  const order = orderId ? await loadOrderData(tx, orderId) : null;
  const lines = new Map((order?.items || []).map(line => [line.lineId, line]));
  const checkLines = (value, parent = '') => {
    if (Array.isArray(value)) return value.forEach(item => checkLines(item, parent));
    if (!plain(value)) return;
    if (value.lineId != null && parent !== 'items' && !lines.has(value.lineId)) denied('La línea no pertenece al pedido seleccionado.');
    if (parent === 'assignments' && !own(value, 'lineId')) for (const [lineId, quantity] of Object.entries(value)) {
      if (!lines.has(lineId) || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > lines.get(lineId).quantity) denied('La asignación no corresponde a las líneas del pedido.');
    }
    for (const [key, item] of Object.entries(value)) checkLines(item, key);
  };
  if (order) {
    checkLines(payload);
    choices.lineId = [...lines.keys()];
    choices.assignments = Object.fromEntries([...lines].map(([id, line]) => [id, line.quantity]));
  }
  return { references: [...references.values()], choices };
}
function storedReferences(refs) { return refs.map(({ kind, id, version, digest }) => ({ kind, id, version, digest })); }
function publicRef(ref, documentType = null) {
  return { kind: ref.kind, id: ref.id, version: ref.version, ...(documentType ? { documentType } : {}) };
}
function opening(target, entityId, refs, payload, contextView = {}) {
  let owner = 'admin', view;
  if (target.startsWith('record:')) view = { section: target.slice(7), record: entityId || 'new' };
  else if (target === 'order' || target === 'shipment-create' || target.startsWith('business-action:') && ['collection', 'refund', 'return', 'complete-costs', 'resolve-legacy-payment', 'link-shipment'].includes(target.slice(16)) || target === 'business-action:expense' && refs.order) {
    owner = target === 'order' ? 'admin' : 'order-editor'; view = { section: 'orders', tab: 'list', record: refs.order?.id || entityId || 'new' };
  } else if (target.startsWith('shipment-')) { owner = 'shipments'; view = { section: 'orders', tab: 'shipments', record: refs.shipment?.id || entityId || '' }; }
  else if (target === 'campaign-draft' || target === 'asset-metadata') { owner = 'advertising'; view = { section: 'advertising', tab: target === 'campaign-draft' ? 'campaigns' : 'assets', record: entityId || (target === 'campaign-draft' ? 'new' : '') }; }
  else if (target === 'advertising-result-action') { owner = 'advertising'; view = { ...readAdminView(contextView), section: 'advertising', tab: 'results' }; }
  else if (target.startsWith('import-')) { owner = 'imports'; view = { section: 'orders', tab: 'imports', batch: entityId || 'new' }; }
  else if (target.startsWith('onboarding:')) { owner = 'onboarding'; view = { section: 'business', tab: 'setup' }; }
  else if (target === 'storefront-settings') view = { section: 'settings' };
  else if (target.startsWith('settings:') || target === 'business-action:account-save') {
    owner = 'business'; const kind = target.slice(9); view = { section: 'business', tab: target === 'business-action:account-save' ? 'accounts' : kind === 'person' ? 'people' : ['platform', 'source'].includes(kind) ? 'platforms' : ['alert', 'alert-rule'].includes(kind) ? 'alerts' : 'rules' };
  } else {
    owner = 'cash';
    const action = target.slice(16);
    const tab = action.startsWith('settlement-') ? 'settlements' : action.startsWith('payroll-') ? 'payroll'
      : ['expense', 'expense-recovery', 'pay-expense'].includes(action) ? 'expenses' : ['cash-close', 'cash-reopen'].includes(action) ? 'overview' : 'movements';
    view = { section: 'cash', tab, ...(refs.account ? { account: refs.account.id } : {}) };
  }
  return { owner, view: readAdminView(view || contextView), target, entityId, refs };
}
function missingFields(target, payload, entityId) {
  const fields = [...(REQUIRED[target] || [])];
  if (target.startsWith('record:')) {
    const kind = target.slice(7);
    fields.push(...schemas[kind].fields.filter(field => field.required).map(field => field.name));
  }
  if (['business-action:collection', 'business-action:refund'].includes(target)) fields.push(payload.holder === 'platform' ? 'shipmentId' : 'accountId');
  if (target === 'business-action:account-save' && entityId) fields.splice(fields.indexOf('openingBalanceMinor'), 1);
  if (target === 'shipment-event' && !payload.occurredOn && !payload.occurredAt && !payload.sourceAsOf) fields.push('sourceAsOf');
  if (target === 'business-action:resolve-legacy-payment' && payload.mode === 'cash_movement') fields.push('accountId', 'occurredOn', 'method');
  if (target === 'business-action:expense' && payload.accountId) fields.push('effectiveOn');
  if (target === 'business-action:payroll-confirm' && (payload.bonusMinor || payload.discountMinor)) fields.push('reason');
  if (target === 'order' && entityId && payload.placedOn === null) fields.splice(fields.indexOf('placedOn'), 1);
  if (target === 'business-action:expense' && ['shipping_out', 'shipping_return', 'shipping_insurance', 'platform_fee'].includes(payload.category) && payload.shipmentId && own(payload, 'amountMinor') && payload.amountMinor === null) fields.splice(fields.indexOf('amountMinor'), 1);
  const values = target === 'settings:policy' ? payload.rulesVersions?.at(-1) || {} : payload;
  return [...new Set(fields)].filter(field => values[field] == null || values[field] === '' || Array.isArray(values[field]) && !values[field].length);
}
function diffFor(target, before, patch) {
  return Object.entries(patch).map(([field, after]) => ({ field, label: forms.assistantFieldLabel(target, field), before: before[field] ?? null, after }));
}
function humanDiffFor(target, before, after, patch) {
  return forms.assistantSubmissionFields(target)
    .filter(field => !own(patch, field) && !same(before[field] ?? null, after[field] ?? null))
    .map(field => ({ field, label: forms.assistantFieldLabel(target, field), before: before[field] ?? null, after: after[field] ?? null }));
}
const valueAt = (value, path) => path.split('.').reduce((item, key) => item?.[key], value);
function filterUnprovenFinancialFields(patch, { original, values, sourceRefs, evidence, inputMessages, policy, evidenceCurrencies }) {
  const missing = new Set();
  const walk = (value, path, field) => {
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}.${index}`, field));
    if (plain(value)) return Object.entries(value).forEach(([key, item]) => walk(item, path ? `${path}.${key}` : key, key));
    if (value == null || value === '') return;
    const kind = forms.assistantEconomicFieldKind(field), money = kind === 'money';
    const date = kind === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(value);
    if (!money && !date || same(valueAt(values, path) ?? null, value) || same(valueAt(original, path) ?? null, value)) return;
    const refs = sourceRefs.filter(ref => plain(ref) && ref.field === path);
    const proven = refs.some(ref => {
      const source = inputMessages.get(ref.turnId), message = source?.message;
      if (typeof message === 'string' && ref.start >= 0 && ref.end > ref.start && ref.end <= message.length) {
        const literal = message.slice(ref.start, ref.end);
        if (date) return literal === value;
        if (!isCurrencyLiteral(source, ref, policy)) return false;
        try { const minor = parseMoneyMinor(literal); return field === 'price' ? minor % 100 === 0 && minor / 100 === value : minor === value; } catch { return false; }
      }
      const fact = evidence.find(item => item.id === ref.evidenceId);
      if (!fact || fact.coverage?.state !== 'complete' || fact.field !== (ref.sourceField || path)) return false;
      if (date) return fact.value === value;
      const sourceCurrency = fact.domain === 'advertising' ? evidenceCurrencies.get(fact.id) : ['catalog','orders','shipments','cash','reports','recommendations','business','alerts','imports'].includes(fact.domain) ? 'COP' : null;
      if (!policy || sourceCurrency !== policy.currency) return false;
      if (fact.value === value && fact.unit === (field === 'price' ? sourceCurrency : 'minor')) return true;
      if (field !== 'price' && fact.unit === sourceCurrency && Number.isSafeInteger(fact.value)) return parseMoneyMinor(String(fact.value)) === value;
      return false;
    });
    if (!proven) missing.add(path.split('.')[0]);
  };
  walk(patch, '', '');
  for (const field of missing) delete patch[field];
  return [...missing];
}
export function assistantProposalDTO(row) {
  const receipt = row.state === 'executed' ? row.data.executionResponse?.receipt : null;
  const data = receipt ? { ...row.data, entityId: receipt.entityId, recordVersion: receipt.recordVersion, open: { ...row.data.open, entityId: receipt.entityId } } : row.data;
  return validateProposalDTO({
    id: row.id, version: row.version, state: row.state,
    ...Object.fromEntries(['configurationVersion', 'payloadHash', 'target', 'entityId', 'recordVersion', 'formId', 'generation', 'open', 'patch', 'missingFields', 'diff', 'execution', 'moneyCurrency'].map(key => [key, data[key]])),
    humanDiff: data.humanDiff || [],
  }, { hasReceipt: row.state === 'executed' && Boolean(data.executionResponse?.receipt) });
}
async function loadTarget(tx, target, entityId, form) {
  let original = {}, fixed = {}, primary = null;
  if (target.startsWith('record:')) {
    const kind = target.slice(7);
    if (!own(schemas, kind)) denied('Tipo de contenido no permitido.');
    original = entityId ? (await recordReference(tx, kind, entityId)).value : emptyRecord(kind);
    if (!original) fail('Registro no encontrado.', 404);
    primary = entityId ? await recordReference(tx, kind, entityId) : null;
  } else if (target === 'order' || target === 'shipment-create') {
    if (entityId) { primary = await reference(tx, 'order', entityId); original = await loadOrderData(tx, entityId); }
    if (target === 'shipment-create') { original = {}; if (entityId) fixed.orderId = entityId; }
  } else if (target === 'storefront-settings') { original = await tx.settings(); }
  else if (target === 'settings:policy' || target === 'settings:preferences') {
    original = await getBusinessSettings(tx); primary = { kind: 'business_settings', id: '1', version: original.version, digest: hash(original), value: original };
    if (target === 'settings:policy') { fixed.businessSettings = original; original = {}; fixed.policyId = randomUUID(); }
  } else if (target.startsWith('settings:') && RESOURCES[target.slice(9)]) {
    const kind = target.slice(9);
    if (entityId) { primary = await reference(tx, kind, entityId); original = await getResource(tx, RESOURCES[kind], entityId); }
  } else if (target === 'settings:alert-rule' || target === 'settings:alert') {
    if (!entityId) denied('Selecciona el aviso o regla existente.');
    original = target === 'settings:alert-rule' ? await getAlertRule(tx, entityId) : await getAlert(tx, entityId);
    primary = { kind: target.slice(9), id: entityId, version: original.version, digest: hash(original), value: original };
  } else if (['shipment-metadata', 'shipment-event'].includes(target)) {
    if (!entityId) denied('Selecciona un envío existente.');
    primary = await reference(tx, 'shipment', entityId); original = await getShipment(transactionStore(tx), entityId);
    if (target === 'shipment-event') { fixed.shipment = original; original = {}; }
  } else if (target === 'campaign-draft') {
    if (entityId) {
      const row = await tx.db.get(`SELECT * FROM ${tx.t('social_campaigns')} WHERE id=?`, [entityId]);
      if (!row) fail('Campaña no encontrada.', 404);
      original = entity(row); primary = { kind: 'campaign', id: entityId, version: original.version, digest: rowDigest(row), value: original };
      if (original.state !== 'draft') denied('Solo se pueden editar borradores publicitarios locales.');
    }
  } else if (target.startsWith('business-action:')) {
    const action = target.slice(16);
    if (!own(FINANCIAL, action) && action !== 'account-save' && action !== 'payroll-prepare') denied('Acción no permitida.');
    const binding = action === 'cash-close' ? ['account', 'accountId'] : ACTION_PRIMARY[action];
    const candidate = binding && (form?.values?.[binding[1]] || entityId);
    if (candidate && binding) {
      primary = await reference(tx, binding[0], candidate);
      if (action === 'account-save' || action === 'expense' || action === 'settlement-save') original = primary.value;
      if (binding[1] && action !== 'account-save') fixed[binding[1]] = primary.id;
    }
  } else if (!humanOnly(target)) denied('Destino no permitido.');
  return { original, fixed, primary };
}
function bindForm(formContext, target, entityId, version) {
  const form = formContext?.form || (formContext?.formId ? formContext : null);
  if (!form) return null;
  if (form.target !== target || (form.entityId ?? null) !== entityId || form.busy) conflict('El formulario no corresponde al cambio o está ocupado.');
  // Some create dialogs expose a context version without a business record of their own.
  if (version != null && form.recordVersion !== version) conflict('El registro del formulario cambió.');
  text(form.formId, 'Formulario', 100, true); integer(form.generation, 'Generación', 0);
  return form;
}
function normalizePayload(target, original, values, patch, fixed, entityId, recordVersion, acknowledgements = {}) {
  const payload = { ...original, ...values, ...patch, ...acknowledgements };
  for (const key of ['id', 'version', 'requestId', 'createdAt', 'updatedAt']) delete payload[key];
  if (target === 'settings:policy') {
    const provided = { ...values, ...patch }, saved = fixed.businessSettings.rulesVersions;
    let policy;
    if (Array.isArray(provided.rulesVersions)) {
      if (provided.rulesVersions.length !== saved.length + 1 || !same(provided.rulesVersions.slice(0, -1), saved)) conflict('Las vigencias guardadas no se pueden reemplazar desde esta propuesta.');
      policy = provided.rulesVersions.at(-1);
    } else policy = Object.fromEntries(forms.assistantFormDescriptor(target).fields.filter(key => key !== 'reason' && own(provided, key)).map(key => [key, provided[key]]));
    return { ...fixed.businessSettings, ...acknowledgements, rulesVersions: [...saved, { ...policy, id: fixed.policyId }], reason: provided.reason || '', version: recordVersion };
  }
  if (fixed.orderId) payload.orderId = fixed.orderId;
  for (const [key, value] of Object.entries(fixed)) if (!['businessSettings', 'policyId', 'shipment'].includes(key)) payload[key] = value;
  if (recordVersion != null && target !== 'shipment-create') payload.version = recordVersion;
  if (target === 'business-action:document-reverse' && payload.version == null) payload.version = 1;
  if (target === 'business-action:settlement-save' && original.id && !own(values, 'externalKey') && !own(patch, 'externalKey')) payload.externalKey = original.externalId || '';
  if (target === 'campaign-draft' && entityId) payload.id = entityId;
  if (target.startsWith('record:')) return Object.fromEntries(schemas[target.slice(7)].fields.map(field => [field.name, payload[field.name]]));
  if (target === 'storefront-settings') return validateSettings(payload);
  if (target === 'order' || target.startsWith('settings:')) {
    const allowed = new Set([...forms.assistantSubmissionFields(target), 'version']);
    const selected = Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.has(key)));
    if (target === 'settings:alert' && (!own(values, 'state') && !own(patch, 'state') && !own(acknowledgements, 'state') || selected.state === '')) delete selected.state;
    return forms.validateAssistantSubmission(target, selected);
  }
  if (target.startsWith('business-action:') || ['shipment-create', 'shipment-metadata', 'shipment-event', 'campaign-draft'].includes(target)) {
    const allowed = new Set([...(forms.assistantFormDescriptor(target)?.fields || []), ...Object.keys(acknowledgements), ...Object.keys(fixed).filter(key => !['businessSettings', 'policyId', 'shipment'].includes(key)), 'version']);
    if (target === 'campaign-draft') {
      const fields = new Set(forms.assistantSubmissionFields(target));
      const configuration = forms.validateAssistantSubmission(target, Object.fromEntries(Object.entries(payload).filter(([key]) => fields.has(key))));
      return { ...configuration, ...(entityId ? { id: entityId, version: recordVersion } : {}) };
    }
    if (target === 'shipment-create') allowed.add('orderId');
    return forms.validateAssistantSubmission(target, Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.has(key))));
  }
  return payload;
}
async function previewFor(tx, target, payload, session) {
  if (target !== 'business-action:payroll-confirm' && target !== 'business-action:cash-close') return null;
  const inputs = target === 'business-action:cash-close'
    ? { accountId: payload.accountId, closingOn: payload.closingOn }
    : Object.fromEntries(['personId', 'startOn', 'endOnExclusive', 'bonusMinor', 'discountMinor', 'reason'].filter(key => own(payload, key)).map(key => [key, payload[key]]));
  if ((target.endsWith('cash-close') ? ['accountId', 'closingOn'] : ['personId', 'startOn', 'endOnExclusive']).some(key => inputs[key] == null || inputs[key] === '')) return null;
  const facade = transactionStore(tx);
  const result = target.endsWith('cash-close') ? await getCashClosingPreview(facade, inputs) : await finance.preparePayroll(facade, inputs, session.user.id);
  const revision = Number((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`))?.value || 0);
  return { inputs, result, revision, digest: hash({ inputs, result, revision }) };
}
function verifiedAutomatic(target, original, patch, sourceRefs, origin, evidence, form, intent, references) {
  if (!original.id || (original.status ?? original.state) !== 'draft' || form?.dirty || form?.busy || !AUTO_FIELDS[target]) return false;
  if (form && (form.entityId !== original.id || form.recordVersion !== original.version)) return false;
  if (!['save', 'update', 'change', 'correct', 'append', 'guardar', 'actualizar', 'cambiar', 'corregir', 'añadir', 'agregar'].includes(String(intent).toLocaleLowerCase('es'))) return false;
  const message = origin.data.message, fields = Object.keys(patch), verbs = 'guarda|actualiza|cambia|corrige|añade|agrega';
  if (typeof message !== 'string' || !fields.length || fields.some(field => !AUTO_FIELDS[target].includes(field) || typeof patch[field] !== 'string')) return false;
  const aliases = {
    title: ['título', 'nombre', ...(target === 'record:faqs' ? ['pregunta'] : [])],
    description: ['descripción'], presentation: ['presentación'], flavor: ['sabor'],
    productInfo: ['información del producto', 'ficha técnica'], conditions: ['condiciones'],
    answer: ['respuesta'], body: ['texto', 'mensaje', 'cuerpo'], buttonText: ['texto del botón', 'botón'],
    zone: ['zona'], costText: ['costo', 'texto de costo'], estimatedTime: ['tiempo estimado', 'plazo'],
    cashOnDelivery: ['contraentrega', 'contra entrega'], details: ['detalles'],
    name: ['nombre'], caption: ['texto', 'caption'], headline: ['título', 'encabezado'],
  };
  const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phrase = value => escaped(value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es'))
    .replace(/[aeioun]/g, char => ({ a: '[aá]', e: '[eé]', i: '[ií]', o: '[oó]', u: '[uúü]', n: '[nñ]' })[char]).replace(/\s+/g, '\\s+');
  const fieldPattern = (field, extra = []) => [...new Set([field, forms.assistantFieldLabel(target, field), ...(aliases[field] || []), ...extra])]
    .sort((left, right) => right.length - left.length).map(phrase).join('|');
  const namedEntities = [], kind = target === 'campaign-draft' ? 'campaign' : target;
  const matchEntity = (selector, record, recordKind) => {
    let selected = selector.trim();
    const closing = { '"': '"', "'": "'", '“': '”', '«': '»' }[selected[0]];
    if (closing && selected.at(-1) === closing) selected = selected.slice(1, -1).trim();
    if (selected === record.id) return true;
    for (const label of [record.title, record.name].filter(Boolean)) {
      if (label === selected) {
        namedEntities.push({ kind: recordKind, id: record.id, label });
        return true;
      }
    }
    return false;
  };
  let selectedTarget = false;
  const matchTarget = selector => {
    if (selector == null) return Boolean(form || selectedTarget);
    if (!matchEntity(selector, original, kind)) return false;
    selectedTarget = true;
    return true;
  };
  const proofs = [], copies = [];
  for (const field of fields) {
    const refs = sourceRefs.filter(ref => plain(ref) && ref.field === field);
    if (refs.length !== 1) return false;
    const ref = refs[0];
    if (ref.turnId === origin.id && Number.isSafeInteger(ref.start) && Number.isSafeInteger(ref.end)
      && ref.start > 0 && ref.end > ref.start && ref.end < message.length && message.slice(ref.start, ref.end) === patch[field]) {
      const opening = message[ref.start - 1], closing = { '"': '"', "'": "'", '“': '”', '«': '»' }[opening];
      if (!closing || message[ref.end] !== closing || patch[field].includes(closing)) return false;
      proofs.push({ field, start: ref.start, end: ref.end });
    } else {
      const fact = evidence.find(item => item.id === ref.evidenceId), sourceRef = references.find(item => item.id === fact?.entityId);
      if (!fact || !sourceRef?.value || fact.coverage?.state !== 'complete' || fact.field !== (ref.sourceField || field)
        || fact.value !== patch[field] || valueAt(sourceRef.value, fact.field) !== fact.value) return false;
      copies.push({ field, fact, sourceRef });
    }
  }
  const article = '(?:(?:el|la|los|las)\\s+)?', connector = '(?:\\s*[:=]|\\s+(?:a|por|con))\\s*';
  if (copies.length) {
    if (fields.length !== 1 || proofs.length) return false;
    const { field, fact, sourceRef } = copies[0];
    const expression = new RegExp(`^\\s*(?:${verbs})\\s+${article}(?:${fieldPattern(field)})(?:\\s+(?:de|del)\\s+(?<entity>.+?))?${connector}copia\\s+${article}(?:${fieldPattern(fact.field, [fact.label])})\\s+(?:de|del)\\s+(?<source>.+?)[.!]?\\s*$`, 'iu');
    const match = expression.exec(message);
    if (!match || !matchTarget(match.groups.entity) || !matchEntity(match.groups.source, sourceRef.value, sourceRef.kind)) return false;
  } else {
    proofs.sort((left, right) => left.start - right.start);
    let cursor = 0;
    for (let index = 0; index < proofs.length; index++) {
      const proof = proofs[index];
      if (proof.start - 1 < cursor) return false;
      const lead = index === 0 ? `\\s*(?:${verbs})\\s+` : `\\s*(?:;|,?\\s+y)\\s*(?:(?:${verbs})\\s+)?`;
      const expression = new RegExp(`^${lead}${article}(?:${fieldPattern(proof.field)})(?:\\s+(?:de|del)\\s+(?<entity>.+?))?${connector}$`, 'iu');
      const match = expression.exec(message.slice(cursor, proof.start - 1));
      if (!match || !matchTarget(match.groups.entity)) return false;
      cursor = proof.end + 1;
    }
    if (!/^\s*[.!]?\s*$/.test(message.slice(cursor))) return false;
  }
  if (!form && (!selectedTarget || !evidence.some(fact => fact.entityId === original.id && fact.recordVersion === original.version))) return false;
  return { namedEntities };
}
async function normalizedProposalPayload(tx, target, payload, original, entityId) {
  if (target !== 'campaign-draft') return { payload, moneyCurrency: { before: 'COP', after: 'COP' } };
  const allowed = new Set(forms.assistantSubmissionFields(target));
  const configuration = forms.validateAssistantSubmission(target, Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.has(key))));
  const connection = configuration.connectionId ? await getSocialConnection(tx, configuration.connectionId) : null;
  const normalized = normalizeSocialCampaignInput(configuration, { previous: entityId ? original : null, connection });
  const submission = forms.validateAssistantSubmission(target, Object.fromEntries(Object.entries(normalized).filter(([key]) => allowed.has(key))));
  return { payload: { ...submission, ...(entityId ? { id: entityId, version: payload.version } : {}) },
    moneyCurrency: { before: knownCurrency(original.currency), after: knownCurrency(normalized.currency) } };
}
async function validateReadyPayload(tx, target, payload, original, entityId) {
  if (target.startsWith('record:')) { validateRecord(target.slice(7), payload); await tx.validateRelations(target.slice(7), payload, entityId); }
  else if (target === 'order') await validateOrder(payload, (kind, id) => tx.get(kind, id), entityId ? original : null, { resolveSeller: id => getResource(tx, 'people', id) });
  else if (target === 'shipment-create' || target === 'shipment-metadata') validateShipmentMetadata(payload, original);
  else if (target === 'campaign-draft') {
    const normalized = await normalizedProposalPayload(tx, target, payload, original, entityId);
    if (!same(normalized.payload, payload)) throw Object.assign(assistantError('La normalización del borrador cambió; revisa de nuevo su efecto.'), { businessConflict: true });
  }
}

export async function prepareAssistantChange(store, session, { threadId, turnId, target, entityId = null, patch, sourceRefs = [], formContext = null, intent = '' }) {
  if (!forms.assistantFormDescriptor(target)) denied('Formulario no asistible.');
  if (!Array.isArray(sourceRefs) || sourceRefs.length > 100) fail('Referencias de origen no válidas.');
  for (const ref of sourceRefs) {
    if (typeof ref === 'string') { text(ref, 'Evidencia', 120, true); continue; }
    if (!plain(ref) || typeof ref.field !== 'string' || Object.keys(ref).some(key => !['field', 'turnId', 'start', 'end', 'evidenceId', 'sourceField'].includes(key))) fail('Origen de campo no válido.');
    if (ref.turnId != null) { text(ref.turnId, 'Turno de origen', 120, true); integer(ref.start, 'Inicio del texto', 0, 8000); integer(ref.end, 'Fin del texto', 1, 8000); }
    else text(ref.evidenceId, 'Evidencia de origen', 120, true);
  }
  if (target === 'asset-metadata' && entityId != null) denied('El nombre del activo se completa únicamente en el formulario de carga humano.');
  const candidate = safeInput(patch);
  const sourceFields = new Set();
  for (const ref of sourceRefs.filter(item => plain(item))) {
    let value = candidate;
    for (const part of ref.field.split('.')) {
      if (!value || typeof value !== 'object' || !own(value, part) || ['__proto__', 'prototype', 'constructor'].includes(part)) fail('El origen no corresponde a un campo del parche.', 422);
      value = value[part];
    }
    if (sourceFields.has(ref.field)) fail('Cada campo necesita un único origen inequívoco.', 422);
    sourceFields.add(ref.field);
  }
  return store.transaction(async rawTx => {
    await assertAssistantSession(rawTx, session, { lock: true });
    const tx = transactionStore(rawTx), origin = await ownedOrigin(tx, session, threadId, turnId);
    await assertAssistantAccess(tx, session, origin.configuration_version);
    if (origin.state !== 'running' || Date.parse(origin.deadline_at) <= Date.now()) conflict('El turno ya no puede preparar cambios.');
    if (await tx.db.get(`SELECT id FROM ${tx.t('assistant_proposals')} WHERE turn_id=? AND user_id=? LIMIT 1`, [turnId, session.user.id])) conflict('Revisa un cambio por vez.');
    const operation = ['delete', 'remove', 'eliminar', 'borrar'].includes(intent) ? 'remove' : 'save';
    if (operation === 'remove' && (!target.startsWith('record:') || !entityId || !/^(?:elimina|borra)\b/iu.test(origin.data.message.trimStart()) || /[?¿]|\b(?:no|si|quizá|podrías)\b/iu.test(origin.data.message))) denied('La eliminación requiere una orden explícita sobre contenido existente.');
    const identityField = target === 'shipment-create' ? 'orderId' : target === 'business-action:cash-close' ? 'accountId' : ACTION_PRIMARY[target.slice(16)]?.[1];
    if (entityId == null && identityField && typeof candidate[identityField] === 'string') entityId = candidate[identityField];
    const rawForm = formContext?.form || (formContext?.formId ? formContext : null);
    const loaded = await loadTarget(tx, target, entityId, rawForm);
    const recordVersion = loaded.primary?.version ?? (target === 'storefront-settings' ? loaded.original.version : rawForm?.recordVersion ?? null);
    const form = bindForm(formContext, target, entityId, recordVersion);
    const values = form ? forms.serializeAssistantForm(target, safeInput(form.values)) : {};
    const referenceInput = { ...loaded.original, ...values, ...candidate, ...Object.fromEntries(Object.entries(loaded.fixed).filter(([key]) => !['businessSettings', 'policyId', 'shipment'].includes(key))) };
    if (loaded.primary?.kind === 'shipment' && loaded.primary.value.orderId) referenceInput.orderId = loaded.primary.value.orderId;
    const resolved = await referencesFor(tx, referenceInput, { primary: loaded.primary, existing: loaded.primary ? [loaded.primary] : [] });
    const cleanPatch = forms.filterAssistantPatch(target, candidate, { baseline: values, referenceChoices: resolved.choices, requireKnownReferences: true, allowResolvedReferences: true });
    const evidence = Array.isArray(formContext?.evidence) ? formContext.evidence : [];
    const evidenceCurrencies = new Map();
    for (const ref of sourceRefs) if (typeof ref === 'string' && !evidence.some(fact => fact.id === ref) || plain(ref) && ref.evidenceId && !evidence.some(fact => fact.id === ref.evidenceId)) denied('La referencia de origen no pertenece a este turno.');
    for (const source of sourceRefs.filter(ref => plain(ref) && ref.evidenceId)) {
      const fact = evidence.find(item => item.id === source.evidenceId);
      if (!fact?.entityId || fact.coverage?.state !== 'complete') continue;
      const view = fact.href ? readAdminView(new URL(fact.href, 'https://assistant.invalid').searchParams) : null;
      let verified = null;
      if (fact.domain === 'catalog' && own(schemas, view?.section)) verified = await recordReference(tx, view.section, fact.entityId);
      else if (fact.domain === 'orders') verified = { ...await reference(tx, 'order', fact.entityId), value: await loadOrderData(tx, fact.entityId) };
      else if (fact.domain === 'advertising') {
        const row = await tx.db.get(`SELECT * FROM ${tx.t('social_campaigns')} WHERE id=?`, [fact.entityId]);
        if (row) verified = { kind: 'campaign', id: row.id, version: Number(row.version), digest: rowDigest(row), value: entity(row) };
      }
      if (verified) {
        if (verified.version !== fact.recordVersion || valueAt(verified.value, fact.field) !== fact.value) conflict('La fuente de copia cambió; vuelve a consultarla.');
        if (fact.domain === 'advertising') evidenceCurrencies.set(fact.id, knownCurrency(verified.value.currency));
        if (!resolved.references.some(ref => ref.kind === verified.kind && ref.id === verified.id)) resolved.references.push(verified);
      }
    }
    const proposed = target === 'campaign-draft' ? normalizePayload(target, loaded.original, values, cleanPatch, loaded.fixed, entityId, recordVersion) : null;
    let { moneyCurrency } = await normalizedProposalPayload(tx, target, proposed, loaded.original, entityId);
    const policy = currencyPolicy(moneyCurrency.after);
    const inputMessages = await economicInputMessages(tx, session, origin, target, sourceRefs, policy);
    const unproven = filterUnprovenFinancialFields(cleanPatch, { original: loaded.original, values, sourceRefs, evidence, inputMessages, policy, evidenceCurrencies });
    if (!Object.keys(cleanPatch).length && operation !== 'remove' && !unproven.length) denied('La propuesta no contiene campos modificables.');
    const before = { ...forms.serializeAssistantForm(target, loaded.original), ...values };
    let payload = humanOnly(target) ? { ...values, ...cleanPatch } : normalizePayload(target, loaded.original, values, cleanPatch, loaded.fixed, entityId, recordVersion);
    ({ payload, moneyCurrency } = await normalizedProposalPayload(tx, target, payload, loaded.original, entityId));
    if (target === 'campaign-draft') for (const field of Object.keys(cleanPatch)) if (own(payload, field)) cleanPatch[field] = payload[field];
    const missing = operation === 'remove' ? [] : [...new Set([...missingFields(target, payload, entityId), ...unproven])];
    if (!missing.length && !humanOnly(target) && operation !== 'remove') await validateReadyPayload(tx, target, payload, loaded.original, entityId);
    const refs = {};
    for (const ref of resolved.references) if (['order', 'shipment', 'expense', 'settlement', 'payroll', 'account', 'closing', 'entry', 'person', 'platform', 'source'].includes(ref.kind) && !refs[ref.kind]) refs[ref.kind] = publicRef(ref);
    if (payload.documentId) {
      const ref = resolved.references.find(item => item.id === payload.documentId);
      if (ref) {
        refs.document = publicRef(ref, payload.documentType);
        const parents = [['order', ref.value.orderId], ['settlement', ref.value.settlementId], ['expense', ref.value.expenseId], ['payroll', ref.value.payrollId], ['entry', ref.value.cashEntryId || (payload.documentType === 'payroll_payment' && ref.value.sourceType === 'payroll_payment' ? ref.value.id : null)]];
        for (const [role, id] of parents) if (id) {
          const parent = await reference(tx, role, id);
          refs[role] = publicRef(parent);
          if (!resolved.references.some(item => item.kind === parent.kind && item.id === id)) resolved.references.push(parent);
        }
      }
    }
    const preview = !missing.length ? await previewFor(tx, target, payload, session) : null;
    const autonomy = operation !== 'remove' && verifiedAutomatic(target, loaded.original, cleanPatch, sourceRefs, origin, evidence, form, intent, resolved.references);
    let automatic = Boolean(autonomy);
    if (automatic) for (const named of autonomy.namedEntities) {
      const duplicates = named.kind === 'campaign'
        ? await tx.db.get(`SELECT COUNT(*) AS n FROM ${tx.t('social_campaigns')} WHERE name=?`, [named.label])
        : await tx.db.get(`SELECT COUNT(*) AS n FROM ${tx.t('records')} WHERE kind=? AND title=?`, [named.kind.slice(7), named.label]);
      if (Number(duplicates.n) !== 1) { automatic = false; break; }
    }
    if (automatic && target === 'campaign-draft') {
      const baseline = normalizePayload(target, loaded.original, {}, {}, loaded.fixed, entityId, recordVersion);
      if (moneyCurrency.before !== moneyCurrency.after || forms.assistantSubmissionFields(target).some(field => !AUTO_FIELDS[target].includes(field) && !same(payload[field] ?? null, baseline[field] ?? null))) automatic = false;
    }
    if (automatic) {
      payload = normalizePayload(target, loaded.original, {}, cleanPatch, loaded.fixed, entityId, recordVersion);
      ({ payload, moneyCurrency } = await normalizedProposalPayload(tx, target, payload, loaded.original, entityId));
    }
    const baselinePayload = target === 'settings:policy' ? loaded.fixed.businessSettings
      : humanOnly(target) ? values : normalizePayload(target, loaded.original, {}, {}, loaded.fixed, entityId, recordVersion);
    const data = {
      configurationVersion: origin.configuration_version, target, entityId, recordVersion, moneyCurrency,
      formId: form?.formId ?? null, generation: form?.generation ?? null,
      open: opening(target, entityId, refs, payload, formContext?.view), patch: cleanPatch,
      missingFields: missing, diff: diffFor(target, before, cleanPatch),
      humanDiff: operation === 'remove' ? [{ field: 'operation', label: 'Efecto', before: loaded.original.title, after: 'Eliminar definitivamente este registro' }]
        : humanDiffFor(target, baselinePayload, payload, cleanPatch),
      execution: humanOnly(target) ? 'human-only' : missing.length ? 'prefill' : automatic ? 'automatic' : 'confirm',
      operation, payload, original: loaded.original, fixed: loaded.fixed,
      references: storedReferences(resolved.references), sourceRefs, preview, humanAcknowledgements: {},
    };
    data.payloadHash = hashAssistantProposalPayload(data);
    const saved = await saveAssistantProposal(tx, { userId: session.user.id, threadId, turnId, configurationVersion: origin.configuration_version, data });
    await assertAssistantSession(tx, session);
    return assistantProposalDTO(saved);
  });
}

function assertBinding(binding, data, { allowGenerationChange = false } = {}) {
  if (!plain(binding)) conflict('Falta el formulario vinculado.');
  for (const key of Object.keys(binding)) if (!['formId', 'target', 'entityId', 'recordVersion', 'generation'].includes(key)) denied('La vinculación contiene campos no permitidos.');
  text(binding.formId, 'Formulario', 100, true); integer(binding.generation, 'Generación', 0);
  if (binding.target !== data.target || (binding.entityId ?? null) !== data.entityId || (binding.recordVersion ?? null) !== data.recordVersion || data.formId && binding.formId !== data.formId || !allowGenerationChange && data.generation != null && binding.generation !== data.generation) conflict('La propuesta corresponde a otro formulario o revisión.');
}
export async function assertAssistantProposalFresh(tx, data) {
  for (const ref of data.references || []) {
    let current;
    try {
      if (ref.kind.startsWith('record:')) current = await recordReference(tx, ref.kind.slice(7), ref.id);
      else if (ref.kind === 'business_settings') { const value = await getBusinessSettings(tx); current = { version: value.version, digest: hash(value) }; }
      else if (ref.kind === 'campaign') { const row = await tx.db.get(`SELECT * FROM ${tx.t('social_campaigns')} WHERE id=?`, [ref.id]); current = row ? { version: Number(row.version), digest: rowDigest(row) } : null; }
      else if (ref.kind === 'alert' || ref.kind === 'alert-rule') { const value = ref.kind === 'alert' ? await getAlert(tx, ref.id) : await getAlertRule(tx, ref.id); current = { version: value.version, digest: hash(value) }; }
      else current = await reference(tx, ref.kind, ref.id);
    } catch (error) { if (error.status !== 404) throw error; }
    if (!current || current.version !== ref.version || current.digest !== ref.digest) throw Object.assign(assistantError('Los datos cambiaron; vuelve a preparar y revisar el cambio.'), { businessConflict: true });
  }
  if (data.target === 'storefront-settings' && (await tx.settings()).version !== data.recordVersion) throw Object.assign(assistantError('La configuración de vitrina cambió.'), { businessConflict: true });
}
function assertPending(row, version) {
  if (!row) fail('Propuesta no encontrada.', 404);
  if (row.version !== version || !['prepared', 'applied'].includes(row.state)) conflict('La propuesta ya cambió o no está pendiente.');
}
async function markStale(store, session, proposalId, version) {
  await store.transaction(async tx => {
    await assertAssistantSession(tx, session, { lock: true });
    const row = await getAssistantProposal(tx, { userId: session.user.id, proposalId });
    if (row && row.version === version && ['prepared', 'applied'].includes(row.state)) await transitionAssistantProposal(tx, { userId: session.user.id, proposalId, version, state: 'stale' });
  });
}

export async function reviseAssistantProposal(store, session, { proposalId, version, requestId, formBinding, payload, humanAcknowledgements = {} }) {
  integer(version, 'Versión', 1); text(requestId, 'Solicitud', 100, true);
  const supplied = safeInput(payload), acknowledgements = forms.validateAssistantHumanAcknowledgements(formBinding?.target, humanAcknowledgements);
  const revisionDigest = hash({ proposalId, version, formBinding, payload: supplied, humanAcknowledgements: acknowledgements });
  return store.transaction(async rawTx => {
    await assertAssistantSession(rawTx, session, { lock: true });
    const tx = transactionStore(rawTx), row = await getAssistantProposal(tx, { userId: session.user.id, proposalId });
    if (!row) fail('Propuesta no encontrada.', 404);
    if (row.data.lastRevisionRequestId === requestId) {
      if (row.data.lastRevisionDigest !== revisionDigest) conflict('La revisión ya se recibió con datos distintos.');
      return row.data.lastRevisionResponse;
    }
    assertPending(row, version);
    await assertAssistantAccess(tx, session, row.configuration_version);
    const origin = await ownedOrigin(tx, session, row.thread_id, row.turn_id);
    if (origin.state !== 'completed' || origin.data.publicResult?.proposal?.id !== proposalId) conflict('El turno no ha finalizado o fue cancelado.');
    assertBinding(formBinding, row.data, { allowGenerationChange: true });
    await assertAssistantProposalFresh(tx, row.data);
    if (humanOnly(row.data.target)) denied('Este formulario conserva su guardado humano original.');
    if (row.data.operation === 'remove') denied('Confirma la eliminación desde su propuesta; Guardar formulario no elimina registros.');
    const normalized = forms.validateAssistantSubmission(row.data.target, supplied);
    const creation = creationTarget(row.data.target, row.data.entityId);
    if (own(supplied, 'id') && supplied.id !== row.data.entityId || own(normalized, 'version') && !creation && normalized.version !== row.data.recordVersion) conflict('No puedes cambiar la identidad o versión de la propuesta.');
    for (const [field, value] of Object.entries(row.data.fixed)) if (!['businessSettings', 'policyId', 'shipment'].includes(field) && own(normalized, field) && normalized[field] !== value) conflict('No puedes cambiar las referencias fijas de la propuesta.');
    let nextPayload = normalizePayload(row.data.target, row.data.original, normalized, {}, row.data.fixed, row.data.entityId, row.data.recordVersion, acknowledgements);
    const canonical = await normalizedProposalPayload(tx, row.data.target, nextPayload, row.data.original, row.data.entityId);
    nextPayload = canonical.payload;
    const values = forms.serializeAssistantForm(row.data.target, nextPayload);
    const resolved = await referencesFor(tx, nextPayload, { existing: row.data.references });
    const missing = missingFields(row.data.target, nextPayload, row.data.entityId);
    if (!missing.length) await validateReadyPayload(tx, row.data.target, nextPayload, row.data.original, row.data.entityId);
    const preview = !missing.length ? await previewFor(tx, row.data.target, nextPayload, session) : null;
    const unchanged = row.data.reviewBase == null && same(nextPayload, row.data.payload) && same(preview, row.data.preview) && same(canonical.moneyCurrency, row.data.moneyCurrency);
    if (unchanged && row.data.formId === formBinding.formId && row.data.generation === formBinding.generation) {
      const response = { proposal: assistantProposalDTO(row), unchanged: true };
      const data = { ...row.data, lastRevisionRequestId: requestId, lastRevisionDigest: revisionDigest, lastRevisionResponse: response };
      await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET data=? WHERE id=? AND user_id=? AND version=?`, [JSON.stringify(data), proposalId, session.user.id, version]);
      await assertAssistantSession(tx, session);
      return response;
    }
    const fields = forms.assistantFormDescriptor(row.data.target).patchFields;
    const patch = { ...row.data.patch };
    for (const field of fields) if (own(values, field) && (!same(values[field], row.data.original[field] ?? null) || own(patch, field))) patch[field] = values[field];
    const beforeHuman = row.data.target === 'campaign-draft'
      ? normalizePayload(row.data.target, row.data.original, {}, {}, row.data.fixed, row.data.entityId, row.data.recordVersion) : row.data.payload;
    const humanDiff = humanDiffFor(row.data.target, beforeHuman, nextPayload, patch);
    const next = {
      ...row.data, payload: nextPayload, reviewBase: null, moneyCurrency: canonical.moneyCurrency, patch, diff: diffFor(row.data.target, row.data.original, patch), humanDiff,
      formId: formBinding.formId, generation: formBinding.generation, missingFields: missing,
      execution: missing.length ? 'prefill' : 'confirm', humanAcknowledgements: acknowledgements,
      references: storedReferences(resolved.references), preview,
    };
    next.payloadHash = hashAssistantProposalPayload(next);
    const response = { proposal: assistantProposalDTO({ ...row, version: row.version + 1, state: 'prepared', data: next }), unchanged };
    Object.assign(next, { lastRevisionRequestId: requestId, lastRevisionDigest: revisionDigest, lastRevisionResponse: response });
    await transitionAssistantProposal(tx, { userId: session.user.id, proposalId, version, state: 'prepared', data: next });
    await assertAssistantSession(tx, session);
    return response;
  }).catch(async error => {
    if (error.businessConflict) await markStale(store, session, proposalId, version);
    throw error;
  });
}

async function mutate(tx, session, row) {
  const { target, entityId, recordVersion, payload } = row.data, input = { ...payload, requestId: row.id }, actorId = session.user.id;
  if (row.data.operation === 'remove') return runCommand(tx, { scope: `assistant:content-remove:${target.slice(7)}`, requestId: row.id, payload: { entityId, recordVersion }, actorId, affectsIndicators: false }, store => store.remove(target.slice(7), entityId, recordVersion));
  if (target.startsWith('record:')) return runCommand(tx, { scope: `assistant:content:${target.slice(7)}`, requestId: row.id, payload, actorId, affectsIndicators: false }, store => store.saveTx(target.slice(7), payload, entityId, recordVersion, actorId));
  if (target === 'storefront-settings') return runCommand(tx, { scope: 'assistant:storefront-settings', requestId: row.id, payload, actorId, affectsIndicators: false }, store => store.saveSettings(payload, recordVersion));
  if (target === 'order') return tx.saveOrder(input, actorId, entityId, recordVersion);
  if (target.startsWith('settings:') && RESOURCES[target.slice(9)]) return saveResource(tx, RESOURCES[target.slice(9)], input, actorId, entityId);
  if (target === 'settings:policy' || target === 'settings:preferences') return saveBusinessSettings(tx, input, actorId);
  if (target === 'settings:alert-rule') return saveAlertRule(tx, input, actorId, entityId);
  if (target === 'settings:alert') return updateAlert(tx, input, actorId, entityId);
  if (target === 'shipment-create') return saveShipment(tx, input, actorId);
  if (target === 'shipment-metadata') return saveShipment(tx, input, actorId, entityId);
  if (target === 'shipment-event') return recordShipmentEvent(tx, entityId, input, actorId);
  if (target === 'campaign-draft') return saveSocialCampaign(tx, input, actorId);
  if (target === 'business-action:account-save') return saveAccount(tx, input, actorId, entityId);
  if (target.startsWith('business-action:') && own(FINANCIAL, target.slice(16))) return FINANCIAL[target.slice(16)](tx, input, actorId);
  denied('Esta propuesta solo puede completarse en su formulario original.');
}
function executionReceipt(row, result, at) {
  const target = row.data.target, actual = result.receipt || result.payment || result;
  const identity = actual.id || actual.transferId || actual.shipmentId || row.data.entityId || null;
  const entityId = identity == null ? null : String(identity);
  let view = row.data.open.view;
  if (target === 'order' || target.startsWith('record:') || target === 'campaign-draft') view = readAdminView({ ...view, record: entityId || '' });
  if (target === 'shipment-create' || target.startsWith('shipment-')) view = readAdminView({ section: 'orders', tab: 'shipments', record: entityId || '' });
  if (row.data.operation === 'remove') view = readAdminView({ ...view, record: '' });
  if (target.startsWith('settings:') && !['settings:policy', 'settings:preferences'].includes(target) || target === 'business-action:account-save') view = readAdminView({ ...view, record: entityId || '' });
  if (row.data.open.owner === 'cash') {
    const action = target.slice(16);
    if (result.order) view = readAdminView({ section: 'orders', tab: 'list', record: result.order.id });
    else if (result.settlement || action.startsWith('settlement-') || row.data.payload.documentType === 'settlement') view = readAdminView({ section: 'cash', tab: 'settlements', record: result.settlement?.id || entityId });
    else if (result.expense || ['expense', 'expense-recovery', 'pay-expense'].includes(action)) view = readAdminView({ section: 'cash', tab: 'expenses', record: result.expense?.id || entityId });
    else if (action.startsWith('payroll-') || row.data.payload.documentType === 'payroll_payment') view = readAdminView({ section: 'cash', tab: 'payroll', record: result.payroll?.id || entityId });
    else if (['cash-close', 'cash-reopen'].includes(action)) view = readAdminView({ section: 'cash', tab: 'overview', record: entityId, account: actual.accountId });
    else {
      const entry = result.entries?.[0] || actual;
      view = readAdminView({ section: 'cash', tab: 'movements', record: entry.id || '', account: entry.accountId || '' });
    }
  }
  return { id: row.id, proposalId: row.id, operation: row.data.operation === 'remove' ? 'remove' : target.startsWith('business-action:') ? target.slice(16) : row.data.entityId ? 'update' : 'create', target, entityId, recordVersion: actual.version ?? null, committedAt: at, summary: row.data.operation === 'remove' ? 'Contenido eliminado del negocio.' : target.startsWith('business-action:') ? 'Operación registrada y confirmada en el negocio.' : 'Cambio guardado en el negocio.', href: adminHref(view) };
}

export async function executeAssistantProposal(store, session, { proposalId, version, requestId, confirmation = null }) {
  integer(version, 'Versión', 1); text(proposalId, 'Propuesta', 120, true);
  if (requestId !== proposalId) conflict('La identidad de ejecución debe ser la propuesta.');
  if (confirmation !== null && (!plain(confirmation) || Object.keys(confirmation).some(key => !['proposalId', 'payloadHash'].includes(key)))) denied('Confirmación no válida.');
  const executionDigest = hash({ decision: 'execute', proposalId, version, confirmation });
  try {
    const response = await store.transaction(async rawTx => {
      await assertAssistantSession(rawTx, session, { lock: true });
      const tx = transactionStore(rawTx), row = await getAssistantProposal(tx, { userId: session.user.id, proposalId });
      if (!row) fail('Propuesta no encontrada.', 404);
      // An acknowledged commit is recovered before configuration or business freshness.
      const recovered = await recoverAssistantExecution(tx, { userId: session.user.id, proposalId, executionDigest });
      if (recovered) { await assertAssistantSession(tx, session); return recovered; }
      assertPending(row, version);
      await assertAssistantAccess(tx, session, row.configuration_version);
      const origin = await ownedOrigin(tx, session, row.thread_id, row.turn_id);
      if (origin.state !== 'completed' || origin.data.publicResult?.proposal?.id !== proposalId) conflict('El turno no ha finalizado o ya fue cancelado.');
      if (humanOnly(row.data.target) || !['automatic', 'confirm'].includes(row.data.execution) || row.data.missingFields.length) denied('Completa y revisa el formulario antes de guardar.');
      if (row.data.payloadHash !== hashAssistantProposalPayload(row.data)) conflict('El contenido de la propuesta cambió.');
      if (row.data.execution !== 'automatic' && (confirmation?.proposalId !== proposalId || confirmation?.payloadHash !== row.data.payloadHash)) denied('Confirma el cambio exacto que estás revisando.');
      if (confirmation && (confirmation.proposalId !== proposalId || confirmation.payloadHash !== row.data.payloadHash)) conflict('La confirmación corresponde a otro contenido.');
      await assertAssistantProposalFresh(tx, row.data);
      if (row.data.preview) {
        const current = await previewFor(tx, row.data.target, row.data.payload, session);
        if (!current || current.digest !== row.data.preview.digest) throw Object.assign(assistantError('La revisión financiera cambió; vuelve a preparar el cálculo.'), { businessConflict: true });
      } else if (['business-action:cash-close', 'business-action:payroll-confirm'].includes(row.data.target)) denied('Falta la revisión financiera vigente.');
      let result;
      try { result = await mutate(tx, session, row); }
      catch (error) { if (error.status === 409) error.businessConflict = true; throw error; }
      const at = stamp(), receipt = executionReceipt(row, result, at);
      const response = JSON.parse(JSON.stringify({ result, receipt }));
      await audit(tx, { entityType: row.data.target, entityId: receipt.entityId || row.id, actorId: session.user.id, previous: row.data.original, next: result, reason: 'Cambio confirmado mediante Ali.', source: 'assistant', recordedAt: at });
      await recordAssistantExecution(tx, { userId: session.user.id, proposalId, version, executionDigest, executionRequestId: requestId, response, sessionTokenHash: session.sessionTokenHash, at });
      // An expiry/revocation here rolls back both the business mutation and its receipt.
      await assertAssistantSession(tx, session);
      return response;
    });
    if (response.receipt.target === 'record:products') {
      await (async () => {
        const row = await getAssistantProposal(store, { userId: session.user.id, proposalId });
        const oldImage = row?.data.original.image;
        if (oldImage && (row.data.operation === 'remove' || oldImage !== response.result.image)) await removeUnusedProductImage(store, oldImage);
      })().catch(error => console.error('No se pudo liberar una imagen de producto:', error.code || error.name || 'unknown'));
    }
    return response;
  } catch (error) {
    if (error.businessConflict) await markStale(store, session, proposalId, version);
    throw error;
  }
}
