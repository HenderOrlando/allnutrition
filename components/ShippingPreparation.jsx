'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PACK_FIELDS, RECIPIENT_FIELDS, parsePackedMeasure, preparationValues } from '../lib/shipping/center-values.mjs';
import { formatMoneyMinor, parseMoneyMinor, pesosToMinor } from '../lib/business/money.mjs';
import ShippingRecipients from './ShippingRecipients';
import ShippingQuoteResults, { environmentLabel, locationLabel } from './ShippingQuoteResults';
import styles from './ShippingCenter.module.css';

const resource = '/api/admin/shipping/preparations';
const endpoint = '/api/admin/shipping/quotes';
const empty = preparationValues({});
const parcelText = parcel => Object.fromEntries(PACK_FIELDS.map(field=>[field.key,parcel?.[field.key]==null?'':String(parcel[field.key]/10**field.precision)]));
const cashText = amount => amount == null ? '' : String(amount/100);
const cash = value => value.trim() ? parseMoneyMinor(value.replace(',','.'),{decimalSeparator:'.',groupSeparator:''}) : null;
const form = draft => ({...draft, parcelText:parcelText(draft.parcel), declared:cashText(draft.payment.declaredMinor), collection:cashText(draft.payment.collectionMinor)});
const listed = response => response.rows ?? [];
const items = lines => lines.reduce((sum,line)=>sum+line.quantity,0);
const lineKey = line => `${line.kind}:${line.itemId}`;
const quoteDraft = ({route,parcel,payment,options})=>({route,parcel,payment,options});
const writeBody = ({id,version,orderId,orderVersion,shipmentId,shipmentVersion},draft,unitPatches,requestId) => ({...(id?{id,version}:{}),...(orderId?{orderId,orderVersion}:{}),...(shipmentId?{shipmentId,shipmentVersion}:{}),...draft,unitPatches,requestId});
const searchText = value => value.trim().normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('es');
const addressPlace = ({city,department}) => ({dane:null,city,state:department});
const samePlace = (a,b) => searchText(a.city)===searchText(b.city) && searchText(a.state)===searchText(b.state);
const hasPlace = place => Boolean(place.dane || place.city || place.state);

function Place({label,value,onChange}) {
  return <div className="settings-subform"><h5>{label}</h5><div className="product-form-grid">
    <label className="field">Municipio de {label.toLowerCase()}<input maxLength={100} value={value.city} onChange={e=>onChange({...value,city:e.target.value,dane:null})}/></label>
    <label className="field">Departamento de {label.toLowerCase()}<input maxLength={100} value={value.state} onChange={e=>onChange({...value,state:e.target.value,dane:null})}/></label>
    <label className="field">Código DANE de {label.toLowerCase()}<input inputMode="numeric" maxLength={16} value={value.dane ?? ''} onChange={e=>onChange({...value,dane:e.target.value,city:'',state:''})}/></label>
  </div></div>;
}

export default function ShippingPreparation({api,active,context,onInteractionStateChange,tools,onEmission,onConfigure,onOpenPreparation,onMutation,warehousePicker}) {
  const [draft,setDraft]=useState(()=>form(empty)),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false);
  const [problem,setProblem]=useState(''),[notice,setNotice]=useState(''),[ready,setReady]=useState(false),[retryContext,setRetryContext]=useState(0);
  const [connections,setConnections]=useState(null),[connectionError,setConnectionError]=useState(''),[connectionReload,setConnectionReload]=useState(0);
  const [environment,setEnvironment]=useState(''),[scope,setScope]=useState('all'),[quote,setQuote]=useState(null),[quoting,setQuoting]=useState(false),[sort,setSort]=useState('provider');
  const [catalog,setCatalog]=useState(null),[catalogError,setCatalogError]=useState(''),[catalogLoading,setCatalogLoading]=useState(false),[catalogQuery,setCatalogQuery]=useState('');
  const [known,setKnown]=useState(null),[knownError,setKnownError]=useState(''),[savedPage,setSavedPage]=useState(0),[savedReload,setSavedReload]=useState(0);
  const [chooseRecipient,setChooseRecipient]=useState(false),[contactInteraction,setContactInteraction]=useState({}),[unitEdits,setUnitEdits]=useState({}),[stageSave,setStageSave]=useState(null);
  const [measuresTouched,setMeasuresTouched]=useState({});
  const [pickProduct,setPickProduct]=useState(false),[pickWarehouse,setPickWarehouse]=useState(false),[warehouseName,setWarehouseName]=useState(null),[declaredTouched,setDeclaredTouched]=useState(false);
  const fieldId=useId();
  const productButton=useRef(null),recipientButton=useRef(null),warehouseButton=useRef(null);
  const request=useRef(null),saveIntent=useRef(null),catalogRequest=useRef(null),currentDraft=useRef(draft),resultTarget=useRef(null);
  currentDraft.current=draft;
  const {orderId,shipmentId,preparationId}=context;
  const invalidate=useCallback(()=>{request.current?.abort();request.current=null;setQuoting(false);setQuote(null);},[]);
  function update(patch, {invalidateQuote=true}={}) {
    if (invalidateQuote) invalidate();
    setDraft(value=>({...value,...(typeof patch==='function'?patch(value):patch),...(invalidateQuote?{offer:null}:{})}));
    setNotice('');setProblem('');setDirty(true);
  }
  function useRecipient(recipient) {
    update(value=>({recipient,route:{...value.route,destination:addressPlace(recipient)}}));
    setChooseRecipient(false);
    if(active)requestAnimationFrame(()=>recipientButton.current?.focus());
  }
  function editRecipient(key,input) {
    update(value=>{
      const recipient={...value.recipient,[key]:input}, {destination}=value.route;
      if(!['city','department'].includes(key) || destination.dane || hasPlace(destination)&&!samePlace(destination,addressPlace(value.recipient)))return {recipient};
      return {recipient,route:{...value.route,destination:addressPlace(recipient)}};
    },{invalidateQuote:['city','department'].includes(key)});
  }
  function setWarehouse(id,name) {
    update(old=>({options:{heka:{...old.options.heka,warehouse:id}}}));
    setWarehouseName(name ? {id,name} : null);setPickWarehouse(false);
    if(name)requestAnimationFrame(()=>warehouseButton.current?.focus());
  }
  function prepareEmission(){
    try {
      const data=values();
      if(draft.collectionNeedsConfirmation&&(data.payment.collectionMinor==null||!data.payment.collectionConfirmed))throw new Error('Indica y confirma el recaudo de este despacho antes de preparar la emisión.');
      if(draft.editable===false)throw new Error('Esta preparación ya no se puede usar para emitir.');
      return onEmission(data,null,{id:draft.id,version:draft.version,orderId:draft.orderId,shipmentId:draft.shipmentId});
    } catch(error){setProblem(error.message);return false;}
  }
  tools.current={recipient:draft.recipient,useRecipient,place(side,value){update(old=>({route:{...old.route,[side]:value}}));},warehouse:setWarehouse,template(template){
    const packed=Object.fromEntries([['weight','weightG'],['height','heightMm'],['long','lengthMm'],['width','widthMm']].filter(([wire])=>template[wire]>0).map(([wire,key])=>[key,String(template[wire])]));
    setMeasuresTouched(previous=>({...previous,...Object.fromEntries(Object.keys(packed).map(key=>[key,true]))}));
    if(template.declared_value!=null)setDeclaredTouched(true);
    update(old=>({parcelText:{...old.parcelText,...packed},
      route:{...old.route,...(template.city_destination?{destination:{dane:String(template.city_destination),city:'',state:''}}:{})},
      declared:template.declared_value!=null?String(template.declared_value):old.declared,
      payment:{...old.payment,...(typeof template.withshipping_cost==='boolean'?{includeShipping:template.withshipping_cost}:{}),...(template.type_payment?{payer:Number(template.type_payment)===2||template.withshipping_cost?'recipient':'sender'}:{})},
      ...(Number(template.type_payment)===3?{collection:'0'}:{}),
    }));
  }};
  useEffect(()=>{onInteractionStateChange?.({dirty:dirty||Boolean(stageSave)||Boolean(contactInteraction.dirty),busy:busy||Boolean(contactInteraction.busy)});},[dirty,stageSave,busy,contactInteraction,onInteractionStateChange]);
  useEffect(()=>()=>{request.current?.abort();catalogRequest.current?.abort();},[]);
  useEffect(()=>{
    const abort=new AbortController();
    setReady(false);setProblem('');
    const url=preparationId?`${resource}/${encodeURIComponent(preparationId)}`:orderId||shipmentId?`${resource}?${new URLSearchParams(Object.entries({orderId,shipmentId}).filter(([,value])=>value))}`:null;
    if (!url) {setReady(true);return;}
    api(url,{signal:abort.signal}).then(value=>{
      if(abort.signal.aborted)return;
      if(value.id){
        setMeasuresTouched(Object.fromEntries(PACK_FIELDS.filter(({key})=>value.parcel[key]!=null).map(({key})=>[key,true])));
        setDeclaredTouched(value.payment.declaredMinor!=null);
      }
      setDraft(form(value));setReady(true);
    }).catch(error=>{if(!abort.signal.aborted)setProblem(error.message);});
    return ()=>abort.abort();
  },[api,orderId,shipmentId,preparationId,retryContext]);
  useEffect(()=>{
    if (!active) return;
    const abort=new AbortController();
    api(endpoint,{signal:abort.signal}).then(({connections:rows})=>{if(!abort.signal.aborted){
      setConnections(rows);setConnectionError('');
      setEnvironment(value=>rows.some(row=>row.environment===value)?value:rows.some(row=>row.environment==='production')?'production':rows[0]?.environment ?? '');
      setScope(value=>value==='all'||rows.some(row=>row.id===value)?value:'all');
      setQuote(value=>value&&value.providers.every(provider=>rows.some(row=>row.id===provider.id&&row.version===provider.version&&row.environment===provider.environment))?value:null);
      setDraft(value=>value.offer&&!rows.some(row=>row.id===value.offer.providerId&&row.version===value.offer.version&&row.environment===value.offer.environment)?{...value,offer:null}:value);
    }}).catch(error=>{if(!abort.signal.aborted)setConnectionError(error.message);});
    return ()=>abort.abort();
  },[api,active,connectionReload]);
  useEffect(()=>{
    if (!active||!savedPage) return;
    const abort=new AbortController();
    api(`${resource}?page=${savedPage}`,{signal:abort.signal}).then(value=>{if(!abort.signal.aborted){setKnown(value);setKnownError('');}}).catch(error=>{if(!abort.signal.aborted)setKnownError(error.message);});
    return ()=>abort.abort();
  },[api,active,savedPage,savedReload]);

  async function loadCatalog() {
    if (catalogLoading||catalog) return;
    const abort=new AbortController();catalogRequest.current=abort;setCatalogLoading(true);setCatalogError('');
    try {
      const records=await Promise.all(['products','combos'].map(async kind=>(await api(`/api/admin/${kind}`,{signal:abort.signal})).records.map(row=>({...row,kind,itemId:row.id}))));
      if(!abort.signal.aborted)setCatalog(records.flat());
    } catch(error) {if(!abort.signal.aborted)setCatalogError(error.message);}
    finally {if(!abort.signal.aborted)setCatalogLoading(false);}
  }
  function adjustLines(lines) {
    const count=items(lines);
    const references=new Map((catalog??[]).map(row=>[lineKey(row),row]));
    const suggestions=Object.fromEntries(PACK_FIELDS.map(({name,key,precision,max})=>{
      if (key!=='weightG'&&count!==1) return [key,''];
      const weights=lines.map(line=>[references.get(lineKey(line))?.[name],line.quantity]);
      if (!weights.length||weights.some(([value])=>value==null)) return [key,''];
      const value=weights.reduce((sum,[minor,n])=>sum+minor*n,0);
      return [key,value<=max?String(value/10**precision):''];
    }));
    const knownTotal=lines.length&&lines.every(line=>line.unitPriceMinor!=null)?lines.reduce((sum,line)=>sum+line.unitPriceMinor*line.quantity,0):null;
    update(value=>({lines,parcelText:{...suggestions,...Object.fromEntries(Object.keys(measuresTouched).map(key=>[key,value.parcelText[key]]))},...(declaredTouched?{}:{declared:cashText(knownTotal)})}));
  }
  function add(row) {
    if (draft.lines.some(line=>lineKey(line)===lineKey(row))) return;
    if (draft.lines.length>=50) {setProblem('Se alcanzó el máximo de 50 referencias.');return;}
    adjustLines([...draft.lines,{kind:row.kind,itemId:row.id,lineId:null,quantity:1,title:row.title,unitPriceMinor:pesosToMinor(row.price)}]);
    setCatalogQuery('');setPickProduct(false);
    requestAnimationFrame(()=>productButton.current?.focus());
  }
  function values(checkQuote=false) {
    const {route,parcelText:packed,lines,recipient,payment,declared,collection,options,offer}=currentDraft.current;
    const parcel=Object.fromEntries(PACK_FIELDS.map(field=>[field.key,parsePackedMeasure(packed[field.key],field)]));
    const data=preparationValues({route,parcel,lines,recipient,payment:{...payment,declaredMinor:cash(declared),collectionMinor:cash(collection)},options,offer});
    if (checkQuote) {
      if (![route.origin,route.destination].every(place=>place.dane||place.city&&place.state)) throw new Error('Indica el DANE o el municipio y departamento de cada extremo.');
      if (PACK_FIELDS.some(({key})=>data.parcel[key]==null)) throw new Error('Completa el peso y las tres dimensiones del bulto.');
      if (data.payment.collectionMinor==null||data.payment.declaredMinor==null) throw new Error('Indica el valor declarado y el recaudo. Usa 0 si no se recauda.');
      if (currentDraft.current.collectionNeedsConfirmation&&!data.payment.collectionConfirmed) throw new Error('Confirma el recaudo de este despacho antes de cotizar.');
    }
    return data;
  }
  const available = connections?.filter(connection=>connection.environment===environment) ?? [];
  const selected = scope==='all'?available:available.filter(connection=>connection.id===scope);
  const environments=[...new Set((connections??[]).map(connection=>connection.environment))];
  const canQuote=selected.length>0&&!connectionError;
  const quoteLabel=connections?.length===1?`Cotizar con ${connections[0].label}`:'Solo cotizar';
  async function quoteNow(data, singleId=null) {
    const use=singleId?available.filter(connection=>connection.id===singleId):selected;
    if (!use.length) return;
    request.current?.abort();const abort=new AbortController();request.current=abort;
    const safe=quoteDraft(data);
    if(!singleId) setQuote(null);
    setQuoting(true);setProblem('');
    try {
      const result=await api(endpoint,{method:'POST',body:JSON.stringify({scope:singleId||scope!=='all'?'one':'all',...(singleId||scope!=='all'?{connectionId:singleId??scope}:{}),environment,expectedConnections:use,draft:safe}),signal:abort.signal});
      if(abort.signal.aborted)return;
      setQuote(previous=>({...result,draft:safe,providers:singleId&&previous?previous.providers.map(row=>row.id===singleId?(result.providers.find(next=>next.id===singleId)??row):row):result.providers}));
      requestAnimationFrame(()=>resultTarget.current?.focus());
    } catch(error) {if(!abort.signal.aborted){setProblem(error.message);if(error.status===409){setQuote(null);setScope('all');setConnections(null);setConnectionReload(value=>value+1);}}}
    finally {if(!abort.signal.aborted){setQuoting(false);request.current=null;}}
  }
  function submitQuote() {try {void quoteNow(values(true));}catch(error){setProblem(error.message);}}
  function buildSave(withQuote) {
    setProblem('');
    try {
      const data=values(withQuote);
      const patches=Object.values(unitEdits).map(({row,measures})=>{
        const fields=PACK_FIELDS.filter(field=>Object.hasOwn(measures,field.name));
        return {title:row.title,input:{kind:row.kind,itemId:row.id,version:row.version,...Object.fromEntries(fields.map(field=>[field.name,parsePackedMeasure(measures[field.name],field)]))}};
      }).filter(patch=>Object.keys(patch.input).length>3);
      if(patches.length) setStageSave({data,patches,withQuote});
      else void commitSave(data,[],withQuote);
    } catch(error) {setProblem(error.message);}
  }
  async function commitSave(data,patches,withQuote) {
    setStageSave(null);setBusy(true);setProblem('');
    const previous=currentDraft.current;
    const payload=writeBody(previous,data,patches.map(patch=>patch.input),null);
    const signature=JSON.stringify(payload);
    if(saveIntent.current?.signature!==signature)saveIntent.current={signature,id:crypto.randomUUID()};
    payload.requestId=saveIntent.current.id;
    try {
      const saved=await api(resource,{method:'POST',body:JSON.stringify(payload)});
      setDraft(form({...previous,...saved}));setDirty(false);setUnitEdits({});setSavedReload(value=>value+1);setNotice('Preparación guardada. No se creó una guía.');saveIntent.current=null;
      if(patches.length){setCatalog(null);onMutation?.();}
      if(withQuote) void quoteNow(data);
    } catch(error) {setProblem(error.status===409?`${error.message} Tus datos siguen en el formulario. Revisa la versión antes de intentar guardarlos de nuevo.`:error.message);}
    finally {setBusy(false);}
  }
  function useOffer(provider,offer) {
    if(!active||!quote||!offer.canEmit||!quote.providers.includes(provider))return;
    const {id:providerId,label:providerLabel,environment,version}=provider;
    const {carrier,service,total,amount,currency,days}=offer;
    try {
      const data=values(true);
      const reference={providerId,providerLabel,environment,version,carrier,service,total,amount,currency,days,quotedAt:provider.quotedAt??quote.quotedAt};
      if(onEmission(data,reference,{id:draft.id,version:draft.version,orderId:draft.orderId,shipmentId:draft.shipmentId})!==false)update({offer:reference},{invalidateQuote:false});
    } catch(error) {setProblem(error.message);}
  }
  const search=searchText(catalogQuery), catalogMatches=(catalog??[]).filter(row=>searchText(`${row.sku??''} ${row.title}`).includes(search)&&!draft.lines.some(line=>lineKey(line)===lineKey(row))).slice(0,12);
  const unitRows=(catalog??[]).filter(row=>draft.lines.some(line=>lineKey(line)===lineKey(row)));
  const locked=draft.editable===false||draft.frozen===true;
  const {recipient}=draft, hasRecipient=RECIPIENT_FIELDS.some(([key])=>recipient[key]);
  const suggestedDestination=addressPlace(recipient);
  const warehouse=draft.options.heka?.warehouse;
  if(!ready)return <section className="settings-card" aria-label="Preparar envío">{problem?<div role="alert" className="error">{problem} <button type="button" className="button subtle" onClick={()=>setRetryContext(value=>value+1)}>Reintentar lectura</button></div>:<p role="status">Cargando preparación…</p>}</section>;
  return <>
    <section className="settings-card" aria-label="Preparar envío">
      <h3 tabIndex={-1} data-advisor-control="heka-quote-form">Preparar envío</h3>
      <p>Elige producto y destinatario. Revisa solo lo que falte y reutiliza los datos al preparar la guía, sin volver a escribirlos.</p>
      {draft.orderId&&<p className="hint">Precarga: {draft.shipmentId?'pedido y unidades asignadas al envío local':'datos y líneas del pedido'}{draft.partial?' · despacho parcial':''}.</p>}
      {draft.provenance?.parcel&&draft.provenance.parcel!=='preparation'&&<p className="hint">{draft.provenance.parcel==='unit'?'Medidas propuestas desde el empaque registrado de la referencia.':'Peso sugerido a partir de las unidades asignadas; queda por medir la caja.'}</p>}
      {draft.id&&<p role="status">Preparación guardada · versión {draft.version}{locked?' · Solo lectura':''}</p>}
      <details onToggle={event=>{const open=event.currentTarget.open;setSavedPage(page=>open?page||1:0);}}><summary>Preparaciones guardadas</summary>
        {knownError&&<p className="error" role="alert">{knownError} <button type="button" className="text-button" onClick={()=>setSavedReload(value=>value+1)}>Reintentar</button></p>}
        {known&&!listed(known).length&&<p>No hay preparaciones guardadas.</p>}
        {listed(known??{}).map(row=><p key={row.id}><button type="button" className="button subtle" onClick={()=>onOpenPreparation(row.id)}>{row.recipient?.customerName||row.label||'Preparación'} · {locationLabel(row.route?.destination)} · {new Date(row.updatedAt).toLocaleDateString('es-CO')}</button></p>)}
        {known?.pager&&<nav className="admin-actions" aria-label="Páginas de preparaciones"><button type="button" className="button subtle" disabled={!known.pager.previousPage} onClick={()=>setSavedPage(known.pager.previousPage)}>Anterior</button><span>Página {known.pager.page}</span><button type="button" className="button subtle" disabled={!known.pager.nextPage} onClick={()=>setSavedPage(known.pager.nextPage)}>Siguiente</button></nav>}
      </details>
      <fieldset disabled={busy||locked||Boolean(stageSave)} className="editor-fieldset">
        <section className="form-section"><h4>Producto y destinatario</h4>
          <div className="product-form-grid">
            <div className="settings-subform">
              <h5>Productos y cantidades</h5>
              {draft.shipmentId&&draft.orderId&&<p className="hint">Estas cantidades vienen de la asignación del envío.</p>}
              {!draft.lines.length&&<p>Sin productos seleccionados.</p>}
              <ul className={styles.lineList}>{draft.lines.map((line,index)=><li key={line.lineId??lineKey(line)}><strong>{line.title||line.itemId}</strong>{draft.orderId?<span>× {line.quantity}</span>:<><label className="field">Cantidad<input type="number" min="1" max="999" value={line.quantity} onChange={event=>{const quantity=Number(event.target.value);if(Number.isInteger(quantity)&&quantity>=1&&quantity<=999)adjustLines(draft.lines.map((value,i)=>i===index?{...value,quantity}:value));}}/></label><button type="button" className="button subtle" onClick={()=>adjustLines(draft.lines.filter((_,i)=>i!==index))}>Quitar {line.title}</button></>}{line.unitPriceMinor!=null&&<small>{formatMoneyMinor(line.unitPriceMinor)} por unidad</small>}</li>)}</ul>
              {!draft.orderId&&<>
                <button ref={productButton} type="button" className="button subtle" aria-expanded={pickProduct} onClick={()=>{setPickProduct(!pickProduct);if(!pickProduct)void loadCatalog();}}>{pickProduct?'Cerrar catálogo':'Agregar producto o combo'}</button>
                {pickProduct&&<div className={styles.stack}><label className="field">SKU o nombre<input type="search" autoFocus value={catalogQuery} onChange={event=>setCatalogQuery(event.target.value)}/></label>
                  {catalogLoading&&<p role="status">Consultando referencias…</p>}{catalogError&&<p className="error" role="alert">{catalogError} <button type="button" className="button subtle" onClick={loadCatalog}>Reintentar</button></p>}
                  {catalog&&(!catalogMatches.length?<p>No hay referencias que coincidan.</p>:<ul className={styles.lineList}>{catalogMatches.map(row=><li key={lineKey(row)}><button type="button" className="button subtle" onClick={()=>add(row)}>Agregar {row.title}{row.sku?` · ${row.sku}`:''}</button></li>)}</ul>)}
                </div>}
              </>}
            </div>
            <div className="settings-subform">
              <h5>Destinatario</h5>
              <p aria-live="polite">{hasRecipient?[recipient.customerName,recipient.address,recipient.addressNotes,[recipient.city,recipient.department].filter(Boolean).join(', ')].filter(Boolean).join(' · '):'Sin destinatario seleccionado.'}</p>
              <button ref={recipientButton} type="button" className="button subtle" aria-expanded={chooseRecipient} onClick={()=>setChooseRecipient(value=>!value)}>{chooseRecipient?'Cerrar agenda':'Elegir destinatario'}</button>
              {chooseRecipient&&<p className="hint">Al elegir una dirección también se completa el municipio de destino.</p>}
            </div>
          </div>
          {chooseRecipient&&<ShippingRecipients api={api} currentRecipient={recipient} onUse={useRecipient} onInteractionStateChange={setContactInteraction}/>}
          <details><summary>Datos del destinatario para este despacho</summary>
            <p className="hint">Puedes completarlos a mano. Los datos personales no se envían al cotizar.</p>
            <div className="product-form-grid">{RECIPIENT_FIELDS.map(([key,label,max])=><label key={key} className="field">{label}<input maxLength={max} value={recipient[key]} onChange={event=>editRecipient(key,event.target.value)}/></label>)}</div>
          </details>
        </section>
        <section className="form-section"><h4>Ruta</h4><div className="product-form-grid">
          <Place label="Origen" value={draft.route.origin} onChange={origin=>update(value=>({route:{...value.route,origin}}))}/>
          <Place label="Destino" value={draft.route.destination} onChange={destination=>update(value=>({route:{...value.route,destination}}))}/>
          <label className="field">Tipo de entrega<select value={draft.route.deliveryType} onChange={event=>update({route:{...draft.route,deliveryType:event.target.value}})}><option value="address">Entrega en dirección</option><option value="office">Recoger en oficina</option></select></label>
        </div>
          {suggestedDestination.city&&suggestedDestination.state&&!samePlace(draft.route.destination,suggestedDestination)&&<button type="button" className="button subtle" onClick={()=>update(value=>({route:{...value.route,destination:suggestedDestination}}))}>Usar municipio del destinatario como destino</button>}
          {warehousePicker&&<>
            <p>{warehouse?`Bodega Heka: ${warehouseName?.id===warehouse?warehouseName.name:warehouse}`:'Elige la bodega Heka para no buscarla al preparar la guía.'}</p>
            <button ref={warehouseButton} type="button" className="button subtle" aria-expanded={pickWarehouse} onClick={()=>setPickWarehouse(value=>!value)}>{pickWarehouse?'Cerrar bodegas':warehouse?'Cambiar bodega Heka':'Elegir bodega Heka'}</button>
            {pickWarehouse&&warehousePicker(({_id,name})=>setWarehouse(_id,name))}
          </>}
        </section>
        <section className="form-section"><h4>Paquete</h4>
          <p className="hint">{items(draft.lines)>1?'El peso de las unidades es una sugerencia. Mide la caja completa; no se suman dimensiones.':draft.lines.length?'Cuando hay una sola unidad se propone su empaque medido.':'Registra las medidas reales de la caja.'}</p>
          <div className="product-form-grid">{PACK_FIELDS.map(field=>{
            const label=`${fieldId}-${field.key}`, missing=!draft.parcelText[field.key];
            return <label className="field" key={field.key}><span id={label}>{field.label} del bulto ({field.unit})</span>
              <input aria-labelledby={label} aria-describedby={missing?`${label}-missing`:undefined} inputMode="decimal" value={draft.parcelText[field.key]} onChange={event=>{setMeasuresTouched(value=>({...value,[field.key]:true}));update({parcelText:{...draft.parcelText,[field.key]:event.target.value}});}}/>
              {missing&&<small id={`${label}-missing`}>Falta medir</small>}
            </label>;
          })}</div>
          {!!draft.lines.length&&<details onToggle={event=>{if(event.currentTarget.open)void loadCatalog();}}><summary>Medidas unitarias para futuras ventas</summary><p className="hint">Son independientes de este bulto y solo se guardan tras confirmar las referencias.</p>
            {catalogLoading&&<p role="status">Consultando referencias…</p>}{catalogError&&<p className="error" role="alert">{catalogError} <button type="button" className="button subtle" onClick={loadCatalog}>Reintentar</button></p>}
            {unitRows.map(row=><div className="settings-subform" key={lineKey(row)}><h5>{row.title}</h5><div className="product-form-grid">{PACK_FIELDS.map(field=><label className="field" key={field.name}>{field.label} unitario ({field.unit})<input inputMode="decimal" value={unitEdits[lineKey(row)]?.measures[field.name]??(row[field.name]==null?'':String(row[field.name]/10**field.precision))} onChange={event=>{const value=event.target.value;setDirty(true);setUnitEdits(current=>({...current,[lineKey(row)]:{row,measures:{...current[lineKey(row)]?.measures,[field.name]:value}}}));}}/></label>)}</div></div>)}
          </details>}
        </section>
        <section className="form-section"><h4>Pago</h4>
          <div className="product-form-grid">
            <label className="field">Valor declarado (COP)<input inputMode="decimal" value={draft.declared} onChange={event=>{setDeclaredTouched(true);update({declared:event.target.value});}}/></label>
            <label className="field">Recaudo contraentrega (COP)<input inputMode="decimal" value={draft.collection} onChange={event=>update({collection:event.target.value,payment:{...draft.payment,collectionConfirmed:false}})}/></label>
            <label className="field">Quién paga el envío<select value={draft.payment.payer} onChange={event=>update({payment:{...draft.payment,payer:event.target.value}})}><option value="sender">Remitente</option><option value="recipient">Destinatario</option></select></label>
          </div>
          {draft.collection!=='0'&&<button type="button" className="button subtle" onClick={()=>update({collection:'0',payment:{...draft.payment,collectionConfirmed:false}})}>Sin recaudo</button>}
          <label className="checkbox-field"><input type="checkbox" checked={draft.payment.includeShipping} onChange={event=>update({payment:{...draft.payment,includeShipping:event.target.checked}})}/>Sumar costo del envío al recaudo</label>
          {draft.collectionNeedsConfirmation&&<label className="checkbox-field"><input type="checkbox" checked={draft.payment.collectionConfirmed} onChange={event=>update({payment:{...draft.payment,collectionConfirmed:event.target.checked}})}/>Confirmo el recaudo aplicable a este despacho (parcial o histórico por conciliar)</label>}
          {!!draft.orderId&&!draft.collectionNeedsConfirmation&&<p className="hint">El saldo pendiente del pedido se propone como recaudo; no determina el valor declarado.</p>}
        </section>
        {warehousePicker&&<details><summary>Opciones de Heka</summary><p className="hint">Si ya conoces el ID de la bodega, puedes ingresarlo aquí.</p><div className="product-form-grid">
          {['warehouse','seller'].map(key=><label className="field" key={key}>{key==='warehouse'?'Bodega Heka':'ID vendedor Heka'}<input maxLength={200} value={draft.options.heka?.[key]??''} onChange={event=>update({options:{heka:{...draft.options.heka,[key]:event.target.value}}})}/></label>)}
          {[['version','Versión de tarifa',['1','2']],['channel','Canal',['hekaentrega','loggy24']]].map(([key,label,options])=><label className="field" key={key}>{label}<select value={draft.options.heka?.[key]??''} onChange={event=>update({options:{heka:{...draft.options.heka,[key]:event.target.value||null}}})}><option value="">Predeterminado</option>{options.map(value=><option key={value}>{value}</option>)}</select></label>)}
        </div></details>}
        <section className="form-section"><h4>Plataformas para cotizar</h4>
          {connectionError?<p className="error" role="alert">{connectionError} <button type="button" className="button subtle" onClick={()=>setConnectionReload(value=>value+1)}>Reintentar conexiones</button></p>:connections===null?<p role="status">Consultando conexiones cotizadoras…</p>:!connections.length?<p>No hay plataformas cotizadoras conectadas. <button type="button" className="text-button" onClick={onConfigure}>Configurar proveedor</button></p>:<>
            {environments.length>1?<label className="field">Entorno a consultar<select value={environment} onChange={event=>{invalidate();setEnvironment(event.target.value);setScope('all');}}>{environments.map(value=><option key={value} value={value}>{environmentLabel(value)}</option>)}</select></label>:<p>{environmentLabel(environment)} · {available.map(row=>row.label).join(', ')}</p>}
            {available.length>1&&<label className="field">Plataformas<select value={scope} onChange={event=>{invalidate();setScope(event.target.value);}}><option value="all">Todas las conectadas ({available.length})</option>{available.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>}
          </>}
          <div className="admin-actions"><button type="button" className={`button ${canQuote?'subtle':'primary'}`} disabled={busy} onClick={()=>buildSave(false)}>Guardar preparación</button>{canQuote&&<><button type="button" className="button subtle" disabled={quoting} onClick={submitQuote}>{quoteLabel}{connections?.length===1?' · solo cotizar':''}</button><button type="button" className="button primary" disabled={quoting} onClick={()=>buildSave(true)}>Guardar y cotizar</button></>}</div>
          {warehousePicker&&<button type="button" className="button subtle" disabled={quoting} onClick={prepareEmission} aria-describedby="shipping-guide-uses-draft">Preparar emisión manual</button>}
          {warehousePicker&&<p id="shipping-guide-uses-draft" className="hint">La guía reutiliza esta preparación. Emitir requiere revisar y confirmar por separado.</p>}
        </section>
      </fieldset>
      {stageSave&&<section className="settings-subform" aria-label="Confirmar medidas unitarias"><h4>Actualizar estas referencias</h4><ul>{stageSave.patches.map(({title,input})=><li key={input.itemId}>{title} · {PACK_FIELDS.filter(field=>Object.hasOwn(input,field.name)).map(field=>`${field.label}: ${input[field.name]==null?'sin medir':`${input[field.name]/10**field.precision} ${field.unit}`}`).join(' · ')}</li>)}</ul><div className="admin-actions"><button type="button" className="button subtle" onClick={()=>setStageSave(null)}>Volver a revisar</button><button type="button" className="button primary" onClick={()=>commitSave(stageSave.data,stageSave.patches,stageSave.withQuote)}>Confirmar y guardar</button></div></section>}
      {draft.offer&&<p>Opción estimada seleccionada: {draft.offer.providerLabel} · {environmentLabel(draft.offer.environment)} · {draft.offer.carrier||'Sin transportadora'} · {new Date(draft.offer.quotedAt).toLocaleString('es-CO')}</p>}
      {notice&&<p role="status">{notice}</p>}{problem&&<p className="error" role="alert">{problem}</p>}{quoting&&<p role="status">Consultando tarifas…</p>}
    </section>
    <div ref={resultTarget} tabIndex={-1}><ShippingQuoteResults quote={quote} sort={sort} onSort={setSort} onUse={useOffer} onRetry={id=>quote&&quoteNow(quote.draft,id)} busy={busy||quoting}/></div>
  </>;
}
