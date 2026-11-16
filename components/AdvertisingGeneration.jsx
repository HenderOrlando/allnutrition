'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social/generation';
const states = { queued: 'En cola', sending: 'Enviado a OpenAI', succeeded: 'Original guardado', uncertain: 'Envío incierto: posible cargo', blocked: 'No enviado' };

export default function AdvertisingGeneration({ api, onInteractionStateChange, onMutation, sourceRevision = 0 }) {
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [prompt, setPrompt] = useState(''), [format, setFormat] = useState('png'), [frameCount, setFrameCount] = useState(9), [frameDurationMs, setFrameDurationMs] = useState(400), [consent, setConsent] = useState(false);
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [sourcePage, setSourcePage] = useState(null), [sourceError, setSourceError] = useState(''), [selected, setSelected] = useState([]);
  const mounted = useRef(true), locked = useRef(false), mutation = useRef(null), request = useRef(null), report = useRef(onInteractionStateChange), notify = useRef(onMutation), errorRef = useRef(null), knownAssets = useRef(new Set());
  report.current = onInteractionStateChange; notify.current = onMutation;
  const dirty = Boolean(prompt || selected.length || consent);
  useEffect(() => { report.current?.({ dirty, busy }); }, [dirty, busy]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; mutation.current?.abort(); report.current?.({ dirty: false, busy: false }); }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    const controller = new AbortController();
    api(ROOT, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setSnapshot(result);
      const newAsset = result.jobs.some(job => job.asset?.state === 'ready' && !knownAssets.current.has(job.asset.id));
      for (const job of result.jobs) if (job.asset?.state === 'ready') knownAssets.current.add(job.asset.id);
      if (newAsset) notify.current?.();
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [api, revision]);
  const pending = snapshot?.jobs.some(job => ['queued', 'sending'].includes(job.state) || job.asset?.state === 'processing');
  useEffect(() => {
    if (!pending || busy) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') setRevision(value => value + 1); }, 5000);
    return () => clearInterval(timer);
  }, [pending, busy]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api(`${ROOT}/sources?${new URLSearchParams({ query, offset: String(offset), limit: '12' })}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setSourcePage(result); setSourceError(''); } }).catch(cause => { if (!controller.signal.aborted) setSourceError(cause.message); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, query, offset, revision, sourceRevision]);
  function changed(setter, value) { setter(value); setConsent(false); request.current = null; }
  function toggle(source) {
    const exists = selected.some(item => item.kind === source.kind && item.id === source.id);
    if (!exists && selected.length >= 4) { setSourceError('Selecciona como máximo cuatro imágenes.'); return; }
    changed(setSelected, exists ? selected.filter(item => item.kind !== source.kind || item.id !== source.id) : [...selected, source]);
  }
  async function submit(event) {
    event.preventDefault();
    if (locked.current || busy || !consent || !snapshot?.availability.available) return;
    const payload = { configurationVersion: snapshot.availability.configurationVersion, prompt, format, ...(format === 'gif' ? { frameCount: Number(frameCount), frameDurationMs: Number(frameDurationMs) } : {}), sources: selected.map(({ kind, id }) => ({ kind, id })), consent: { version: 1, cost: true, externalProcessing: true, noCustomerData: true, humanReview: true } };
    const key = JSON.stringify(payload);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    const controller = new AbortController(); mutation.current = controller; locked.current = true; setBusy(true); setError('');
    try {
      await api(ROOT, { method: 'POST', body: JSON.stringify({ ...payload, requestId: request.current.id }), signal: controller.signal });
      if (!mounted.current) return;
      request.current = null; setPrompt(''); setSelected([]); setConsent(false); setRevision(value => value + 1); notify.current?.();
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(`${cause.message} Si la respuesta se perdió, enviar el mismo formulario conserva el identificador y no duplica la solicitud.`);
    } finally { locked.current = false; mutation.current = null; if (mounted.current) setBusy(false); }
  }
  return <section className={styles.card} aria-label="Generación publicitaria con IA">
    <h3>Crear imagen o GIF con OpenAI</h3>
    <p className={styles.help}>Generación bajo solicitud, sin cambiar el modelo de chat de Ali. El GIF es una animación nativa de OpenAI; se conserva y se prepara un MP4 vertical con ajuste completo, sin recorte, para revisión. No se publica automáticamente.</p>
    {!snapshot && <p role="status">Cargando disponibilidad y solicitudes…</p>}
    {snapshot && !snapshot.availability.available && <p className={styles.warning}>{snapshot.availability.reason}</p>}
    {error && <p role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
    <form onSubmit={submit}>
      <fieldset disabled={busy || !snapshot?.availability.available}>
        <legend>Solicitud nueva · {snapshot?.availability.model || 'gpt-image-2.6-flare'} · un resultado</legend>
        <label>Instrucciones sin datos personales<textarea required maxLength={4000} rows={4} value={prompt} onChange={event => changed(setPrompt, event.target.value)} placeholder="Describe diseño, texto autorizado y, para GIF, movimiento y bucle." /></label>
        <label>Formato<select value={format} onChange={event => changed(setFormat, event.target.value)}><option value="png">Imagen PNG cuadrada</option><option value="gif">GIF animado vertical</option></select></label>
        {format === 'gif' && <><label>Frames (2–16)<input type="number" min={2} max={16} required value={frameCount} onChange={event => changed(setFrameCount, event.target.value)} /></label><label>Milisegundos por frame (20–2000, múltiplos de 10)<input type="number" min={20} max={2000} step={10} required value={frameDurationMs} onChange={event => changed(setFrameDurationMs, event.target.value)} /></label><p className={styles.help}>Duración total: {(Number(frameCount) * Number(frameDurationMs) / 1000).toFixed(2)} segundos. Debe estar entre 3 y 32 segundos para el MP4 publicable.</p></>}
        <h4>Referencias opcionales: biblioteca y Productos</h4>
        <p className={styles.help}>Puedes crear desde texto sin imágenes. Para usar una imagen nueva, súbela primero con la carga de la biblioteca y espera a que esté lista. Se incluyen las fotos locales subidas de Productos y las de la vitrina. Si un producto usa un enlace externo, sube su imagen al producto para conservar una referencia local comprobable; no se descargan URLs externas. Máximo cuatro fuentes.</p>
        <label>Buscar fuentes<input value={query} maxLength={100} onChange={event => { setQuery(event.target.value); setOffset(0); setSourcePage(null); }} /></label>
        {sourceError && <p role="alert">{sourceError}</p>}
        {selected.length > 0 && <ul aria-label="Fuentes seleccionadas">{selected.map(source => <li key={`${source.kind}:${source.id}`}>{source.kind === 'product' ? 'Producto' : 'Biblioteca'}: {source.title} <button type="button" onClick={() => toggle(source)}>Quitar</button></li>)}</ul>}
        <div className={styles.summaryGrid}>{sourcePage?.sources.map(source => <label key={`${source.kind}:${source.id}`}><input type="checkbox" checked={selected.some(item => item.kind === source.kind && item.id === source.id)} onChange={() => toggle(source)} /><img src={source.thumbnailUrl} alt="" width={72} height={72} style={{ objectFit: 'contain' }} />{source.kind === 'product' ? 'Producto' : 'Biblioteca'}: {source.title}{source.facts?.presentation ? ` · ${source.facts.presentation}` : ''}</label>)}</div>
        {sourcePage && sourcePage.sources.length === 0 && <p>No hay fuentes locales listas para esta búsqueda.</p>}
        <button type="button" disabled={!offset} onClick={() => { setOffset(Math.max(0, offset - 12)); setSourcePage(null); }}>Fuentes anteriores</button>{' '}<button type="button" disabled={!sourcePage?.hasMore} onClick={() => { setOffset(sourcePage.nextOffset); setSourcePage(null); }}>Más fuentes</button>
        <p className={styles.warning}>{snapshot?.availability.notice}</p>
        <label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />Autorizo esta solicitud con costo variable sin tope garantizado, y el envío del prompt e imágenes a OpenAI. Confirmo que no contienen datos de clientes ni información personal y que revisaré producto, texto, claims y derechos antes de publicar.</label>
        <button type="submit" disabled={!consent || !prompt.trim() || format === 'gif' && (Number(frameCount) * Number(frameDurationMs) < 3000 || Number(frameCount) * Number(frameDurationMs) > 32000)}>{busy ? 'Registrando solicitud…' : 'Solicitar generación con posible cargo'}</button>
      </fieldset>
    </form>
    <h4>Solicitudes recientes</h4>
    <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Actualizar progreso</button>
    <div aria-live="polite">{snapshot?.jobs.map(job => <article key={job.id} className={styles.card}>
      <strong>{states[job.state] || job.state} · {job.format.toUpperCase()}</strong><p>{job.notice}</p>
      <p className={styles.help}>Solicitada: {new Date(job.createdAt).toLocaleString('es-CO')} · Actualizada: {new Date(job.updatedAt).toLocaleString('es-CO')}{job.sentAt ? ` · Enviada: ${new Date(job.sentAt).toLocaleString('es-CO')}` : ''}</p>
      <details><summary>Instrucciones y fuentes revisables</summary><p>{job.prompt}</p><ul>{job.sources.map(source => <li key={`${source.kind}:${source.id}`}>{source.title} · SHA-256: <code>{source.sha256}</code></li>)}</ul></details>
      {job.asset && <><p>Biblioteca: {job.asset.state} · Generado con IA; revisión humana obligatoria.</p>{job.asset.diagnostic && <p role="alert">{job.asset.diagnostic.message}</p>}<a href={job.asset.originalUrl} target="_blank" rel="noreferrer">Abrir o descargar original {job.format.toUpperCase()}</a>{job.asset.previewUrl && <div>{job.asset.kind === 'video' ? <video src={job.asset.previewUrl} controls preload="metadata" style={{ maxWidth: '100%', maxHeight: 400 }} /> : <img src={job.asset.previewUrl} alt="Resultado generado con IA pendiente de revisión humana" style={{ maxWidth: '100%', maxHeight: 400 }} />}<p>Derivado conservado, listo para revisión y selección manual en una campaña.</p></div>}</>}
    </article>)}</div>
  </section>;
}
