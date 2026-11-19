'use client';

import { useEffect, useRef, useState } from 'react';
import { useAssistantForm } from './AssistantBridge.jsx';
import styles from './AdvertisingWorkspace.module.css';

const ASSETS = '/api/admin/social/assets';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
const DEFAULT_ACCEPT = [...IMAGE_TYPES, ...VIDEO_TYPES, '.mov'].join(',');
const MiB = 1048576;

function fileError(file, accept) {
  if (!file) return '';
  const image = IMAGE_TYPES.includes(file.type), video = VIDEO_TYPES.includes(file.type);
  const accepted = accept.toLowerCase().split(',').some(token => {
    token = token.trim();
    return token === file.type || (token.endsWith('/*') && file.type.startsWith(token.slice(0, -1))) || (token.startsWith('.') && file.name.toLowerCase().endsWith(token));
  });
  if ((!image && !video) || !accepted) return 'Elige un archivo de uno de los formatos admitidos.';
  if (file.size <= 0 || file.size > (image ? 10 : 250) * MiB) return `El archivo no puede estar vacío ni superar ${image ? 10 : 250} MiB.`;
  return '';
}

export default function AdvertisingAssetUpload({ api, onBeforeUpload, onAssetReserved, onAsset, onMutation, onInteractionStateChange, accept = DEFAULT_ACCEPT, disabled = false, submitLabel = 'Subir archivo', active = true }) {
  const [file, setFile] = useState(null), [name, setName] = useState(''), [slot, setSlot] = useState(null);
  const [busy, setBusy] = useState(false), [phase, setPhase] = useState(''), [error, setError] = useState('');
  const [asset, setAsset] = useState(null), [readError, setReadError] = useState(''), [revision, setRevision] = useState(0);
  const input = useRef(null), errorRef = useRef(null), mutation = useRef(null), attempt = useRef(null), selection = useRef(null), tracked = useRef(null);
  const callbacks = useRef({ onBeforeUpload, onAssetReserved, onAsset, onMutation, onInteractionStateChange });
  callbacks.current = { onBeforeUpload, onAssetReserved, onAsset, onMutation, onInteractionStateChange };
  const dirty = Boolean(file || name);
  const assistant = useAssistantForm({
    target: 'asset-metadata', values: { name }, dirty, busy: busy || disabled, enabled: active,
    generationKey: JSON.stringify([selection.current, slot?.id, slot?.version]),
    applyPatch: patch => {
      if (Object.keys(patch).some(key => key !== 'name')) throw new Error('El archivo y la carga siempre se eligen manualmente.');
      if (Object.hasOwn(patch, 'name')) changeName(patch.name);
    },
  });
  const locked = disabled || busy || assistant.assistantBusy;
  const imageOnly = !accept.toLowerCase().split(',').some(token => /^(?:video\/|\.mov$|\.mp4$)/.test(token.trim()));
  const invalid = fileError(file, accept);
  const processingId = asset?.state === 'processing' ? asset.id : null;

  useEffect(() => { callbacks.current.onInteractionStateChange?.({ dirty, busy: busy || assistant.assistantBusy }); }, [dirty, busy, assistant.assistantBusy]);
  useEffect(() => () => { mutation.current?.abort(); callbacks.current.onInteractionStateChange?.({ dirty: false, busy: false }); }, []);
  useEffect(() => { if (active && error) errorRef.current?.focus(); }, [active, error]);
  useEffect(() => {
    if (!active || !processingId) return;
    const controller = new AbortController();
    let timer;
    async function readAsset() {
      if (controller.signal.aborted || tracked.current?.id !== processingId) return;
      if (document.hidden) { timer = setTimeout(readAsset, 5000); return; }
      try {
        const next = await api(`${ASSETS}/${encodeURIComponent(processingId)}`, { signal: controller.signal });
        if (controller.signal.aborted || tracked.current?.id !== processingId || next.id !== processingId) return;
        setReadError('');
        if (next.version !== tracked.current.version || next.state !== tracked.current.state) {
          tracked.current = next;
          setAsset(next);
          callbacks.current.onAsset?.(next);
          if (next.state !== 'processing') { void notifyMutation(); return; }
        }
      } catch (cause) {
        if (controller.signal.aborted || tracked.current?.id !== processingId) return;
        setReadError(cause.message);
      }
      timer = setTimeout(readAsset, 5000);
    }
    void readAsset();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, active, processingId, revision]);

  async function notifyMutation() {
    const id = tracked.current?.id;
    try { await callbacks.current.onMutation?.(); } catch (cause) {
      if (id && tracked.current?.id === id) setReadError(`La carga se conserva, pero no se pudo actualizar la biblioteca. ${cause.message}`);
    }
  }
  function changeName(value) { setName(value); setSlot(null); attempt.current = null; }
  function pick(value) {
    selection.current = value ? crypto.randomUUID() : null;
    attempt.current = null;
    setError(''); setReadError(''); setSlot(null); setFile(value); setName((value?.name || '').slice(0, 200));
  }
  function clearFile() {
    selection.current = null; attempt.current = null;
    setFile(null); setName(''); setSlot(null);
    if (input.current) input.current.value = '';
  }
  async function upload() {
    if (!active || locked || mutation.current || !file || invalid || !name.trim()) return;
    const controller = new AbortController(), { signal } = controller;
    mutation.current = controller; setBusy(true); setError(''); setReadError('');
    const payload = { name: name.trim(), contentType: file.type, expectedBytes: file.size };
    const current = attempt.current ??= { reserveId: crypto.randomUUID(), uploadId: crypto.randomUUID(), slot: null };
    try {
      setPhase('Reservando espacio privado para el archivo original y su versión para publicar…');
      await callbacks.current.onBeforeUpload?.();
      if (signal.aborted) return;
      const reserved = current.slot ?? await api(ASSETS, { method: 'POST', body: JSON.stringify({ ...payload, requestId: current.reserveId }), signal });
      if (signal.aborted) return;
      current.slot = reserved; setSlot(reserved);
      await callbacks.current.onAssetReserved?.(reserved);
      if (signal.aborted) return;
      setPhase('Enviando el archivo original; aún no es publicable…');
      const uploaded = await api(`${ASSETS}/${encodeURIComponent(reserved.id)}/content`, { method: 'PUT', body: file, headers: {
        'content-type': file.type, 'x-asset-version': String(reserved.version), 'x-request-id': current.uploadId,
      }, signal });
      if (signal.aborted) return;
      if (!['processing', 'ready'].includes(uploaded.state) && !uploaded.originalUrl) throw new Error(uploaded.diagnostic?.message || 'El original no fue recibido íntegro. Selecciona el archivo de nuevo.');
      tracked.current = uploaded; setAsset(uploaded); clearFile();
      callbacks.current.onAsset?.(uploaded);
      void notifyMutation();
    } catch (cause) {
      if (!signal.aborted) {
        setError(`No se confirmó la carga completa. Si la respuesta se perdió, puedes comprobar esta misma carga. Si se interrumpió, selecciona el archivo de nuevo. ${cause.message}`);
        void notifyMutation();
      }
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (!signal.aborted) { setBusy(false); setPhase(''); }
    }
  }

  return <div hidden={!active}><div className={styles.stack}>
    <fieldset disabled={locked} className={styles.fieldGrid}>
      <legend>Archivo propio</legend>
      <label className="field">{imageOnly ? 'Archivo de imagen' : 'Archivo de imagen o video'}<input ref={input} type="file" accept={accept} onChange={event => pick(event.target.files?.[0] || null)} /></label>
      <label className="field">Nombre para encontrarlo después<input name="assetName" value={name} maxLength={200} onChange={event => changeName(event.target.value)} /></label>
    </fieldset>
    <p className={styles.help}>JPEG, PNG o WebP hasta 10 MiB, no animado. Para publicar tal cual: proporción 4:5–1,91:1 y ancho mínimo de 320 px.{!imageOnly && ' MP4/MOV hasta 250 MiB, vertical 9:16, mínimo 540 × 960 y 3–90 segundos.'} El original queda guardado en privado; subirlo no lo selecciona ni lo publica.</p>
    {file && <p className={styles.help}>{file.name} · {new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(file.size / MiB)} MiB</p>}
    {invalid && <p role="alert" className={styles.error}>{invalid}</p>}
    <div className={styles.actions}>
      <button type="button" className="button primary" disabled={locked || !file || !name.trim() || Boolean(invalid)} onClick={upload}>{busy ? 'Carga en curso…' : slot ? 'Revisar o reintentar esta carga' : submitLabel}</button>
      <button type="button" className="button subtle" disabled={locked} onClick={assistant.openAssistant}>Ayúdame con el nombre</button>
      {file && <button type="button" className="button subtle" disabled={locked} onClick={() => { pick(null); if (input.current) input.current.value = ''; }}>Descartar selección local</button>}
    </div>
    {phase && <p role="status">{phase}</p>}
    {asset?.state === 'processing' && <p role="status" className={styles.notice}>Original recibido. Preparando {asset.kind === 'video' ? 'el video' : 'la imagen'}; todavía no está lista para usar.</p>}
    {asset?.state === 'ready' && <p role="status" className={styles.notice}>{asset.name} · Lista para revisar.</p>}
    {asset && !['processing', 'ready'].includes(asset.state) && <p role="alert" className={styles.warning}>{asset.diagnostic?.message || 'No se pudo preparar el archivo. Revisa su estado o elige otro.'}</p>}
    {readError && <div role="alert" className={styles.error}><p>{readError}</p>{processingId && <button type="button" className="button subtle" onClick={() => setRevision(value => value + 1)}>Volver a comprobar el archivo</button>}</div>}
    {error && <p ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>{error}</p>}
  </div></div>;
}
