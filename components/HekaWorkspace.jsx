'use client';

import { useEffect, useRef, useState } from 'react';
import WorkspaceTabs from './WorkspaceTabs';
import { HEKA_ROOT, HekaAlert, HekaConfirmation, HekaEnvironment, hekaOperation, useHekaInteraction, useHekaRequest } from './HekaPanel';
import { HekaValues } from './HekaForms';
import HekaFreight, { EMPTY_FREIGHT, GuideReview } from './HekaFreight';
import { HekaCustomers, HekaGuides, HekaLookups, HekaStickers, HekaWarehouseLookup } from './HekaLookups';
import ShippingPreparation from './ShippingPreparation';
import ShippingRecipients from './ShippingRecipients';
import ShippingNovelties from './ShippingNovelties';
import ShippingPushControl from './ShippingPushControl';
import { hekaShipmentInput } from '../lib/shipping/heka-api.mjs';
import HekaJournal from './HekaJournal';
import { HekaLinkOrderReview, orderLabel, parseOrderNumber } from './HekaOrderLink';
import { useAssistantBridge } from './AssistantBridge';
import styles from './HekaPanel.module.css';

const tabs = [
  ['guides','Guías'], ['freight','Cotizar'], ['customers','Destinatarios'], ['novelties','Novedades'],
].map(([id,label])=>({id,label}));
const tools = [['lookups','Datos de envío'],['stickers','Etiquetas PDF'],['journal','Historial de operaciones']];
const center = {section:'orders',tab:'heka'};
const cleanInteraction = {dirty:false,busy:false};
const testPhone = phone => typeof phone==='string' ? phone.replace(/\D/g,'') : '';

const catalogTabs = new Map([
  ['heka-guide-search', 'guides'], ['heka-quote-form', 'freight'],
  ['heka-link-guide-start', 'guides'], ['heka-linked-shipment', 'guides'],
  ['heka-guide-review', 'create'],
  ['heka-city-search', 'lookups'], ['heka-warehouse-search', 'lookups'], ['heka-template-search', 'lookups'],
  ['heka-copy-origin-city', 'lookups'], ['heka-copy-destination-city', 'lookups'],
  ['heka-copy-warehouse', 'lookups'], ['heka-apply-template', 'lookups'],
  ['heka-recipient-history-form', 'customers'], ['heka-recipient-rating-form', 'customers'],
  ['heka-novelty-search', 'novelties'],
  ['heka-novelty-review', 'novelties'],
  ['heka-guide-label-selection', 'guides'], ['heka-guide-label-download', 'stickers'], ['heka-saved-label-download', 'stickers'],
  ['heka-uncertain-guide-verification', 'journal'], ['heka-uncertain-novelty-verification', 'journal'],
]);

function Workbench({ api, config, view, shippingArrival, onNavigate, onPanel, onMutation, onInteractionStateChange, advisorTargetRequest, onAdvisorTargetHandled, catalogRequest, onShippingRead }) {
  const { requestOpen: openAli } = useAssistantBridge();
  const [override,setOverride]=useState(null),[humanGuides,setHumanGuides]=useState(false);
  const ali = shippingArrival==='ali';
  const defaultTab=ali?'journal':config.configured?'guides':'freight';
  const tab=override && override.arrival===shippingArrival && override.panel===view.panel ? override.tab : view.panel??defaultTab;
  const preparationTools=useRef({}),emissionPreparation=useRef(null),context=useRef({});
  if(['freight','create'].includes(view.panel))context.current={orderId:view.orderId,shipmentId:view.shipmentId,preparationId:view.preparationId};
  const preparationContext=context.current;
  const [prepared,setPrepared]=useState(cleanInteraction),[directory,setDirectory]=useState(cleanInteraction),[novelties,setNovelties]=useState(cleanInteraction);
  const [draft, setDraft] = useState(EMPTY_FREIGHT), [client, setClient] = useState({});
  const [stickers, setStickers] = useState(''), [pending, setPending] = useState(null), [latest, setLatest] = useState(null);
  const [stickerMode, setStickerMode] = useState('guide'), [stickerDocument, setStickerDocument] = useState('');
  const [dirty, setDirty] = useState(false), [formNotice, setFormNotice] = useState('');
  const [orderNumber, setOrderNumber] = useState(''), [linkOrder, setLinkOrder] = useState(null), [localLinks, setLocalLinks] = useState({});
  const [linkDrafts,setLinkDrafts]=useState([]),[linkDraft,setLinkDraft]=useState(''),[linkDraftWarning,setLinkDraftWarning]=useState('');
  const emittedPreparations=useRef(new Map());
  const intent = useRef(null);
  const { busy, error, setError, run } = useHekaRequest(api);
  useHekaInteraction(onInteractionStateChange, dirty || Boolean(pending) || prepared.dirty || directory.dirty || novelties.dirty, busy || prepared.busy || directory.busy || novelties.busy);
  const journalHeading = useRef(null);
  useEffect(() => {
    const request = advisorTargetRequest;
    if (request?.capabilityId !== 'heka.read-journal') return;
    if (dirty || pending || busy && tab !== 'journal') {
      onAdvisorTargetHandled?.(request.id, 'Termina o conserva tus cambios en Heka antes de abrir el historial.');
      return;
    }
    if (tab !== 'journal') {
      setOverride({arrival:shippingArrival,panel:view.panel,tab:'journal'});
      return;
    }
    if (busy) return;
    const frame = requestAnimationFrame(() => {
      journalHeading.current?.focus();
      onAdvisorTargetHandled?.(request.id, document.activeElement === journalHeading.current ? undefined : 'No pudimos enfocar el historial local de Heka.');
    });
    return () => cancelAnimationFrame(frame);
  }, [advisorTargetRequest, busy, dirty, onAdvisorTargetHandled, pending, shippingArrival, tab, view.panel]);
  useEffect(() => {
    const target = catalogTabs.get(catalogRequest?.focus);
    if (!target || pending || busy || directory.dirty || novelties.dirty) return;
    if (!config.configured && !['freight','customers','novelties','journal'].includes(target)) return;
    setOverride({arrival:shippingArrival,panel:view.panel,tab:target,suppressGuides:target==='guides'});
    if (catalogRequest.focus === 'heka-guide-label-download') setStickerMode('guide');
    if (catalogRequest.focus === 'heka-saved-label-download') setStickerMode('document');
  }, [catalogRequest, config.configured, pending, busy, directory.dirty, novelties.dirty, shippingArrival, view.panel]);
  function changeTab(next) {
    if (busy || pending || prepared.busy || directory.busy || novelties.busy) return;
    if (next==='guides') setHumanGuides(true);
    if (next===tab && !override) return;
    if (directory.dirty || novelties.dirty) {
      onNavigate({...center,panel:next,...(['freight','create'].includes(next)?preparationContext:{})});
      return;
    }
    setOverride(null);
    setError(''); setFormNotice('');
    onPanel(next,preparationContext);
  }
  function setFreight(name, value) { setDirty(true); setDraft(current => ({ ...current, [name]: value })); }
  function setRecipient(name, value) { setDirty(true); setClient(current => ({ ...current, [name]: value })); }
  function prepareStickers(ids) { setStickers(ids.join('\n')); setStickerMode('guide'); changeTab('stickers'); }
  function mayApply(message) {
    return !(prepared.dirty||dirty) || window.confirm(`${message} Los demás datos se conservarán.`);
  }
  function applyCity(name, dane) {
    const side=name==='city_origin'?'origin':'destination';
    if(!mayApply(`¿Reemplazar el ${side==='origin'?'origen':'destino'} del borrador?`))return;
    preparationTools.current.place?.(side,{dane:String(dane),city:'',state:''});
    setDraft(current=>({...current,[name]:String(dane)}));setFormNotice('Localidad elegida para la preparación y la revisión de guía.');
  }
  function applyWarehouse(id) {
    if(!mayApply('¿Cambiar la bodega del borrador?'))return;
    preparationTools.current.warehouse?.(id);setDraft(current=>({...current,warehouse:id}));setFormNotice('Bodega elegida para la preparación y la revisión de guía.');
  }
  function applyTemplate(template) {
    if(!mayApply('¿Reemplazar los campos indicados por la plantilla?'))return;
    preparationTools.current.template?.(template);
    setFormNotice('Plantilla aplicada al borrador de cotización. Revisa las medidas y el pago.');
  }
  function useDirectory(recipient) {
    preparationTools.current.useRecipient?.(recipient);
    changeTab('freight');
  }
  function useOffer(preparation, offer, local) {
    if(!config.configured || offer && (offer.providerId!=='heka'||offer.version!==config.version||offer.environment!==config.environment)) {
      setError('Cambió la conexión cotizadora. Actualiza la cotización antes de preparar la emisión.'); return false;
    }
    if(dirty&&!window.confirm('¿Reemplazar los datos editados de la revisión por los del borrador? No se emitirá una guía.'))return false;
    const {recipient, options, lines, parcel, payment}=preparation;
    const title=(lines.length===1?lines[0].title:lines.map(line=>`${line.quantity} × ${line.title}`).join(' · ')).slice(0,500);
    const shipping=hekaShipmentInput(preparation);
    for (const [field,wire] of [['weightG','weight'],['lengthMm','long'],['heightMm','height'],['widthMm','width']]) if(parcel[field]==null)shipping[wire]='';
    if(payment.declaredMinor==null)shipping.declared_value='';
    setDraft({...shipping,...(options.heka?.warehouse?{warehouse:options.heka.warehouse}:{}),...(options.heka?.version?{version:options.heka.version}:{}),distributor_id:offer?.carrier??'',product:title,quantity:lines.length?lines.reduce((n,line)=>n+line.quantity,0):''});
    setClient(config.environment==='test'?{}:{name:recipient.customerName,address:recipient.address,phone:testPhone(recipient.phone),email:recipient.email,document:recipient.documentNumber,type_document:['CC','PS','CE','NIT','PPT','PEP','CD'].includes(recipient.documentType)?recipient.documentType:'',note_destination:recipient.addressNotes});
    emissionPreparation.current=local;
    setDirty(true);changeTab('create');
    return true;
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
    setLinkDrafts([]);setLinkDraft('');setLinkDraftWarning('');
    setPending({ operation: 'linkGuide', guide });
  }
  function updateOrderNumber(value) { setOrderNumber(value); setLinkOrder(null); setError('');setLinkDraft('');setLinkDrafts([]);setLinkDraftWarning(''); }
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
      try {
        const offered=emittedPreparations.current.get(pending.guide._id);
        const saved=await request('/api/admin/shipping/preparations?'+new URLSearchParams({linkedOrderId:order.id}));
        const rows=saved.rows.filter(row=>!row.shipmentId);
        if(offered?.id&&!offered.orderId&&!offered.shipmentId){
          const read=await request('/api/admin/shipping/preparations/'+encodeURIComponent(offered.id));
          if(!read.orderId&&!read.shipmentId)rows.unshift(read);
        }
        setLinkDrafts(rows);
      } catch(cause) {if(cause.name!=='AbortError')setLinkDraftWarning('No se pudo leer la lista de preparaciones. Puedes vincular la guía sin una preparación.');}
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
      const selected=linkDrafts.find(row=>row.id===linkDraft);
      const input = operation === 'linkGuide' ? { orderNumber: linkOrder.number, guideId: guide._id, guideNumber: guide.guide_number, carrier: guide.distributor_id,...(selected?{preparationId:selected.id,preparationVersion:selected.version}:{}) } : pending.input;
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
        const reference=emissionPreparation.current,guideId=response.mutation.result?._id;
        if(guideId&&reference?.id)emittedPreparations.current.set(guideId,reference);
        emissionPreparation.current=null;
        setDraft(EMPTY_FREIGHT); setClient({}); setDirty(false);
        if (response.mutation.state === 'succeeded') intent.current = null;
      } else if (operation === 'solveNovelty' && response.mutation.state === 'succeeded') {
        intent.current = null;
      }
      setOverride(null);
      onPanel('journal',preparationContext);
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
    <WorkspaceTabs label="Centro de envíos" items={tabs} value={tab==='create'?'freight':tab} onChange={changeTab} disabled={busy||prepared.busy||directory.busy||novelties.busy}/>
    <div className="admin-actions" role="group" aria-label="Herramientas de envío">
      {tools.filter(([id])=>config.configured||id==='journal').map(([id,label])=><button key={id} className={`button ${tab===id?'primary':'subtle'}`} type="button" aria-pressed={tab===id} disabled={busy} onClick={()=>changeTab(id)}>{label}</button>)}
    </div>
    {!pending && <HekaAlert error={error}/>}
    {busy && !pending && <p role="status">Procesando solicitud Heka…</p>}
    {formNotice && <p role="status">{formNotice}</p>}
    {config.configured&&<HekaGuides api={api} config={config} active={tab==='guides'} enabled={humanGuides||!ali&&!override?.suppressGuides&&!catalogRequest&&!advisorTargetRequest} busy={busy} onStickers={prepareStickers} linking={linking}/>}
    {tab==='guides'&&!config.configured&&<section className="settings-card"><h3>Guías</h3><p>Conecta Heka oficial para consultar guías del proveedor.</p></section>}
    <div hidden={tab!=='freight'}><ShippingPreparation key={[preparationContext.orderId,preparationContext.shipmentId,preparationContext.preparationId].join(':')} api={api} active={tab==='freight'} context={preparationContext} onInteractionStateChange={setPrepared} tools={preparationTools}
      onEmission={useOffer} onConfigure={()=>onNavigate({section:'business',tab:'shipping'})} onOpenPreparation={preparationId=>onNavigate({...center,panel:'freight',preparationId})} onMutation={onMutation}
      warehousePicker={config.configured ? onWarehouse=><HekaWarehouseLookup busy={busy} perform={perform} onWarehouse={onWarehouse}/> : null}/></div>
    {tab==='create'&&config.configured&&<HekaFreight draft={draft} onDraft={setFreight} client={client} onClient={setRecipient} busy={busy} review={review} onBack={()=>changeTab('freight')} environment={config.environment}/>}
    {tab==='create'&&!config.configured&&<p>Configura Heka oficial antes de preparar una emisión.</p>}
    {tab==='lookups'&&config.configured&&<HekaLookups busy={busy} perform={perform} onCity={applyCity} onWarehouse={applyWarehouse} onTemplate={applyTemplate}/>}
    {tab==='customers'&&<><ShippingRecipients api={api} currentRecipient={preparationTools.current.recipient} onUse={useDirectory} onInteractionStateChange={setDirectory}/>{config.configured&&<HekaCustomers busy={busy} perform={perform}/>}</>}
    {tab==='novelties'&&<ShippingNovelties key={view.eventId??'inbox'} api={api} config={config} busy={busy} review={review} onRead={onShippingRead} eventId={view.eventId} onClearEvent={()=>onPanel('novelties',preparationContext)}
      onOpenShipment={record=>onNavigate({section:'orders',tab:'shipments',record})} pushControl={<ShippingPushControl api={api} config={config}/>} advisorFocus={catalogRequest?.focus} onInteractionStateChange={setNovelties}/>}
    {tab==='stickers'&&config.configured&&<HekaStickers busy={busy} perform={perform} ids={stickers} onIds={setStickers}
      mode={stickerMode} onMode={setStickerMode} documentId={stickerDocument} onDocumentId={setStickerDocument}/>}
    {tab==='journal'&&<HekaJournal key={latest ? `${latest.requestId}:${latest.state}:${latest.reconciledAt ?? ''}` : 'journal'} config={config} busy={busy} readJournal={readJournal} onReview={reviewEvidence} latest={latest} linking={linking} headingRef={journalHeading} advisorFocus={catalogRequest?.focus}/>}
    {pending && <HekaConfirmation title={title} action={action} acknowledgement={acknowledgement} busy={busy} error={error} onClose={closeReview} onConfirm={confirm} disabled={link && !linkOrder} confirmationKey={link ? `${linkOrder?.id}:${linkDraft}` : undefined}
      advisorControl={create?'heka-guide-confirmation':solve?'heka-novelty-confirmation':link?'heka-link-confirmation':reconcileGuide?'heka-uncertain-guide-verification':'heka-uncertain-novelty-verification'} onStartAdvisor={()=>openAli({type:'revisión de Heka'})}>
      <HekaEnvironment environment={config.environment}/>
      {create ? <><p>Esta solicitud puede crear una guía para la transportadora indicada. El valor de una cotización no es un cargo confirmado. All Nutrition no modificará pedidos, inventario ni caja.</p><GuideReview input={pending.input}/></>
        : solve ? <><p>Heka enviará la novedad a revisión.{pending.context?.replacing ? ' El texto nuevo reemplazará la solución anterior.' : ''}</p><HekaValues items={ [['Guía', pending.context?.guide], ['ID de novedad', pending.input.id], ['Motivo informado', pending.context?.message], ['Solución a enviar', pending.input.solution]] }/></>
          : link ? <><HekaLinkOrderReview guide={pending.guide} orderNumber={orderNumber} onOrderNumber={updateOrderNumber} order={linkOrder} onLookup={lookupOrder} busy={busy}/>
            {linkDraftWarning&&<p role="status">{linkDraftWarning}</p>}
            {linkDrafts.length>0&&<label className="field">Preparación para el envío confirmado<select disabled={busy} value={linkDraft} onChange={event=>{setLinkDraft(event.target.value);setPending(value=>({...value,requestId:crypto.randomUUID()}));}}><option value="">No asociar una preparación</option>{linkDrafts.map(row=><option key={row.id} value={row.id}>{row.lines.map(line=>`${line.quantity} × ${line.title}`).join(' · ')||'Sin referencias'} · {new Date(row.updatedAt).toLocaleString('es-CO')}</option>)}</select></label>}
          </>
          : <><p>{reconcileGuide ? 'Heka verificará la guía indicada. Asociarla no demuestra que la solicitud original la creara y no emite otra guía.' : 'Se leerá la solución guardada en Heka para comprobar si coincide con la enviada. No se enviará una solución nueva.'}</p>
            <HekaValues items={ [['Solicitud', pending.input.requestId], ['ID de guía Heka', pending.input.guideId], ['Número de guía', pending.input.guideNumber]] }/></>}
      {pending.requestId && <p className="hint">Solicitud del panel: <code>{pending.requestId}</code></p>}
    </HekaConfirmation>}
  </>;
}

export default function HekaWorkspace({ api, view, onNavigate, onPanel, onMutation, onInteractionStateChange, advisorTargetRequest, onAdvisorTargetHandled, catalogRequest, shippingArrival, onShippingRead }) {
  const [config, setConfig] = useState(null);
  const { busy, error, run } = useHekaRequest(api);
  function read() { void run(async request => setConfig(await request(HEKA_ROOT))); }
  useEffect(read, [api]);
  useEffect(() => {
    if (advisorTargetRequest?.capabilityId === 'heka.read-journal' && !config && error)
      onAdvisorTargetHandled?.(advisorTargetRequest.id, 'No pudimos consultar el historial local de Heka. Puedes reintentar desde el panel.');
  }, [advisorTargetRequest, config, error, onAdvisorTargetHandled]);
  return <section className={styles.workspace} aria-label="Centro de envíos">
    <header className="workspace-heading"><div><h2 tabIndex={-1} data-advisor-control={config?'heka-official-workspace':undefined}>Centro de envíos</h2>
      <p>Consulta guías del proveedor, prepara paquetes y compara tarifas. El seguimiento local de pedidos y las acciones remotas se mantienen separados.</p></div>
      <button type="button" className="button subtle" onClick={() => onNavigate({ section: 'business', tab: 'shipping' })}>Configurar conexión Heka</button>
    </header>
    <HekaAlert error={error}/>
    {!config && (busy ? <p role="status">Consultando conexión Heka…</p> : <button type="button" className="button subtle" onClick={read}>Consultar conexión Heka</button>)}
    {config && <>
      <div tabIndex={-1} data-advisor-control="heka-connection-status">{config.configured ? <HekaEnvironment environment={config.environment}/> : <p>No hay una llave Heka configurada. Configúrala para operar; el historial del panel sigue disponible.</p>}</div>
      <Workbench key={`${config.environment}:${config.version}`} api={api} config={config} view={view} shippingArrival={shippingArrival} onNavigate={onNavigate} onPanel={onPanel} onMutation={onMutation} onInteractionStateChange={onInteractionStateChange}
        advisorTargetRequest={advisorTargetRequest} onAdvisorTargetHandled={onAdvisorTargetHandled} catalogRequest={catalogRequest} onShippingRead={onShippingRead}/>
    </>}
  </section>;
}
