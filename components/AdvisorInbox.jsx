'use client';

import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { BUSINESS_TIME_ZONE, instant } from '@/lib/business/dates.mjs';
import useDialog from './useDialog';
import styles from './AdvisorInbox.module.css';

const INBOX = '/api/admin/assistant/inbox';
const TASKS = '/api/admin/assistant/tasks';
const PAGE_SIZE = 20;
const SEVERITIES = { critical: 'Crítica', warning: 'Advertencia', info: 'Información' };
const SOURCE_NAMES = { alert: 'Alerta del negocio', import: 'Lote de importación' };
const DATE_TIME = new Intl.DateTimeFormat('es-CO', { timeZone: BUSINESS_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' });
const BOGOTA_WALL_TIME = new Intl.DateTimeFormat('sv-SE', {
  timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const CONFIRMATIONS = {
  create: { title: 'Crear recordatorio', submit: 'Guardar recordatorio', success: 'Guardaste el recordatorio.' },
  snooze: { title: 'Posponer aviso', submit: 'Posponer aviso', success: 'Pospusiste el aviso solo para ti.' },
  reschedule: { title: 'Reprogramar recordatorio', submit: 'Guardar nueva fecha', success: 'Reprogramaste el recordatorio.' },
  acknowledge: { title: 'Marcar recordatorio como atendido', submit: 'Marcar como atendido', success: 'El recordatorio quedó como atendido en tu historial.' },
  remove: { title: 'Eliminar recordatorio', submit: 'Eliminar recordatorio', success: 'Eliminaste el recordatorio de tu historial.' },
};
const getTaskPath = id => `${TASKS}/${encodeURIComponent(id)}`;
const taskLabel = task => task.data.label || SOURCE_NAMES[task.data.sourceRef?.kind] || 'Recordatorio personal';
const taskIsOpen = task => task.status !== 'completed' && task.status !== 'cancelled';
const hasDestination = action => Boolean(action?.orderId || action?.view);
const writeOptions = (method, payload) => ({ method, body: JSON.stringify(payload) });
const canRun = (event, callback) => { if (event.currentTarget.getAttribute('aria-disabled') !== 'true') callback(); };

function Stamp({ value }) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? <time dateTime={value}>{DATE_TIME.format(timestamp)} (Bogotá)</time> : 'Sin fecha disponible';
}

function GetState({ offline, error, loading, retry }) {
  if (!offline && !error && !loading) return null;
  return <div className={styles.readState}>
    <p>{offline ? 'Sin conexión. Vuelve a consultar cuando recuperes la conexión.' : error || 'Consultando…'}</p>
    {(offline || error) && <button type="button" className="button subtle" disabled={loading} onClick={retry}>Volver a consultar</button>}
  </div>;
}

function Pagination({ page, total, busy, onPage, label }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page <= 1 && pages <= 1) return null;
  return <nav className={styles.pagination} aria-label={label}>
    <span>Página {page}{page <= pages ? ` de ${pages}` : ''}</span>
    <div className={styles.actions}>
      <button type="button" className="button subtle" aria-disabled={busy || page <= 1} onClick={event => canRun(event, () => onPage(Math.min(page - 1, pages)))}>Anterior</button>
      <button type="button" className="button subtle" aria-disabled={busy || page >= pages} onClick={event => canRun(event, () => onPage(page + 1))}>Siguiente</button>
    </div>
  </nav>;
}

function useReminderRead(api, path, revision) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState(previous => ({ path, revision, data: previous?.path === path ? previous.data : null, loading: true, error: '' }));
    api(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ path, revision, data, loading: false, error: '' });
    }).catch(cause => {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: cause.message || 'No se pudieron consultar tus recordatorios.' }));
    });
    return () => controller.abort();
  }, [api, path, revision]);
  return [path && state?.path === path ? { ...state, loading: state.loading || state.revision !== revision } : { loading: Boolean(path) }, setState];
}

function NoticeCard({ card, unavailable, onAction, onFollow, onSeen, onSnooze, onRemind, advisorSource }) {
  const action = card.action;
  return <li className={styles.card} data-advisor-key={card.key}>
    <div className={styles.badges}>
      <span className={styles.badge} data-severity={card.severity}>{SEVERITIES[card.severity]}</span>
      <span className={styles.state}>{card.read ? 'Leído' : 'Sin leer'}</span>
    </div>
    <h3>{card.title}</h3>
    <p>{card.reason}</p>
    <p className={styles.meta}>Fuente: {card.source.label} · Corte: <Stamp value={card.asOf}/></p>
    {action && (hasDestination(action) || action.taskId) && <div className={styles.actions}>
      <button type="button" className="button subtle" data-advisor-control={advisorSource?'advisor-inbox-source-control':undefined} onClick={onAction}>{action.label}</button>
      {action.follow && onFollow && <button type="button" className="button subtle" aria-haspopup="dialog" aria-disabled={unavailable}
        onClick={event => canRun(event, () => onFollow(action.follow))}>{action.follow.label}</button>}
    </div>}
    <details className={styles.details}>
      <summary>Acciones personales<span className="sr-only"> de {card.title}</span></summary>
      <div className={styles.actions}>
        <button type="button" className="text-button" aria-disabled={unavailable || card.read} onClick={event => canRun(event, onSeen)}>Marcar leído</button>
        <button type="button" className="text-button" aria-disabled={unavailable} aria-haspopup="dialog" onClick={event => canRun(event, () => onSnooze(event))}>Posponer</button>
        {(card.kind === 'alert' || card.kind === 'import') && <button type="button" className="text-button" aria-disabled={unavailable} aria-haspopup="dialog" onClick={event => canRun(event, () => onRemind(event))}>Recordarme</button>}
      </div>
    </details>
  </li>;
}

function ReminderCard({ task, blocked, selected, headingRef, onEdit }) {
  const active = taskIsOpen(task);
  const linkedSource = SOURCE_NAMES[task.data.sourceRef?.kind];
  const pastDue = Date.parse(task.dueAt) <= Date.now();
  const status = active ? pastDue ? linkedSource ? 'Fecha pasada' : 'Vencido' : 'Programado' : task.status === 'completed' ? 'Atendido' : 'Cancelado';
  return <li className={styles.card}>
    <div className={styles.badges}><span className={styles.state}>{status}</span>{selected && <span className={styles.state}>Seleccionado</span>}</div>
    <h4 ref={headingRef} tabIndex={selected ? -1 : undefined}>{taskLabel(task)}</h4>
    <p>Fecha programada: <Stamp value={task.dueAt}/>.</p>
    {linkedSource && <p className={styles.meta}>Vinculado a: {linkedSource}. Solo se anuncia si la condición sigue vigente.</p>}
    <div className={styles.actions}>
      {active && <>
        <button type="button" className="text-button" aria-haspopup="dialog" aria-disabled={blocked} onClick={event => canRun(event, () => onEdit('reschedule', task, event))}>Reprogramar</button>
        <button type="button" className="text-button" aria-haspopup="dialog" aria-disabled={blocked} onClick={event => canRun(event, () => onEdit('acknowledge', task, event))}>Marcar como atendido</button>
      </>}
      <button type="button" className="text-button danger" aria-haspopup="dialog" aria-disabled={blocked} onClick={event => canRun(event, () => onEdit('remove', task, event))}>Eliminar</button>
    </div>
  </li>;
}

export default function AdvisorInbox({ resource, availability, page = 1, onPage, onRetry, onOpenAction, onFollowImport, onMutation, api, request, onRequestHandled, onInteractionStateChange }) {
  const id = useId();
  const heading = useRef(null), remindButton = useRef(null), historyHeading = useRef(null), dialogRef = useRef(null);
  const selectedHeading = useRef(null), pendingSelection = useRef(null), historyOrigin = useRef(null);
  const origin = useRef(null), returnFocus = useRef(null), handled = useRef(null), focusHistory = useRef(false), mutation = useRef(null), reservation = useRef(null);
  const { data, error, loading, offline } = resource;
  const latestInbox = useRef(data);
  latestInbox.current = data;
  const [noticePatch, setNoticePatch] = useState(null), [snoozedCards, setSnoozedCards] = useState(() => new Map());
  const [historyOpen, setHistoryOpen] = useState(false), [historyPage, setHistoryPage] = useState(1);
  const [taskId, setTaskId] = useState(null), [historyRevision, setHistoryRevision] = useState(0);
  const [history, setHistory] = useReminderRead(api, historyOpen ? `${TASKS}?kind=reminder&page=${historyPage}` : null, historyRevision);
  const tasks = history.data?.items ?? [];
  const listedTask = tasks.find(task => task.id === taskId);
  const [selected, setSelected] = useReminderRead(api, historyOpen && taskId && !listedTask ? getTaskPath(taskId) : null, historyRevision);
  const [dialog, setDialog] = useState(null), [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const ready = availability === 'ready';
  const noticeError = (typeof error === 'string' ? error : error?.message) ||
    (error ? 'No se pudo consultar la bandeja.' : availability === 'error' ? 'No se pudo comprobar la disponibilidad de Ali.' : '');
  const noticeUnavailable = !ready || Boolean(noticeError) || offline || busy;
  const createUnavailable = !ready || offline || busy;
  const dirty = Boolean(dialog && (dialog.date !== dialog.initialDate || dialog.time !== dialog.initialTime || dialog.label !== dialog.initialLabel));

  useEffect(() => { onInteractionStateChange?.({ dirty, busy }); }, [dirty, busy, onInteractionStateChange]);
  useEffect(() => () => { onInteractionStateChange?.({ dirty: false, busy: false }); }, [onInteractionStateChange]);
  useEffect(() => () => mutation.current?.abort(), []);

  function refreshHistory() { setHistoryRevision(value => value + 1); }
  function showHistory(selection = null, trigger = null) {
    pendingSelection.current = selection;
    historyOrigin.current = trigger;
    setTaskId(selection);
    if (!historyOpen) refreshHistory();
    if (historyOpen && selection === taskId) (selectedHeading.current || historyHeading.current)?.focus();
    else focusHistory.current = true;
    setHistoryOpen(true);
  }

  function start(kind, { card, task, trigger } = {}) {
    if (mutation.current) return;
    const fieldTime = kind === 'reschedule' && task.dueAt ? BOGOTA_WALL_TIME.format(new Date(task.dueAt)).split(' ') : [];
    const [date = '', time = ''] = fieldTime;
    const label = card && kind === 'create' ? card.title.slice(0, 120).replace(/[\uD800-\uDBFF]$/, '').trim() : '';
    trigger?.focus({ preventScroll: true });
    origin.current = { trigger, fallback: task ? historyHeading : heading };
    reservation.current = null;
    setFeedback('');
    setDialog({ kind, card, task, date, time, label, initialDate: date, initialTime: time, initialLabel: label, error: '' });
  }
  function finishDialog() {
    returnFocus.current = origin.current;
    setDialog(null);
  }
  const close = useDialog(dialogRef, { open: Boolean(dialog), busy, onClose: finishDialog });
  useEffect(() => {
    if (dialog || !returnFocus.current) return;
    const { trigger, fallback } = returnFocus.current;
    returnFocus.current = null;
    if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
    else fallback.current?.focus({ preventScroll: true });
  }, [dialog]);

  const handleRequest = useEffectEvent(() => {
    handled.current = request.id;
    if (request.kind === 'reminder' && !createUnavailable) start('create', { trigger: remindButton.current });
    else {
      showHistory(request.kind === 'reminders' ? request.taskId : null);
      if (request.kind === 'reminder') setFeedback(offline
        ? 'Sin conexión. No se puede guardar un recordatorio.'
        : availability === 'error'
          ? 'No se pudo comprobar si Ali está disponible. Puedes gestionar los recordatorios que ya guardaste.'
          : 'Ali debe estar habilitado y verificado para crear recordatorios. Puedes gestionar los que ya guardaste.');
    }
    onRequestHandled?.(request.id);
  });
  useEffect(() => {
    if (!request || request.id === handled.current || dialog || busy || request.kind === 'reminder' && availability === 'loading') return;
    handleRequest();
  }, [request, availability, dialog, busy]);

  function recordNotice(key, card) {
    const currentData = latestInbox.current;
    setNoticePatch(previous => {
      const values = new Map(previous && previous.data === currentData ? previous.values : undefined);
      values.set(key, card);
      return { data: currentData, values };
    });
    setSnoozedCards(previous => {
      const snoozed = card?.snoozedUntil && Date.parse(card.snoozedUntil) > Date.now();
      if (!snoozed && !previous.has(key)) return previous;
      const next = new Map(previous);
      if (snoozed) next.set(key, card);
      else next.delete(key);
      return next;
    });
  }

  function updateHistory(task, method, response) {
    const removed = method === 'DELETE';
    const matches = item => item.id === task.id;
    setHistory(previous => {
      if (!previous?.data?.items.some(matches)) return previous;
      const items = removed ? previous.data.items.filter(item => !matches(item)) : previous.data.items.map(item => matches(item) ? response : item);
      return { ...previous, data: { ...previous.data, items, total: previous.data.total - Number(removed) } };
    });
    setSelected(previous => previous?.data && matches(previous.data) ? { ...previous, data: removed ? null : response } : previous);
    if (removed && taskId === task.id) setTaskId(null);
  }

  async function mutate(path, options, { success, card, task, confirming = false }) {
    if (mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setFeedback('');
    if (confirming) setDialog(current => ({ ...current, error: '' }));
    try {
      const result = await api(path, { ...options, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (card) recordNotice(card.key, result);
      if (task) updateHistory(task, options.method, result);
      if (confirming) finishDialog();
      setFeedback(success);
      if (historyOpen && path !== INBOX) refreshHistory();
      onMutation?.();
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause.status === 404 || cause.status === 409) {
        if (card && (cause.current || cause.status === 404)) recordNotice(card.key, cause.current ?? null);
        if (task && cause.status === 404) updateHistory(task, 'DELETE');
        if (confirming) finishDialog();
        setFeedback(cause.status === 404 && card ? 'El aviso ya no está vigente. Actualizando la bandeja.' : `${cause.message || 'El registro cambió.'} Revisa la información actual antes de intentarlo de nuevo.`);
        if (historyOpen && path !== INBOX) refreshHistory();
        onMutation?.();
      } else {
        const message = cause.message || 'No se pudo guardar el cambio.';
        if (confirming) setDialog(current => ({ ...current, error: message }));
        else setFeedback(message);
      }
    } finally {
      if (!controller.signal.aborted) {
        mutation.current = null;
        setBusy(false);
      }
    }
  }

  function changeNotice(card, action, until) {
    const success = action === 'seen' ? 'Marcaste el aviso como leído. Su origen no cambió.' : action === 'unsnooze' ? 'Quitaste el aplazamiento del aviso.' : CONFIRMATIONS.snooze.success;
    mutate(INBOX, writeOptions('PATCH', { key: card.key, fingerprint: card.fingerprint, version: card.version, action, ...(until ? { until } : {}) }), { success, card, confirming: action === 'snooze' });
  }

  function submit(event) {
    event.preventDefault();
    const { kind, card, task, date, time, label } = dialog;
    if (busy || offline || (kind === 'create' && createUnavailable) || (kind === 'snooze' && noticeUnavailable)) return;
    const fail = message => setDialog(current => ({ ...current, error: message }));
    let until;
    if (kind === 'create' || kind === 'reschedule' || kind === 'snooze') {
      if (!date || !time) return fail('Indica una fecha y una hora en Bogotá.');
      try { until = instant(`${date}T${time}:00-05:00`); }
      catch { return fail('Indica una fecha y hora válidas en Bogotá.'); }
      if (Date.parse(until) <= Date.now()) return fail('Elige una fecha y hora futuras en Bogotá.');
    }
    if (kind === 'snooze') return changeNotice(card, 'snooze', until);
    const success = CONFIRMATIONS[kind].success;
    if (kind === 'create') {
      const subject = label.trim();
      if (!subject) return fail('Escribe un asunto corto para el recordatorio.');
      const payload = { capabilityId: 'advisor.reminder', dueAt: until, label: subject, ...(card ? { sourceRef: { kind: card.kind, id: card.source.id } } : {}) };
      const key = JSON.stringify(payload);
      if (reservation.current?.key !== key) reservation.current = { key, id: crypto.randomUUID() };
      return mutate(TASKS, writeOptions('POST', { id: reservation.current.id, ...payload }), { success, confirming: true });
    }
    const { version } = task;
    const options = kind === 'remove' ? writeOptions('DELETE', { version }) : writeOptions('PATCH', kind === 'reschedule' ? { version, action: 'snooze', until } : { version, action: 'acknowledge-reminder' });
    return mutate(getTaskPath(task.id), options, { success, task, confirming: true });
  }

  const patch = noticePatch && noticePatch.data === data ? noticePatch.values : null;
  const now = Date.now();
  const stillSnoozed = card => card.snoozedUntil && Date.parse(card.snoozedUntil) > now;
  const visible = [];
  for (const original of data?.items ?? []) {
    const card = patch?.has(original.key) ? patch.get(original.key) : original;
    if (card && !stillSnoozed(card)) visible.push(card);
  }
  const deferred = [...snoozedCards.values()].filter(stillSnoozed);
  const sources=noticeUnavailable?0:visible.filter(card=>hasDestination(card.action)).length;
  const pickedTask = listedTask || selected.data;
  const pickedId = pickedTask?.id;
  useEffect(() => {
    if (!historyOpen) return;
    const selectedTarget = pickedId && pendingSelection.current === pickedId && selectedHeading.current;
    if (focusHistory.current) {
      focusHistory.current = false;
      (selectedTarget || historyHeading.current)?.focus();
    } else if (selectedTarget && document.activeElement === historyHeading.current) {
      selectedTarget.focus();
    }
    if (selectedTarget) pendingSelection.current = null;
  }, [historyOpen, taskId, pickedId]);
  const otherTasks = pickedTask ? tasks.filter(task => task.id !== pickedTask.id) : tasks;
  const historyBlocked = busy || Boolean(offline || history.loading || history.error);
  const confirmation = dialog && CONFIRMATIONS[dialog.kind];
  const scheduled = dialog && (dialog.kind === 'create' || dialog.kind === 'snooze' || dialog.kind === 'reschedule');
  const unavailable = dialog && (busy || offline || dialog.kind === 'create' && !ready || dialog.kind === 'snooze' && (!ready || noticeError));

  return <section className={styles.inbox} aria-labelledby={`${id}-heading`}>
    <header className={styles.header}>
      <div>
        <h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>Hoy con Ali</h2>
        <p>Avisos y recordatorios privados. Leer o posponer un aviso no cambia el negocio.</p>
      </div>
      <div className={styles.actions}>
        {ready && <button ref={remindButton} type="button" className="button subtle" aria-disabled={Boolean(createUnavailable)} aria-haspopup="dialog" onClick={event => canRun(event, () => start('create', { trigger: event.currentTarget }))}>Recordarme</button>}
        <button type="button" className="button subtle" aria-expanded={historyOpen} aria-controls={`${id}-history`} onClick={event => {
          if (historyOpen) {
            const trigger = historyOrigin.current;
            (trigger?.isConnected && trigger.getClientRects().length ? trigger : event.currentTarget).focus();
            setHistoryOpen(false);
            setTaskId(null);
          } else showHistory(null, event.currentTarget);
        }}>Mis recordatorios</button>
      </div>
    </header>
    <p className={feedback ? styles.feedback : 'sr-only'} role="status" aria-atomic="true">{feedback}</p>
    {availability === 'disabled' ? <div className={styles.readState}>
      <p>Ali está desactivado o aún no se ha verificado. Tus alertas del negocio y el historial de recordatorios siguen disponibles.</p>
      <button type="button" className="button subtle" onClick={() => onOpenAction({ label: 'Configurar Ali', view: { section: 'business', tab: 'assistant' } })}>Configurar Ali</button>
    </div> : <>
      <GetState offline={offline} error={noticeError} loading={Boolean(loading && !data || availability === 'loading')} retry={onRetry}/>
      {ready && <>
        {data && !offline && !noticeError && <p className={styles.meta}>{data.unreadCount === 1 ? '1 aviso sin leer' : `${data.unreadCount} avisos sin leer`} · Corte: <Stamp value={data.asOf}/></p>}
        {data && !offline && !noticeError && !loading && !visible.length && <p className={styles.meta}>{page === 1 ? 'No tienes avisos vigentes.' : 'No hay avisos en esta página.'}</p>}
        {visible.length > 0 && <ul className={styles.list} role="list" aria-label="Avisos de Ali" data-advisor-control={sources>1?'advisor-inbox-source-control':undefined} tabIndex={sources>1?-1:undefined}>{visible.map(card => <NoticeCard key={card.key} card={card} unavailable={Boolean(noticeUnavailable)} advisorSource={sources===1&&hasDestination(card.action)}
          onAction={event => hasDestination(card.action) ? onOpenAction(card.action) : showHistory(card.action.taskId, event.currentTarget)}
          onFollow={onFollowImport}
          onSeen={() => changeNotice(card, 'seen')}
          onSnooze={event => start('snooze', { card, trigger: event.currentTarget })} onRemind={event => start('create', { card, trigger: event.currentTarget })}/>)}</ul>}
        {deferred.length > 0 && <details className={styles.details} data-advisor-disclosure>
          <summary data-advisor-control={!noticeUnavailable&&deferred.length>1?'advisor-notice-unsnooze':undefined}>Avisos que pospusiste ({deferred.length})</summary>
          <ul className={styles.list} role="list" aria-label="Avisos pospuestos en esta visita">
            {deferred.map(card => <li className={styles.card} key={card.key}>
              <h3>{card.title}</h3><p className={styles.meta}>Pospuesto hasta <Stamp value={card.snoozedUntil}/>.</p>
              <button type="button" className="text-button" aria-disabled={Boolean(noticeUnavailable)} data-advisor-control={!noticeUnavailable&&deferred.length===1?'advisor-notice-unsnooze':undefined} onClick={event => canRun(event, () => changeNotice(card, 'unsnooze'))}>Deshacer aplazamiento</button>
            </li>)}
          </ul>
        </details>}
        {(data || page > 1) && <Pagination page={page} total={data?.total ?? 0} busy={busy || loading || offline} onPage={onPage} label="Páginas de avisos"/>}
      </>}
    </>}
    <section id={`${id}-history`} className={styles.history} aria-labelledby={`${id}-history-title`} hidden={!historyOpen}>
      <h3 id={`${id}-history-title`} ref={historyHeading} tabIndex={-1}>Mis recordatorios</h3>
      <p>Solo tú puedes verlos. No se entregan con el panel cerrado: al volver, los vencidos vigentes aparecen en Hoy con Ali si Ali está habilitado.</p>
      <GetState offline={offline} error={history.error || selected.error} loading={Boolean(history.loading && !history.data || selected.loading && !pickedTask)} retry={refreshHistory}/>
      {!pickedTask && !history.loading && !history.error && !selected.error && !offline && history.data && !tasks.length && <p>{historyPage === 1 ? 'No tienes recordatorios guardados.' : 'No hay recordatorios en esta página.'}</p>}
      {(pickedTask || otherTasks.length > 0) && <ul className={styles.list} role="list" aria-label="Historial de recordatorios">
        {pickedTask && <ReminderCard key={pickedTask.id} task={pickedTask} blocked={listedTask ? historyBlocked : busy || Boolean(offline || selected.loading || selected.error)} selected headingRef={selectedHeading} onEdit={(kind, task, event) => start(kind, { task, trigger: event.currentTarget })}/>}
        {otherTasks.map(task => <ReminderCard key={task.id} task={task} blocked={historyBlocked} onEdit={(kind, item, event) => start(kind, { task: item, trigger: event.currentTarget })}/>)}
      </ul>}
      {(history.data || historyPage > 1) && <Pagination page={historyPage} total={history.data?.total ?? 0} busy={busy || history.loading || offline} onPage={setHistoryPage} label="Páginas de recordatorios"/>}
    </section>
    <dialog className={styles.dialog} ref={dialogRef} aria-labelledby={`${id}-dialog-title`}>
      {confirmation && <form className={styles.form} onSubmit={submit} noValidate>
        <h2 id={`${id}-dialog-title`} tabIndex={-1} data-dialog-initial-focus>{confirmation.title}</h2>
        {dialog.kind === 'create' && <label>Asunto<input required type="text" value={dialog.label} maxLength={120} disabled={busy} onChange={event => setDialog(current => ({ ...current, label: event.target.value, error: '' }))}/></label>}
        {dialog.kind === 'create' && dialog.card && <p>Destino vinculado: {dialog.card.source.label}{hasDestination(dialog.card.action) ? ` · ${dialog.card.action.label}` : ''}. Solo se anuncia mientras la condición siga vigente.</p>}
        {dialog.kind === 'snooze' && <p><strong>{dialog.card.title}</strong>. Solo pospones tu aviso; el registro de origen no cambia.</p>}
        {dialog.task && <p><strong>{taskLabel(dialog.task)}</strong> · <Stamp value={dialog.task.dueAt}/></p>}
        {dialog.kind === 'acknowledge' && <p>Dejará de avisarte y quedará como atendido en tu historial. No cambia el registro de origen.</p>}
        {dialog.kind === 'remove' && <p>Se eliminará de tu historial. Esta acción no se puede deshacer y no cambia el registro de origen.</p>}
        {scheduled && <fieldset className={styles.schedule}>
          <legend>Fecha y hora de Bogotá ({BUSINESS_TIME_ZONE})</legend>
          <label>Fecha<input required type="date" value={dialog.date} disabled={busy} onChange={event => setDialog(current => ({ ...current, date: event.target.value, error: '' }))}/></label>
          <label>Hora<input required type="time" value={dialog.time} disabled={busy} onChange={event => setDialog(current => ({ ...current, time: event.target.value, error: '' }))}/></label>
        </fieldset>}
        <p className={dialog.error ? styles.feedback : 'sr-only'} role="status" aria-atomic="true">{dialog.error}</p>
        {offline && <p>Sin conexión. Recupera la conexión antes de confirmar.</p>}
        {!offline && unavailable && !busy && <p>Vuelve a consultar la bandeja antes de confirmar este cambio.</p>}
        <footer className={styles.actions}>
          <button type="button" className="button subtle" aria-disabled={busy} onClick={event => canRun(event, close)}>Ahora no</button>
          <button type="submit" className={`button ${dialog.kind === 'remove' ? 'subtle danger' : 'primary'}`} aria-disabled={Boolean(unavailable)}>{busy ? 'Guardando…' : confirmation.submit}</button>
        </footer>
      </form>}
    </dialog>
  </section>;
}
