import { assertCashClosingRequirementsTx, cashClosingDate, getCashClosingPreviewTx } from '../business/cash.mjs';
import { formatMoneyMinor, MAX_MONEY_MINOR, moneyMinor, parseMoneyMinor } from '../business/money.mjs';
import { fail } from '../validation-core.mjs';

const capabilityId = 'cash.close-day';
const overview = { section: 'cash', tab: 'overview' };
const cop = minor => `${formatMoneyMinor(minor)} COP`;
const dateLabel = 'Fecha del cierre (Bogotá)';
const fact = (label, value) => ({ label, value });
const amounts = (expected, counted, difference) => [fact('Saldo esperado', cop(expected)),
  ...(counted === undefined ? [] : [fact('Efectivo contado', cop(counted)), fact('Diferencia', cop(difference))])];

function progress(task, data, status, step, message, details = {}) {
  return { ...task, status, step, data: { ...data, progress: { message, ...details } } };
}

function question(task, field, prompt, options) {
  return { id: `${task.id}:${field}`, field, prompt, type: options ? 'choice' : 'text', ...(options && { options }) };
}

function action(focus, label, selection = null) {
  const account = selection?.accountId ?? selection?.id;
  const view = account ? { ...overview, account, record: selection.id } : overview;
  return { capabilityId, view, focus, label, selection };
}

const accountRef = account => ({ kind: 'cash-account', id: account.id, version: account.version });

async function activeCashOptions(tx, exclude) {
  const rows = await tx.db.all(`SELECT id,name FROM ${tx.t('cash_accounts')} WHERE type='cash' AND active=1 ORDER BY name,id`);
  const names = new Map();
  for (const { name } of rows) names.set(name, (names.get(name) ?? 0) + 1);
  return rows.filter(row => row.id !== exclude).map(({ id, name }) => ({ id, label: names.get(name) === 1 ? name : `${name} · ${id}` }));
}

async function configure(task, tx, data, message, { account, excluded, known = [], choices } = {}) {
  const options = choices ?? await activeCashOptions(tx, excluded);
  return progress(task, data, 'blocked', 'configure-account', message, {
    known,
    action: action('cash-close-account', account ? 'Configurar esta cuenta' : 'Abrir el formulario de una caja de efectivo', account ? accountRef(account) : null),
    ...(options.length && { question: question(task, 'accountId', '¿Prefieres elegir otra caja activa?', options) }),
  });
}

function askDate(task, data, known, message = 'Indica la fecha real del cierre. No la deduzco de la fecha de hoy.') {
  return progress(task, data, 'waiting_input', 'ask-date', message, {
    known, question: question(task, 'closingOn', '¿Para qué fecha quieres cerrar esta caja? Escribe AAAA-MM-DD.'),
  });
}

async function currentClosing(tx, accountId, closingOn) {
  return tx.db.get(`SELECT c.id,c.version,c.revision,c.recorded_at,c.expected_minor,c.counted_minor,c.difference_minor,
    u.id AS author_id,u.email AS author_name FROM ${tx.t('cash_closings')} c
    LEFT JOIN ${tx.t('users')} u ON u.id=(SELECT a.actor_id FROM ${tx.t('business_audit')} a
      WHERE a.entity_type='cash_closing' AND a.entity_id=c.id ORDER BY a.recorded_at,a.id LIMIT 1)
    WHERE c.account_id=? AND c.closing_on=? AND c.state='closed' ORDER BY c.revision DESC LIMIT 1`, [accountId, closingOn]);
}

async function observeClosing(tx, session, task, data, accountId, closingOn, known) {
  const record = await currentClosing(tx, accountId, closingOn);
  if (!record) return null;
  const author = record.author_id === session.user.id ? 'Tú' : record.author_name;
  const message = author === 'Tú' ? 'Tu cierre está registrado y vigente.' : 'Ya hay un cierre vigente para esta cuenta y fecha. Ali no registró otro cierre.';
  return progress(task, data, 'completed', 'closed', message, {
    known: [...known, fact(dateLabel, closingOn), ...amounts(record.expected_minor, record.counted_minor, record.difference_minor),
      fact('Revisión del cierre', String(record.revision)), fact('Registrado por', author ?? 'No consta un autor acreditado')],
    proof: { kind: 'record', label: 'Cierre vigente de caja', entityId: record.id, recordVersion: record.version, committedAt: record.recorded_at },
    action: action('cash-close-proof', 'Ver el cierre registrado', { kind: 'cash-closing', id: record.id, version: record.version, accountId, closingOn }),
  });
}

export async function resolveAdvisorCash(tx, session, task) {
  const { data } = task;
  if (task.status === 'cancelled') return progress(task, data, 'cancelled', task.step, 'La tarea se canceló; Ali no registró un cierre.');
  const state = data.cash ?? {};
  const { accountId, closingOn, countedMinor } = state;
  const account = accountId ? await tx.db.get(`SELECT id,name,type,active,version,opening_on FROM ${tx.t('cash_accounts')} WHERE id=?`, [accountId]) : null;
  const known = account ? [fact('Cuenta', account.name)] : [];
  if (accountId && closingOn) {
    const observed = await observeClosing(tx, session, task, data, accountId, closingOn, known);
    if (observed) return observed;
  }
  if (task.status === 'completed') {
    return progress(task, data, 'completed', 'closed', 'El cierre comprobado al terminar la tarea ya no está vigente. Esta tarea está terminada; la reapertura se gestiona por separado.', { known });
  }

  if (!account || account.type !== 'cash') {
    const options = await activeCashOptions(tx);
    if (!options.length) return configure(task, tx, data, 'Necesitas una cuenta activa de efectivo con una apertura registrada y un responsable activo.', { choices: options });
    const message = accountId ? 'La cuenta elegida ya no es una caja disponible. Elige otra cuenta activa de efectivo.' : 'Elige la cuenta de efectivo que quieres contar y cerrar.';
    return progress(task, data, 'waiting_input', 'select-account', message, { question: question(task, 'accountId', '¿Qué caja quieres cerrar?', options) });
  }
  if (!account.active) {
    return configure(task, tx, data, 'La caja elegida está archivada. Para cerrarla, primero debes reactivarla o escoger otra.', { account, excluded: account.id, known });
  }

  let preview;
  try {
    if (!closingOn) await assertCashClosingRequirementsTx(tx, account.id);
    else preview = await getCashClosingPreviewTx(tx, { accountId, closingOn }, { review: true });
  } catch (error) {
    if (error.code === 'CASH_OPENING_REQUIRED') {
      return configure(task, tx, data, 'Esta caja no tiene una apertura registrada. No se puede inventar ese saldo ni reescribir la apertura: elige otra caja o abre una nueva con su saldo inicial confirmado.', { excluded: account.id, known });
    }
    if (error.code === 'CASH_RESPONSIBLE_REQUIRED') {
      return configure(task, tx, data, 'La caja necesita una persona responsable activa. Asigna una en el formulario de esta cuenta y vuelve a la tarea.', { account, excluded: account.id, known });
    }
    if (error.code === 'CASH_DATE_ALREADY_CLOSED') {
      // A close can be committed between the first lookup and the preview in a writer transaction.
      const observed = await observeClosing(tx, session, task, data, accountId, closingOn, known);
      if (observed) return observed;
    }
    if (error.code === 'CASH_BEFORE_OPENING' || error.code === 'CASH_DATE_ALREADY_CLOSED') {
      const message = error.code === 'CASH_BEFORE_OPENING' ? 'La fecha elegida es anterior a la apertura de esta cuenta.' : 'Un cierre posterior ya cubre esa fecha. Esta tarea no reabre cierres; si quieres cerrar otro día, indica su fecha.';
      return askDate(task, { ...data, cash: { accountId } }, [...known, fact('Apertura', account.opening_on)], message);
    }
    throw error;
  }
  if (!preview) return askDate(task, data, [...known, fact('Apertura', account.opening_on)]);

  known.push(fact(dateLabel, closingOn));
  const difference = countedMinor === undefined ? null : countedMinor - preview.expectedMinor;
  if (difference === null || Math.abs(difference) > MAX_MONEY_MINOR) {
    return progress(task, { ...data, cash: { accountId, closingOn } }, 'waiting_input', 'count-cash',
      difference === null ? 'Cuenta físicamente el efectivo de la caja. El saldo esperado no reemplaza el conteo.' : 'La diferencia excede el límite monetario. Revisa y vuelve a indicar el conteo físico.', {
        known: [...known, ...amounts(preview.expectedMinor)],
        question: question(task, 'countedMinor', '¿Cuánto efectivo contaste en COP? Por ejemplo, 98.000; escribe 0 si no había efectivo.'),
      });
  }
  return progress(task, data, 'waiting_human', 'review-close', 'Compara los importes. Solo el formulario de Caja registra el cierre; la diferencia se conserva sin ajustar el dinero.', {
    known: [...known, ...amounts(preview.expectedMinor, countedMinor, difference)],
    action: action('cash-close-form', 'Abrir y revisar el cierre', {
      kind: 'cash-account', id: preview.accountId, version: preview.accountVersion, closingOn, countedMinor,
      expectedMinor: preview.expectedMinor, reviewKey: preview.reviewKey,
    }),
  });
}

export async function answerAdvisorCash(tx, session, current, input) {
  const data = { ...current.data };
  switch (input.field) {
    case 'accountId': {
      if (typeof input.value !== 'string' || !await tx.db.get(`SELECT id FROM ${tx.t('cash_accounts')} WHERE id=? AND type='cash' AND active=1`, [input.value])) {
        fail('Elige una cuenta de efectivo activa de la lista.', 422);
      }
      data.cash = { accountId: input.value };
      data.sourceRef = { kind: 'cash-account', id: input.value };
      break;
    }
    case 'closingOn':
      data.cash = { accountId: data.cash.accountId, closingOn: cashClosingDate(input.value) };
      break;
    case 'countedMinor':
      data.cash = { ...data.cash, countedMinor: moneyMinor(parseMoneyMinor(input.value), 'Efectivo contado') };
      break;
    default: fail('Respuesta no válida para esta tarea de caja.', 422);
  }
  return resolveAdvisorCash(tx, session, { ...current, data });
}
