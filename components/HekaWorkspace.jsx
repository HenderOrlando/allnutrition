'use client';

import { useEffect, useRef, useState } from 'react';
import WorkspaceTabs from './WorkspaceTabs';
import { HEKA_ROOT, HekaAlert, HekaConfirmation, HekaEnvironment, hekaOperation, useHekaInteraction, useHekaRequest } from './HekaPanel';
import { HekaValues } from './HekaForms';
import HekaFreight, { EMPTY_FREIGHT, GuideReview, TEMPLATE_FIELDS } from './HekaFreight';
import { HekaCustomers, HekaGuides, HekaLookups, HekaNovelties, HekaStickers } from './HekaLookups';
import HekaJournal from './HekaJournal';
import { HekaLinkOrderReview, orderLabel, parseOrderNumber } from './HekaOrderLink';
import { useAssistantBridge } from './AssistantBridge';
import styles from './HekaPanel.module.css';

const tabs = [
  ['guides', 'Guías'], ['freight', 'Cotizar y emitir'], ['lookups', 'Datos de envío'], ['customers', 'Destinatarios'],
  ['novelties', 'Novedades'], ['stickers', 'Etiquetas PDF'], ['journal', 'Historial de operaciones'],
].map(([id, label]) => ({ id, label }));

const catalogTabs = new Map([
  ['heka-guide-search', 'guides'], ['heka-quote-form', 'freight'],
  ['heka-link-guide-start', 'guides'], ['heka-linked-shipment', 'guides'],
  ['heka-guide-review', 'freight'],
  ['heka-city-search', 'lookups'], ['heka-warehouse-search', 'lookups'], ['heka-template-search', 'lookups'],
  ['heka-copy-origin-city', 'lookups'], ['heka-copy-destination-city', 'lookups'],
  ['heka-copy-warehouse', 'lookups'], ['heka-apply-template', 'lookups'],
  ['heka-recipient-history-form', 'customers'], ['heka-recipient-rating-form', 'customers'],
  ['heka-novelty-search', 'novelties'],
  ['heka-novelty-review', 'novelties'],
  ['heka-guide-label-selection', 'guides'], ['heka-guide-label-download', 'stickers'], ['heka-saved-label-download', 'stickers'],
  ['heka-uncertain-guide-verification', 'journal'], ['heka-uncertain-novelty-verification', 'journal'],
]);

function Workbench({ api, config, onNavigate, onMutation, onInteractionStateChange, advisorTargetRequest, onAdvisorTargetHandled, catalogRequest }) {
  const { requestOpen: openAli } = useAssistantBridge();
  const [tab, setTab] = useState(config.configured ? 'guides' : 'journal');
  const [draft, setDraft] = useState(EMPTY_FREIGHT), [client, setClient] = useState({}), [mode, setMode] = useState('quote');
  const [stickers, setStickers] = useState(''), [pending, setPending] = useState(null), [latest, setLatest] = useState(null);
  const [stickerMode, setStickerMode] = useState('guide'), [stickerDocument, setStickerDocument] = useState('');
  const [dirty, setDirty] = useState(false), [formNotice, setFormNotice] = useState('');
  const [orderNumber, setOrderNumber] = useState(''), [linkOrder, setLinkOrder] = useState(null), [localLinks, setLocalLinks] = useState({});
  const intent = useRef(null);
  const { busy, error, setError, run } = useHekaRequest(api);
  useHekaInteraction(onInteractionStateChange, dirty || Boolean(pending), busy);
  const journalHeading = useRef(null);
  useEffect(() => {
    const request = advisorTargetRequest;
    if (request?.capabilityId !== 'heka.read-journal') return;
    if (dirty || pending || busy && tab !== 'journal') {
      onAdvisorTargetHandled?.(request.id, 'Termina o conserva tus cambios en Heka antes de abrir el historial.');
      return;
    }
    if (tab !== 'journal') {
      setTab('journal');
      return;
    }
    if (busy) return;
    const frame = requestAnimationFrame(() => {
      journalHeading.current?.focus();
      onAdvisorTargetHandled?.(request.id, document.activeElement === journalHeading.current ? undefined : 'No pudimos enfocar el historial local de Heka.');
    });
    return () => cancelAnimationFrame(frame);
  }, [advisorTargetRequest, busy, dirty, onAdvisorTargetHandled, pending, tab]);
  useEffect(() => {
    const target = config.configured && catalogTabs.get(catalogRequest?.focus);
    if (!target || pending || busy) return;
    setTab(target);
    if (catalogRequest.focus === 'heka-quote-form') setMode('quote');
    if (catalogRequest.focus === 'heka-guide-review') setMode('create');
    if (catalogRequest.focus === 'heka-guide-label-download') setStickerMode('guide');
    if (catalogRequest.focus === 'heka-saved-label-download') setStickerMode('document');
  }, [catalogRequest, config.configured, pending, busy]);
  function changeTab(next) {
    if (next === tab || busy) return;
    setError(''); setFormNotice(''); setTab(next);
  }
  function setFreight(name, value) { setDirty(true); setDraft(current => ({ ...current, [name]: value })); }
  function setRecipient(name, value) { setDirty(true); setClient(current => ({ ...current, [name]: value })); }
  function prepareStickers(ids) { setStickers(ids.join('\n')); setStickerMode('guide'); changeTab('stickers'); }
  function applyCity(name, dane) {
    setFreight(name, String(dane)); setFormNotice(`Se copió el código DANE ${dane} al ${name === 'city_origin' ? 'origen' : 'destino'} de «Cotizar y emitir».`);
  }
  function applyWarehouse(id) { setFreight('warehouse', id); setFormNotice('Se copió la bodega a «Cotizar y emitir».'); }
  function applyTemplate(template) {
    setDirty(true);
    setDraft(current => {
      const next = { ...current };
      for (const name of TEMPLATE_FIELDS) if (template[name] != null) next[name] = name === 'withshipping_cost' ? template[name] : String(template[name]);
      return next;
    });
    setFormNotice('Se copiaron los datos publicados de la plantilla a «Cotizar y emitir». Revisa los demás valores antes de enviarlos.');
  }
  function perform(operation, input, onResult) {
    void run(async request => {
      setFormNotice('');
      const response = await hekaOperation(request, config, operation, input);
      onResult(operation === 'sticker' ? response : response.result);
    });
  }
  function readJournal(onResult) { void run(async request => onResult((await request(`${HEKA_ROOT}/operate`)).mutations)); }
  function review(operation, input, context) {
    const fingerprint = JSON.stringify([operation, input]);
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, requestId: crypto.randomUUID() };
    setError(''); setPending({ operation, input, context, requestId: intent.current.requestId });
  }
  function reviewEvidence(mutation, evidence) {
    setError(''); setPending({ operation: 'reconcile', input: { requestId: mutation.requestId, ...evidence }, context: mutation });
  }
  function selectGuide(guide) {
    setError(''); setFormNotice(''); setOrderNumber(''); setLinkOrder(null);
    setPending({ operation: 'linkGuide', guide });
  }
  function updateOrderNumber(value) { setOrderNumber(value); setLinkOrder(null); setError(''); }
  function lookupOrder(event) {
    event.preventDefault();
    const number = parseOrderNumber(orderNumber);
    if (!number) return;
    void run(async request => {
      setLinkOrder(null);
      const result = await request('/api/admin/orders?' + new URLSearchParams({ q: orderLabel(number), lookup: 'identity' }));
      const order = result.records.find(item => item.number === number);
      if (!order) throw new Error('No se encontró un pedido con ese número exacto.');
      if (order.status === 'cancelled') throw new Error('No puedes vincular una guía con un pedido cancelado.');
      setLinkOrder(order);
      setPending(current => ({ ...current, requestId: crypto.randomUUID() }));
    });
  }
  const linking = config.configured && config.environment === 'production' ? {
    records: localLinks, select: selectGuide,
    open: linked => onNavigate({ section: 'orders', tab: 'shipments', record: linked.shipmentId }),
  } : null;
  function closeReview() { setPending(null); setError(''); }
  function confirm() {
    void run(async request => {
      const { operation, requestId, guide } = pending;
      const input = operation === 'linkGuide' ? { orderNumber: linkOrder.number, guideId: guide._id, guideNumber: guide.guide_number, carrier: guide.distributor_id } : pending.input;
      let response;
      try {
        response = await hekaOperation(request, config, operation, input, { confirm: true, ...(requestId ? { requestId } : {}) });
      } catch (cause) {
        if (cause.name === 'AbortError') throw cause;
        const hint = operation === 'reconcile' ? 'No se reenvió la operación original.' : operation === 'linkGuide' ? 'No se envió una nueva guía a Heka.' : 'Si el resultado no está confirmado, consulta el historial antes de reenviar.';
        throw new Error(`${cause.message} ${hint}`);
      }
      if (operation === 'linkGuide') {
        const linked = response.result;
        setLocalLinks(current => ({ ...current, [guide._id]: linked }));
        setFormNotice(`Guía ${linked.guideNumber} vinculada al pedido ${orderLabel(linked.orderNumber)}. No se registró un evento de entrega ni un movimiento de caja.`);
        setPending(null);
        onMutation?.();
        return;
      }
      setLatest(response.mutation); setPending(null);
      if (operation === 'createGuide' && ['succeeded', 'uncertain', 'sending'].includes(response.mutation.state)) {
        setDraft(EMPTY_FREIGHT); setClient({}); setDirty(false);
        if (response.mutation.state === 'succeeded') intent.current = null;
      } else if (operation === 'solveNovelty' && response.mutation.state === 'succeeded') {
        intent.current = null;
      }
      setTab('journal');
    });
  }
  const create = pending?.operation === 'createGuide', solve = pending?.operation === 'solveNovelty', link = pending?.operation === 'linkGuide';
  const reconcileGuide = pending?.operation === 'reconcile' && pending.context.operation === 'createGuide';
  const title = create ? 'Confirmar emisión de guía' : solve ? 'Confirmar solución de novedad' : link ? 'Vincular guía a pedido local' : 'Confirmar verificación en Heka';
  const action = create ? 'Emitir guía en Heka' : solve ? 'Enviar solución a Heka' : link ? 'Confirmar vinculación al pedido' : 'Verificar en Heka';
  const acknowledgement = create ? 'Revisé los datos y autorizo emitir esta guía en el entorno indicado.'
    : solve ? 'Revisé la solución y autorizo enviarla para que Heka gestione esta novedad.'
      : link ? 'Confirmo que la guía y la transportadora corresponden a este pedido.' : reconcileGuide ? 'Cotejé estos datos con el envío y confirmo que esta es la guía que deseo asociar a la solicitud.' : undefined;
  return <>
    {config.configured && <WorkspaceTabs label="Operaciones Heka" items={tabs} value={tab} onChange={changeTab} disabled={busy}/>}
    {!pending && <HekaAlert error={error}/>}
    {busy && !pending && <p role="status">Procesando solicitud Heka…</p>}
    {formNotice && <p role="status">{formNotice}</p>}
    {tab === 'guides' && <HekaGuides busy={busy} perform={perform} onStickers={prepareStickers} linking={linking}/>}
    {tab === 'freight' && <HekaFreight mode={mode} setMode={setMode} draft={draft} onDraft={setFreight} client={client} onClient={setRecipient} busy={busy} perform={perform} review={review}/>}
    {tab === 'lookups' && <HekaLookups busy={busy} perform={perform} onCity={applyCity} onWarehouse={applyWarehouse} onTemplate={applyTemplate}/>}
    {tab === 'customers' && <HekaCustomers busy={busy} perform={perform}/>}
    {tab === 'novelties' && <HekaNovelties busy={busy} perform={perform} review={review}/>}
    {tab === 'stickers' && <HekaStickers busy={busy} perform={perform} ids={stickers} onIds={setStickers}
      mode={stickerMode} onMode={setStickerMode} documentId={stickerDocument} onDocumentId={setStickerDocument}/>}
    {tab === 'journal' && <HekaJournal key={latest ? `${latest.requestId}:${latest.state}:${latest.reconciledAt ?? ''}` : 'journal'} config={config} busy={busy} readJournal={readJournal} onReview={reviewEvidence} latest={latest} linking={linking} headingRef={journalHeading} advisorFocus={catalogRequest?.focus}/>}
    {pending && <HekaConfirmation title={title} action={action} acknowledgement={acknowledgement} busy={busy} error={error} onClose={closeReview} onConfirm={confirm} disabled={link && !linkOrder} confirmationKey={link ? linkOrder?.id : undefined}
      advisorControl={create?'heka-guide-confirmation':solve?'heka-novelty-confirmation':link?'heka-link-confirmation':reconcileGuide?'heka-uncertain-guide-verification':'heka-uncertain-novelty-verification'} onStartAdvisor={()=>openAli({type:'revisión de Heka'})}>
      <HekaEnvironment environment={config.environment}/>
      {create ? <><p>Esta solicitud puede crear una guía para la transportadora indicada. El valor de una cotización no es un cargo confirmado. All Nutrition no modificará pedidos, inventario ni caja.</p><GuideReview input={pending.input}/></>
        : solve ? <><p>Heka enviará la novedad a revisión.{pending.context?.replacing ? ' El texto nuevo reemplazará la solución anterior.' : ''}</p><HekaValues items={ [['Guía', pending.context?.guide], ['ID de novedad', pending.input.id], ['Motivo informado', pending.context?.message], ['Solución a enviar', pending.input.solution]] }/></>
          : link ? <HekaLinkOrderReview guide={pending.guide} orderNumber={orderNumber} onOrderNumber={updateOrderNumber} order={linkOrder} onLookup={lookupOrder} busy={busy}/>
          : <><p>{reconcileGuide ? 'Heka verificará la guía indicada. Asociarla no demuestra que la solicitud original la creara y no emite otra guía.' : 'Se leerá la solución guardada en Heka para comprobar si coincide con la enviada. No se enviará una solución nueva.'}</p>
            <HekaValues items={ [['Solicitud', pending.input.requestId], ['ID de guía Heka', pending.input.guideId], ['Número de guía', pending.input.guideNumber]] }/></>}
      {pending.requestId && <p className="hint">Solicitud del panel: <code>{pending.requestId}</code></p>}
    </HekaConfirmation>}
  </>;
}

export default function HekaWorkspace({ api, onNavigate, onMutation, onInteractionStateChange, advisorTargetRequest, onAdvisorTargetHandled, catalogRequest }) {
  const [config, setConfig] = useState(null);
  const { busy, error, run } = useHekaRequest(api);
  function read() { void run(async request => setConfig(await request(HEKA_ROOT))); }
  useEffect(read, [api]);
  useEffect(() => {
    if (advisorTargetRequest?.capabilityId === 'heka.read-journal' && !config && error)
      onAdvisorTargetHandled?.(advisorTargetRequest.id, 'No pudimos consultar el historial local de Heka. Puedes reintentar desde el panel.');
  }, [advisorTargetRequest, config, error, onAdvisorTargetHandled]);
  return <section className={styles.workspace} aria-label="Operaciones de Heka oficial">
    <header className="workspace-heading"><div><h2 tabIndex={-1} data-advisor-control={config?'heka-official-workspace':undefined}>Despachos con Heka · API oficial</h2>
      <p>Consulta y opera en Heka sin abrir su portal. Puedes vincular guías de producción a un pedido existente; no se sincronizan estados automáticamente ni se registran movimientos financieros.</p></div>
      <button type="button" className="button subtle" onClick={() => onNavigate({ section: 'business', tab: 'shipping' })}>Configurar conexión Heka</button>
    </header>
    <HekaAlert error={error}/>
    {!config && (busy ? <p role="status">Consultando conexión Heka…</p> : <button type="button" className="button subtle" onClick={read}>Consultar conexión Heka</button>)}
    {config && <>
      <div tabIndex={-1} data-advisor-control="heka-connection-status">{config.configured ? <HekaEnvironment environment={config.environment}/> : <p>No hay una llave Heka configurada. Configúrala para operar; el historial del panel sigue disponible.</p>}</div>
      <Workbench key={config.version} api={api} config={config} onNavigate={onNavigate} onMutation={onMutation} onInteractionStateChange={onInteractionStateChange}
        advisorTargetRequest={advisorTargetRequest} onAdvisorTargetHandled={onAdvisorTargetHandled} catalogRequest={catalogRequest}/>
    </>}
  </section>;
}
