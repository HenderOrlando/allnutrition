'use client';

import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import useDialog from './useDialog';
import styles from './AdvisorTasks.module.css';

const TASKS = '/api/admin/assistant/tasks';
const SHIPMENT = 'orders.ship-order';
const STARTS = {
  'ship-order': { capabilityId: SHIPMENT, title: 'Empezar envío de un pedido', description: 'Identifica el pedido y revisa el envío paso a paso. Empezar no modifica pedidos ni registra guías.' },
  'close-cash': { capabilityId: 'cash.close-day', title: 'Empezar cierre de caja', description: 'Elige la cuenta de efectivo y la fecha, e indica cuánto contaste. Empezar no registra el cierre ni ajusta el saldo.' },
  'resolve-import': { capabilityId: 'imports.resolve-issues', title: 'Revisar importación con Ali', description: 'Localiza la incidencia en el lote guardado. Revisarla no aplica cambios ni decide cómo resolverla.' },
};
const PAGE_SIZE = 20;
const UNAVAILABLE = 'La tarea no está disponible o no te pertenece.';
const READ_ONLY = 'Ali no está disponible. Puedes consultar, cancelar o eliminar tus tareas guardadas.';
const STATES = {
  active: 'En curso', waiting_input: 'Falta un dato', waiting_human: 'Pendiente de tu revisión',
  waiting_result: 'Pendiente de comprobar', blocked: 'Bloqueada', completed: 'Completada', cancelled: 'Cancelada',
};
const TITLES = { [SHIPMENT]: 'Envío de un pedido', 'cash.close-day': 'Cierre de caja', 'imports.resolve-issues': 'Revisión de una importación', 'advisor.follow-recommendation': 'Seguimiento de una recomendación' };
const DATE = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' });
const itemPath = id => `${TASKS}/${encodeURIComponent(id)}`;
const closed = task => task.status === 'completed' || task.status === 'cancelled';
const taskTitle = task => TITLES[task.capabilityId] || 'Tarea de Ali';
const EXTRA_QUESTIONS = {
  editTracking: { label: 'Corregir guía', field: 'tracking' },
  editCarrier: { label: 'Corregir transportadora', field: 'carrier' },
  observe: { label: 'Indicar un hecho observado' },
};
const readableDate = value => Number.isFinite(Date.parse(value)) ? DATE.format(new Date(value)) : '';
const followStates = { resolved: 'Resuelto', pending: 'Sigue pendiente', changed: 'Cambió', not_comparable: 'Aún no es comparable' };
function FollowEvidence({ label, evidence }) {
  if (!evidence) return <div><dt>{label}</dt><dd>No hay una lectura posterior comprobada.</dd></div>;
  const day = evidence.asOfPrecision === 'day', date = day ? evidence.asOf : readableDate(evidence.asOf);
  const value = evidence.formattedValue ?? (evidence.value == null ? 'Sin dato' : `${evidence.value}${evidence.unit ? ` ${evidence.unit}` : ''}`);
  return <div><dt>{label}{date && <> · <time dateTime={evidence.asOf}>{date}</time></>}</dt><dd>{evidence.label}: {value}</dd></div>;
}

export default function AdvisorTasks({ api, ready, request, onRequestHandled, onOpenTarget, onMutation, onSelectTask, activeTaskId, onInteractionStateChange }) {
  const titleId = useId(), fieldId = useId();
  const dialog = useRef(null), heading = useRef(null);
  const command = useRef(null), reservation = useRef(null), handled = useRef(null), firstFocus = useRef(false);
  const decisionFocus = useRef(null);
  const interaction = useRef(onInteractionStateChange);
  interaction.current = onInteractionStateChange;
  const [screen, setScreen] = useState(null);
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0), [list, setList] = useState(null), [listError, setListError] = useState('');
  const [task, setTask] = useState(null), [stale, setStale] = useState(false), [value, setValue] = useState('');
  const [extra, setExtra] = useState(null);
  const [confirmation, setConfirmation] = useState(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState(null);
  const [writeBusy, setWriteBusy] = useState(false);
  const canGuide = ready === true;
  const initialValue = task?.data?.shipment?.[EXTRA_QUESTIONS[extra]?.field] ?? '';
  const dirty = screen === 'detail' && value !== initialValue;
  const open = screen !== null;

  useEffect(() => { interaction.current?.({ dirty, busy: writeBusy }); }, [dirty, writeBusy]);
  useEffect(() => () => {
    command.current?.abort();
    command.current = null;
    interaction.current?.({ dirty: false, busy: false });
  }, []);

  function refreshList() { setRevision(current => current + 1); }

  useEffect(() => {
    if (screen !== 'history') return;
    const controller = new AbortController();
    api(`${TASKS}?kind=task&page=${page}`, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      if (!data.items.length && page > 1) setPage(page - 1);
      else setList({ page, revision, data });
    }).catch(error => {
      if (!controller.signal.aborted) setListError(error.message || 'No se pudo consultar tus tareas.');
    });
    return () => controller.abort();
  }, [api, screen, page, revision]);

  function showHistory({ resetPage = false } = {}) {
    if (resetPage) setPage(1);
    setScreen('history');
    setConfirmation(null);
    setTask(null);
    setStale(false);
    setValue('');
    setExtra(null);
    setNotice(null);
    setListError('');
    refreshList();
  }

  function showStart(kind, sourceRef) {
    reservation.current = { id: null, capabilityId: STARTS[kind].capabilityId, ...(sourceRef ? { sourceRef } : {}) };
    setNotice(null);
    setScreen(kind);
  }

  const handleRequest = useEffectEvent(() => {
    handled.current = request.id;
    decisionFocus.current = request.taskId ? request.decision : null;
    if (request.taskId) {
      showHistory({ resetPage: true });
      void readTask(request.taskId);
    } else if (request.kind === 'choose' && canGuide) {
      setNotice(null);
      setScreen('choose');
    } else if (STARTS[request.kind] && canGuide) showStart(request.kind, request.sourceRef);
    else {
      showHistory({ resetPage: true });
      if (STARTS[request.kind] || request.kind === 'choose') setNotice({ text: READ_ONLY });
      if (request.decision) setNotice({ text: 'Elige primero la tarea exacta. Ali no cancela ni elimina un seguimiento sin que lo confirmes.' });
    }
    onRequestHandled?.(request.id);
  });
  useEffect(() => {
    if (!request || handled.current === request.id || open || busy) return;
    handleRequest();
  }, [request, open, busy]);

  function hide() {
    setScreen(null);
    setTask(null);
    setStale(false);
    setValue('');
    setExtra(null);
    setConfirmation(null);
    setNotice(null);
  }

  function leaveExtra() {
    setExtra(null);
    setValue('');
    setNotice(null);
  }

  const close = useDialog(dialog, { open, dirty, busy, onClose: extra ? leaveExtra : hide });
  useEffect(() => {
    if (!screen) { firstFocus.current = false; return; }
    if (firstFocus.current) heading.current?.focus({ preventScroll: true });
    firstFocus.current = true;
  }, [screen, confirmation, task?.id, task?.version, extra]);
  useEffect(() => {
    if (screen !== 'detail' || !task || busy || !decisionFocus.current) return;
    const decision = decisionFocus.current;
    decisionFocus.current = null;
    const control = dialog.current?.querySelector(`[data-task-decision="${decision}"]`);
    if (control) control.focus();
    else setNotice({ text: 'Esta tarea no permite esa acción en su estado actual.' });
  }, [screen, task, busy]);

  function showTask(current) {
    setTask(current);
    setStale(false);
    setValue('');
    setExtra(null);
    setConfirmation(null);
    setScreen('detail');
  }

  function taskUnavailable(id) {
    if (activeTaskId === id) onSelectTask?.(null);
    showHistory();
    onMutation?.();
    setNotice({ error: true, text: UNAVAILABLE });
  }

  async function run(work, { mutating = true } = {}) {
    if (command.current) return;
    const controller = new AbortController();
    command.current = controller;
    setBusy(true);
    setWriteBusy(mutating);
    setNotice(null);
    try { await work(controller.signal); }
    catch (error) {
      if (!controller.signal.aborted) setNotice({ error: true, text: error.message || 'No se pudo realizar el cambio.' });
    } finally {
      if (command.current === controller) {
        command.current = null;
        setBusy(false);
        setWriteBusy(false);
      }
    }
  }

  function readTask(id) {
    return run(async signal => {
      try {
        const current = await api(itemPath(id), { signal });
        if (!signal.aborted) showTask(current);
      } catch (error) {
        if (signal.aborted) return;
        if (error.status === 404) taskUnavailable(id);
        else throw error;
      }
    }, { mutating: false });
  }

  function startTask() {
    if (!canGuide || !reservation.current) return;
    return run(async signal => {
      reservation.current.id ||= crypto.randomUUID();
      const current = await api(TASKS, {
        method: 'POST', body: JSON.stringify(reservation.current), signal,
      });
      if (signal.aborted) return;
      showTask(current);
      onMutation?.();
    });
  }

  function changeTask(current, method, body) {
    return run(async signal => {
      const path = itemPath(current.id);
      try {
        const saved = await api(path, { method, body: JSON.stringify({ version: current.version, ...body }), signal });
        if (signal.aborted) return;
        if (method === 'DELETE') {
          if (activeTaskId === current.id) onSelectTask?.(null);
          showHistory();
          setNotice({ text: 'Tarea eliminada. Los registros de negocio no cambiaron.' });
        } else {
          showTask(saved);
          if (body.action === 'cancel') {
            if (activeTaskId === current.id) onSelectTask?.(null);
            setNotice({ text: 'Tarea cancelada. Los registros de negocio no cambiaron.' });
          }
        }
        onMutation?.();
      } catch (error) {
        if (signal.aborted) return;
        if (error.status === 404) return taskUnavailable(current.id);
        if (error.status !== 409) throw error;
        showTask(current);
        setStale(true);
        onMutation?.();
        try {
          const latest = await api(path, { signal });
          if (signal.aborted) return;
          showTask(latest);
          setNotice({ error: true, text: 'La tarea o su origen cambió. No se guardó tu decisión. Revisa el estado actual antes de continuar.' });
        } catch (readError) {
          if (signal.aborted) return;
          if (readError.status === 404) return taskUnavailable(current.id);
          setNotice({ error: true, text: 'No se guardó tu decisión. Vuelve a consultar la tarea para continuar con su estado actual.' });
        }
      }
    });
  }

  const progress = task?.data?.progress;
  const question = extra ? progress?.[extra] : progress?.question;
  const canAnswer = canGuide && !stale && task && !closed(task) && question;
  const options = question?.options ?? [];
  const answer = value.trim();
  const validAnswer = question?.type === 'choice' ? options.some(option => option.id === value) : question?.type === 'text' && answer !== '';
  const history = list?.page === page && list.revision === revision ? list.data : null;

  function submitAnswer(event) {
    event.preventDefault();
    if (!canAnswer || !validAnswer || busy) return;
    changeTask(task, 'PATCH', { action: 'answer', step: task.step, questionId: question.id, field: question.field, value: question.type === 'choice' ? value : answer });
  }

  function showExtra(key) {
    if (dirty && !window.confirm('La respuesta no se ha guardado. ¿Descartarla?')) return;
    const { field } = EXTRA_QUESTIONS[key];
    setValue(field ? task.data.shipment?.[field] ?? '' : '');
    setExtra(key);
    setNotice(null);
  }

  function decide(kind) {
    if (dirty && !window.confirm('La respuesta no se ha guardado. ¿Descartarla?')) return;
    setValue('');
    setNotice(null);
    setConfirmation(kind);
  }

  function openTarget() {
    if (!canGuide || stale || busy || dirty || !onOpenTarget || !progress?.action) return;
    const { capabilityId, view, focus, selection } = progress.action;
    return run(async signal => {
      const opened = await onOpenTarget({ taskId: task.id, capabilityId, view, focus, selection });
      if (signal.aborted) return;
      if (opened === true) hide();
      else setNotice({ text: 'No se abrió el registro. Tu tarea sigue guardada.' });
    }, { mutating: false });
  }

  const start = STARTS[screen];
  const title = start ? start.title : screen === 'choose' ? 'Elegir acompañamiento de Ali' : screen === 'history' ? 'Mis tareas' : confirmation === 'delete' ? 'Eliminar tarea' : confirmation === 'cancel' ? 'Cancelar tarea' : extra ? EXTRA_QUESTIONS[extra].label : task ? taskTitle(task) : 'Tarea de Ali';

  return <>
    <div className={styles.actions}>
      {['ship-order', 'close-cash'].map(kind => <button key={kind} type="button" className="button subtle" disabled={!canGuide || busy} onClick={() => showStart(kind)}>{STARTS[kind].title}</button>)}
      <button type="button" className="button subtle" disabled={busy} onClick={() => showHistory({ resetPage: true })}>Mis tareas</button>
    </div>
    {open && <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}>
      <header className={styles.header}>
        <h2 id={titleId} ref={heading} tabIndex={-1} data-dialog-initial-focus>{title}</h2>
        <button type="button" className="secondary" disabled={busy} onClick={close}>Ahora no</button>
      </header>
      <div className={styles.body} aria-busy={busy || undefined}>
        {notice && <p className={styles.notice} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
        {!canGuide && notice?.text !== READ_ONLY && <p className={styles.meta}>{READ_ONLY}</p>}
        {screen === 'choose' && <><p>Elige el tipo de tarea. Podrás revisar su alcance antes de empezarla.</p><div className={styles.actions}>
          {['ship-order', 'close-cash'].map(kind => <button key={kind} type="button" className="secondary" disabled={!canGuide || busy} onClick={() => showStart(kind)}>{STARTS[kind].title}</button>)}
        </div></>}
        {start && <>
          <p>{start.description}</p>
          <div className={styles.actions}><button type="button" className="primary" disabled={!canGuide || busy} onClick={startTask}>Empezar</button></div>
        </>}
        {screen === 'history' && <>
          {listError ? <div role="alert" className={styles.notice}><p>{listError}</p><button type="button" className="secondary" disabled={busy} onClick={() => { setListError(''); refreshList(); }}>Reintentar</button></div>
            : !history ? <p role="status">Consultando tus tareas…</p>
            : !history.items.length ? <p>No tienes tareas guardadas.</p>
            : <>
              <ul className={styles.list}>
                {history.items.map(item => <li className={styles.card} key={item.id}>
                  <h3>{taskTitle(item)}</h3>
                  <p className={styles.meta}>{STATES[item.status]}{item.id === activeTaskId ? ' · Seleccionada para la conversación' : ''}{item.updatedAt && <> · <time dateTime={item.updatedAt}>{readableDate(item.updatedAt)}</time></>}</p>
                  {item.data.progress?.message && <p>{item.data.progress.message}</p>}
                  <div className={styles.actions}>
                    <button type="button" className="secondary" disabled={busy} onClick={() => readTask(item.id)}>Ver tarea</button>
                    {canGuide && !closed(item) && <button type="button" className="primary" disabled={busy} onClick={() => changeTask(item, 'PATCH', { action: 'resume' })}>Retomar</button>}
                  </div>
                </li>)}
              </ul>
              {history.total > PAGE_SIZE && <nav className={styles.actions} aria-label="Páginas de mis tareas">
                <button type="button" className="secondary" disabled={busy || page === 1} onClick={() => setPage(page - 1)}>Anterior</button>
                <span className={styles.meta}>Página {page} de {Math.ceil(history.total / PAGE_SIZE)}</span>
                <button type="button" className="secondary" disabled={busy || page * PAGE_SIZE >= history.total} onClick={() => setPage(page + 1)}>Siguiente</button>
              </nav>}
            </>}
        </>}
        {screen === 'detail' && task && (confirmation ? <>
          <p>{confirmation === 'delete' ? 'Se eliminará de tu historial privado. No se eliminará ningún registro de negocio.' : 'Se detendrá el acompañamiento. Esto no revierte cambios de negocio ni confirma operaciones pendientes.'}</p>
          <div className={styles.actions}>
            <button type="button" className="secondary" disabled={busy} onClick={() => { setConfirmation(null); setNotice(null); }}>Volver a la tarea</button>
            <button type="button" className="primary" disabled={busy} onClick={() => confirmation === 'delete' ? changeTask(task, 'DELETE') : changeTask(task, 'PATCH', { action: 'cancel' })}>{title}</button>
          </div>
        </> : <>
          {stale ? <button type="button" className="secondary" disabled={busy} onClick={() => readTask(task.id)}>Consultar estado actual</button> : <>
            <p className={styles.meta}>{STATES[task.status]}</p>
            {progress?.message && <p role="status">{progress.message}</p>}
            {!!progress?.known?.length && <section className={styles.card}>
              <h3>Ya tengo</h3>
              <dl className={styles.facts}>{progress.known.map(({ label, value }, index) => <div key={index}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            </section>}
            {progress?.followUp && <section className={styles.card}>
              <h3>{followStates[progress.followUp.state]}</h3>
              <dl className={styles.facts}>
                <FollowEvidence label="Lectura de partida" evidence={progress.followUp.baseline}/>
                <FollowEvidence label="Última comprobación" evidence={progress.followUp.current}/>
              </dl>
            </section>}
            {question && !closed(task) && <section className={styles.card}>
              {!extra && <h3>Me falta</h3>}
              {canAnswer ? <form className={styles.form} onSubmit={submitAnswer} key={`${task.id}:${task.version}:${question.id}`}>
                {question.type === 'choice' ? <fieldset disabled={busy}>
                  <legend>{question.prompt}</legend>
                  {options.map(option => <label className={styles.option} key={option.id}>
                    <input type="radio" name={fieldId} value={option.id} checked={value === option.id} onChange={event => setValue(event.target.value)} />
                    <span>{option.label}</span>
                  </label>)}
                </fieldset> : <label htmlFor={fieldId}>{question.prompt}<input type={question.field === 'eventDate' || question.field === 'closingOn' ? 'date' : 'text'} inputMode={question.field === 'countedMinor' ? 'decimal' : undefined} id={fieldId} autoComplete="off" disabled={busy} value={value} onChange={event => setValue(event.target.value)} required /></label>}
                <button type="submit" className="primary" disabled={busy || !validAnswer}>Guardar respuesta</button>
              </form> : <p>{question.prompt}</p>}
            </section>}
            {progress?.proof && <section className={styles.card}>
              <h3>{progress.proof.kind === 'receipt' ? 'Comprobante' : 'Registro verificado'}</h3>
              <p>{progress.proof.label}</p>
              <dl className={styles.facts}>
                <div><dt>Registro</dt><dd>{progress.proof.entityId}</dd></div>
                <div><dt>Versión</dt><dd>{progress.proof.recordVersion}</dd></div>
                {progress.proof.committedAt && <div><dt>Fecha en Bogotá</dt><dd><time dateTime={progress.proof.committedAt}>{readableDate(progress.proof.committedAt)}</time></dd></div>}
              </dl>
            </section>}
            {!extra && <div className={styles.actions}>
              {canGuide && progress?.action && onOpenTarget && <button type="button" className="primary" disabled={busy || dirty} onClick={openTarget}>{progress.action.label}</button>}
              {canGuide && !closed(task) && Object.entries(EXTRA_QUESTIONS).map(([key, { label }]) => progress?.[key] && <button key={key} type="button" className="secondary" disabled={busy} onClick={() => showExtra(key)}>{label}</button>)}
              {canGuide && !closed(task) && <button type="button" className="secondary" disabled={busy || dirty} onClick={() => changeTask(task, 'PATCH', { action: 'resume' })}>Retomar</button>}
              {canGuide && onSelectTask && !closed(task) && task.capabilityId === SHIPMENT && <button type="button" className="secondary" disabled={busy || dirty} aria-pressed={activeTaskId === task.id} onClick={() => onSelectTask(activeTaskId === task.id ? null : task.id)}>Usar en la conversación</button>}
            </div>}
          </>}
          {!extra && <div className={styles.actions}>
            <button type="button" className="secondary" disabled={busy} onClick={() => { if (!dirty || window.confirm('La respuesta no se ha guardado. ¿Descartarla?')) showHistory(); }}>Volver a Mis tareas</button>
            {!stale && !closed(task) && <button type="button" className="secondary" data-task-decision="cancel" disabled={busy} onClick={() => decide('cancel')}>Cancelar tarea</button>}
            {!stale && <button type="button" className="secondary" data-task-decision="delete" disabled={busy} onClick={() => decide('delete')}>Eliminar tarea</button>}
          </div>}
        </>)}
      </div>
    </dialog>}
  </>;
}
