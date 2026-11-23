'use client';

import { useEffect, useId, useRef, useState } from 'react';
import styles from './AdvisorRecommendations.module.css';

const ROUTE = '/api/admin/assistant/recommendations';
const SEVERITY = { critical: 'Crítica', warning: 'Para revisar', info: 'Informativa' };
const DAY = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeZone: 'America/Bogota' });
const INSTANT = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' });
function dateLabel(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? DAY.format(new Date(`${value}T12:00:00Z`)) : INSTANT.format(new Date(value));
}

export default function AdvisorRecommendations({ api, ready, onNavigate, onFollow, onInteractionStateChange, revision }) {
  const heading = useId();
  const [attempt, setAttempt] = useState(0), [result, setResult] = useState(null);
  const [busy, setBusy] = useState(null), [feedback, setFeedback] = useState(null);
  const mutation = useRef(null), requestIds = useRef(new Map());
  const interaction = useRef(onInteractionStateChange);
  interaction.current = onInteractionStateChange;

  useEffect(() => {
    if (ready !== true) return;
    const controller = new AbortController();
    api(ROUTE, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setResult({ api, revision, attempt, items: data.items });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ api, revision, attempt, error: true });
    });
    return () => controller.abort();
  }, [api, ready, revision, attempt]);

  useEffect(() => () => {
    mutation.current?.abort();
    mutation.current = null;
    interaction.current?.({ dirty: false, busy: false });
  }, []);

  const current = result?.api === api && result?.revision === revision && result?.attempt === attempt ? result : null;
  const items = ready === true ? current?.items : null;

  async function follow(recommendationId) {
    if (mutation.current || ready !== true) return;
    const controller = new AbortController();
    mutation.current = controller;
    const id = requestIds.current.get(recommendationId) ?? crypto.randomUUID();
    requestIds.current.set(recommendationId, id);
    interaction.current?.({ dirty: false, busy: true });
    setBusy(recommendationId);
    setFeedback(null);
    let task;
    try {
      task = await api(ROUTE, { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ id, capabilityId: 'advisor.follow-recommendation', recommendationId }),
      });
      if (controller.signal.aborted) return;
      setFeedback({ kind: 'status', text: 'Guardaste el seguimiento en Mis tareas. No cambió ningún registro del negocio.' });
    } catch (error) {
      if (controller.signal.aborted) return;
      if ([404, 409].includes(error.status)) {
        requestIds.current.delete(recommendationId);
        setFeedback({ kind: 'alert', text: 'La recomendación cambió o dejó de estar disponible. Vuelve a revisar la lista.' });
        setAttempt(value => value + 1);
      } else {
        setFeedback({ kind: 'alert', text: 'No pude comprobar que se guardara el seguimiento. Reintenta desde esta recomendación.' });
      }
    } finally {
      if (!controller.signal.aborted) {
        mutation.current = null;
        setBusy(null);
        interaction.current?.({ dirty: false, busy: false });
      }
    }
    if (task) onFollow?.(task);
  }

  return <section className={styles.panel} aria-labelledby={heading} data-testid="advisor-recommendation-list">
    <header>
      <h2 id={heading}>Recomendaciones de Ali</h2>
      <p>Revisa primero los hechos que ya constan. Abrir la fuente o guardar un seguimiento no ejecuta la acción del negocio.</p>
    </header>
    {ready !== true ? <p role="status">Las recomendaciones no están disponibles mientras Ali no esté listo.</p>
      : !current ? <p role="status">Consultando los datos guardados…</p>
      : current.error ? <div className={styles.feedback}>
        <p role="alert">No pude consultar las recomendaciones. No se cambió ningún dato.</p>
        <button type="button" className="button subtle" onClick={() => setAttempt(value => value + 1)}>Volver a consultar</button>
      </div>
      : !items?.length ? <p role="status">No hay recomendaciones respaldadas por los datos disponibles en este corte.</p>
      : <ul className={styles.list}>
        {items.map(item => <li key={item.id} className={styles.card}>
          <div className={styles.meta}>
            <span className={styles.badge} data-severity={item.severity}>{SEVERITY[item.severity]}</span>
            <span>Corte: <time dateTime={item.asOf}>{dateLabel(item.asOf)}</time></span>
          </div>
          <h3>{item.title}</h3>
          <p>{item.reason}</p>
          <dl className={styles.evidence}>
            {item.evidence.map(ref => <div key={ref.id}>
              <dt>{ref.label}</dt><dd>{ref.formattedValue ?? 'Sin dato'}</dd>
            </div>)}
          </dl>
          <p className={styles.limitation}>{item.limitation}</p>
          <div className={styles.actions}>
            <button type="button" className="button subtle" disabled={busy !== null} onClick={() => onNavigate?.(item.action)}>{item.action.label}</button>
            <button type="button" className="button subtle" data-testid="advisor-follow-recommendation"
              disabled={busy !== null} onClick={() => void follow(item.id)}>{busy === item.id ? 'Guardando seguimiento…' : 'Hacer seguimiento'}</button>
          </div>
        </li>)}
      </ul>}
    {feedback && <p role={feedback.kind} className={styles.feedback}>{feedback.text}</p>}
  </section>;
}
