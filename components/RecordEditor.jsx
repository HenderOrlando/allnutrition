'use client';
import { useState,useRef,useEffect,useMemo } from 'react';
import { schemas,slugify,emptyRecord,contentStates,money } from '@/lib/schema.mjs';
import { formatMoneyMinor, MAX_MONEY_MINOR } from '@/lib/business/money.mjs';
import { stockAvailable } from '@/lib/inventory.mjs';
import { Field, ProductComponents } from './Fields';
import Icon from './Icons';
import useDialog from './useDialog';
import styles from './CatalogExperience.module.css';
import configurationStyles from './ConfigurationExperience.module.css';
const productSections=[
 {key:'basics',title:'Información básica',description:'Completa el nombre, la presentación y el precio.',fields:['title','slug','presentation','price']},
 {key:'inventory',title:'Existencias y reservas',description:'Registra el conteo físico. Los pedidos reservan unidades; el despacho las descuenta y las devoluciones recuperables las reingresan.',fields:['stockQuantity']},
 {key:'image',title:'Imagen del producto',description:'Sube una imagen optimizada o ingresa una URL pública.',fields:['image'],singleColumn:true},
 {key:'description',title:'Descripción',description:'Describe el contenido y los datos aprobados para mostrar al cliente.',fields:['flavor','description','productInfo']},
 {key:'costs',title:'Costos y obsequios',description:'Datos internos para trabajar con pedidos, sin obligación de publicar.',fields:[],collapsible:true},
 {key:'publication',title:'Organización y publicación',description:'Asigna catálogos y decide si se publica, se destaca o queda como borrador.',fields:['status','sort','featured','catalogIds']}
];
const publicationHelp={
 draft:'El borrador no es visible en la vitrina.',
 published:'El contenido publicado aparece en la vitrina cuando la publicación global está aprobada.',
 archived:'El contenido archivado se conserva y permanece oculto.'
};
const contentSections={
 combos:[
  {key:'basics',title:'Datos de la oferta',description:'Define el nombre y el precio final del combo. El precio no se calcula a partir de sus productos.',fields:['title','description','price']},
  {key:'components',title:'Productos del combo',description:'Añade cada referencia una sola vez e indica cuántas unidades incluye.',fields:['items'],singleColumn:true},
  {key:'presentation',title:'Imagen y condiciones',description:'Usa una imagen pública e indica los límites o condiciones confirmadas de la oferta.',fields:['image','conditions'],singleColumn:true},
  {key:'publication',title:'Organización y publicación',description:'Asigna catálogos, revisa la dirección corta y elige la visibilidad del combo.',fields:['slug','status','sort','catalogIds']}
 ],
 catalogs:[
  {key:'basics',title:'Datos de la colección',description:'Explica qué productos agrupa este catálogo. Los productos se asignan desde sus propias fichas.',fields:['title','description'],singleColumn:true},
  {key:'image',title:'Portada del catálogo',description:'Ingresa un enlace HTTPS público y comprueba la imagen antes de guardar.',fields:['image'],singleColumn:true},
  {key:'publication',title:'Organización y publicación',description:'Revisa la dirección corta, el orden y la visibilidad de la colección.',fields:['slug','status','sort']}
 ],
 faqs:[
  {key:'answer',title:'Pregunta y respuesta',description:'Redacta una pregunta concreta y una respuesta confirmada por el negocio.',fields:['title','answer'],singleColumn:true},
  {key:'publication',title:'Organización y publicación',description:'Decide si la respuesta queda en borrador o se muestra en la vitrina.',fields:['slug','status','sort']}
 ],
 messages:[
  {key:'content',title:'Texto del mensaje',description:'Escribe el título y el texto que se mostrarán en la web; no se envían mensajes ni campañas.',fields:['title','body'],singleColumn:true},
  {key:'placement',title:'Ubicación y botón',description:'Elige dónde aparece. El botón, si tiene texto, abre el WhatsApp configurado.',fields:['placement','buttonText']},
  {key:'publication',title:'Organización y publicación',description:'Revisa la dirección corta, el orden y la visibilidad del mensaje.',fields:['slug','status','sort']}
 ],
 shipping:[
  {key:'coverage',title:'Cobertura y tiempos',description:'Describe la zona atendida y un tiempo de entrega confirmado, sin prometer cobertura adicional.',fields:['title','zone','estimatedTime']},
  {key:'conditions',title:'Costos y condiciones',description:'Explica cómo se acuerda el costo, cuándo aplica la contraentrega y las excepciones conocidas.',fields:['costText','cashOnDelivery','details'],singleColumn:true},
  {key:'publication',title:'Organización y publicación',description:'Estos datos informan al cliente: no crean despachos, cotizaciones ni guías.',fields:['slug','status','sort']}
 ]
};
const fieldHelp={
 slug:'Se propone a partir del nombre al crear. Usa una dirección breve, sin espacios.',
 sort:'Los números menores aparecen primero.',
 catalogIds:'Puedes seleccionar varios catálogos. La asignación no cambia la publicación de esta ficha.',
 buttonText:'Déjalo vacío si no necesitas un botón de contacto.',
 items:'Solo productos normales, sin repetir referencias. Cantidades de 1 a 999 por referencia.'
};

export default function RecordEditor({kind,record,all,api,onClose,onSaved,onReload,onInteractionStateChange}){
 const schema=schemas[kind];
 const configurationContent=['faqs','messages','shipping'].includes(kind);
 const [initialForm]=useState(()=>({...emptyRecord(kind),...record}));
 const [form,setForm]=useState(initialForm),[busy,setBusy]=useState(false),[uploadingImage,setUploadingImage]=useState(false),[error,setError]=useState(null);
 const [invalidCostDraft,setInvalidCostDraft]=useState(false);
 const initialSnapshot=useMemo(()=>JSON.stringify(initialForm),[initialForm]);
 const dirty=useMemo(()=>invalidCostDraft||JSON.stringify(form)!==initialSnapshot,[form,initialSnapshot,invalidCostDraft]);
 const interactionBusy=busy||uploadingImage;
 const dialog=useRef(null),errorSummary=useRef(null);
 const close=useDialog(dialog,{busy:interactionBusy,dirty,onClose});
 const sections=kind==='products'?productSections:contentSections[kind];
 const fieldByName=useMemo(()=>new Map(schema.fields.map(field=>[field.name,field])),[schema]);
 const [activeSection,setActiveSection]=useState(sections[0].key);
 useEffect(()=>{onInteractionStateChange({dirty,busy:interactionBusy});},[dirty,interactionBusy,onInteractionStateChange]);
 useEffect(()=>()=>onInteractionStateChange({dirty:false,busy:false}),[onInteractionStateChange]);
 useEffect(()=>{if(error)errorSummary.current?.focus();},[error]);

 const change=(field,value)=>setForm(old=>({...old,[field]:value,
  ...(field==='title'&&!record.id&&(!old.slug||old.slug===slugify(old.title))?{slug:slugify(value)}:{}),
  ...(kind==='products'&&field==='productType'?(value==='gift'?{unitCostMinor:null,costEffectiveOn:null,...(!record.id?{orderable:true}:{})}:{items:[],...(!record.id?{orderable:old.status==='published'}:{})}):{}),
  ...(kind==='products'&&field==='status'&&value==='published'&&!record.id&&(old.productType||'product')==='product'?{orderable:true}:{})
 }));
 function goToSection(key){
  setActiveSection(key);
  const heading=dialog.current?.querySelector(`#form-section-${key}`);
  const details=heading?.closest('details');if(details)details.open=true;
  heading?.focus({preventScroll:true});
  heading?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
 }
 function showError(failure){setError({message:failure.message,status:failure.status});}
 async function save(event){
  event.preventDefault();
  if(interactionBusy)return;
  setBusy(true);setError(null);
  let saved;
  try{
   saved=await api(`/api/admin/${kind}${record.id?`/${record.id}`:''}`,{method:record.id?'PUT':'POST',body:JSON.stringify(form)});
  }catch(failure){showError(failure);return;}
  finally{setBusy(false);}
  await onSaved({kind,record:saved,operation:record.id?'update':'create'});
 }
 async function remove(){
  if(interactionBusy||!record.id||!window.confirm(`¿Eliminar este ${schema.singular}? Esta acción es irreversible y no se puede deshacer.`))return;
  setBusy(true);setError(null);
  try{
   await api(`/api/admin/${kind}/${record.id}`,{method:'DELETE',body:JSON.stringify({version:record.version})});
  }catch(failure){showError(failure);return;}
  finally{setBusy(false);}
  await onSaved({kind,record,operation:'delete'});
 }
 async function reload(){
  if(interactionBusy)return;
  setBusy(true);
  try{await onReload();}
  catch(failure){showError(failure);}
  finally{setBusy(false);}
 }

 const renderField=field=><Field key={field.name} field={{...field,...(field.name==='stockQuantity'?{min:record.stockReserved||0,required:record.stockQuantity!=null}:{}),description:field.name==='status'?publicationHelp[form.status]:field.description||fieldHelp[field.name]}} value={form[field.name]} onChange={value=>{if(field.name==='productType')setInvalidCostDraft(false);change(field.name,value);}} all={all} api={api} onUploading={setUploadingImage} onDraftInvalid={setInvalidCostDraft}/>;
 const publication=contentStates.find(state=>state.value===form.status)?.label;
 const isGift=kind==='products'&&form.productType==='gift';
 const priceDefined=Number(form.price)>0;
 const validPrice=priceDefined||(isGift&&form.price===0);
 const componentProducts=all.products||[];
 const availableUnits=stockAvailable(form,componentProducts);
 const componentLines=(form.items||[]).map(item=>({...item,product:componentProducts.find(product=>product.id===item.productId)}));
 const validComponents=componentLines.length>0&&componentLines.every(item=>item.product&&item.product.id!==record.id&&(item.product.productType||'product')==='product'&&Number.isInteger(item.quantity)&&item.quantity>=1&&item.quantity<=999)&&new Set(componentLines.map(item=>item.productId)).size===componentLines.length;
 const missingCosts=componentLines.filter(item=>!Number.isSafeInteger(item.product?.unitCostMinor)||item.product.unitCostMinor<0);
 const knownComponentCost=componentLines.filter(item=>Number.isSafeInteger(item.product?.unitCostMinor)&&item.product.unitCostMinor>=0&&Number.isInteger(item.quantity)&&item.quantity>=1&&item.quantity<=999).reduce((sum,item)=>sum+BigInt(item.product.unitCostMinor)*BigInt(item.quantity),0n);
 const componentCostComplete=validComponents&&missingCosts.length===0;
 const componentCostInRange=knownComponentCost>=0n&&knownComponentCost<=BigInt(MAX_MONEY_MINOR);
 const componentCost=<div className="hint" aria-live="polite">
  <p><strong>{componentCostComplete?'Costo de los componentes':'Costo de los componentes por completar'}:</strong> {componentCostComplete&&componentCostInRange?formatMoneyMinor(Number(knownComponentCost)):'Sin total completo'}</p>
  {!componentCostComplete&&knownComponentCost>0n&&componentCostInRange&&<p>Subtotal conocido (no es el costo total): {formatMoneyMinor(Number(knownComponentCost))}</p>}
  {!validComponents&&<p>Selecciona productos normales, sin repetir referencias, con cantidades entre 1 y 999.</p>}
  {missingCosts.length>0&&<><p>Falta registrar costo en:</p><ul>{missingCosts.map((item,index)=><li key={index}>{item.product?.title||'Producto sin seleccionar'}{item.product?.presentation?` · ${item.product.presentation}`:''}</li>)}</ul></>}
  {!componentCostInRange&&<p>El costo supera el límite permitido.</p>}
  <p className="small muted">Se usan los costos de las fichas actuales. El costo histórico de cada pedido se conserva por separado; cambiar esta ficha no modifica pedidos existentes.</p>
 </div>;
 const checklist=kind==='products'?[
  {label:'Imagen del producto',complete:!!String(form.image||'').trim()},
  {label:'Presentación',complete:!!String(form.presentation||'').trim()},
  {label:isGift?'Precio válido (puede ser cero)':'Precio mayor que cero',complete:validPrice},
  ...(isGift?[{label:'Componentes válidos del obsequio',complete:validComponents}]:[])
 ]:kind==='combos'?[
  {label:'Productos incluidos',complete:validComponents},
  {label:'Precio mayor que cero',complete:priceDefined}
 ]:schema.fields.filter(field=>field.required).map(field=>({label:field.label,complete:!!String(form[field.name]??'').trim()}));
 const summary=<>
  <h3>Así va tu ficha</h3>
  <dl className="summary-values">
   <div><dt>{kind==='faqs'?'Pregunta':'Título'}</dt><dd>{String(form.title||'').trim()||'Sin título'}</dd></div>
   {kind==='products'&&<div><dt>Presentación</dt><dd>{String(form.presentation||'').trim()||'Sin presentación'}</dd></div>}
   {kind==='products'&&form.flavor&&<div><dt>Sabor</dt><dd>{form.flavor}</dd></div>}
   {fieldByName.has('description')&&<div><dt>Descripción</dt><dd>{String(form.description||'').trim()||'Sin descripción'}</dd></div>}
   {kind==='faqs'&&<div><dt>Respuesta</dt><dd>{String(form.answer||'').trim()||'Sin respuesta'}</dd></div>}
   {kind==='messages'&&<>
    <div><dt>Ubicación</dt><dd>{fieldByName.get('placement').options.find(option=>option.value===form.placement)?.label}</dd></div>
    <div><dt>Texto de apoyo</dt><dd>{String(form.body||'').trim()||'Sin texto de apoyo'}</dd></div>
   </>}
   {kind==='shipping'&&<>
    <div><dt>Zona / cobertura</dt><dd>{String(form.zone||'').trim()||'Sin cobertura definida'}</dd></div>
    <div><dt>Costo</dt><dd>{String(form.costText||'').trim()||'Sin condiciones de costo'}</dd></div>
    <div><dt>Tiempo estimado</dt><dd>{String(form.estimatedTime||'').trim()||'Sin tiempo estimado'}</dd></div>
   </>}
   {fieldByName.has('price')&&<div><dt>Precio</dt><dd>{validPrice?money(form.price):'Precio sin definir'}{isGift&&form.price===0?' · Obsequio sin cobro':''}</dd></div>}
   {kind==='products'&&!isGift&&<><div><dt>Existencias físicas</dt><dd>{form.stockQuantity??'Sin contar'}</dd></div><div><dt>Reservadas en pedidos</dt><dd>{record.stockReserved||0}</dd></div></>}
   {['products','combos'].includes(kind)&&<div><dt>{kind==='combos'||isGift?'Posibles con sus componentes':'Disponibles para nuevos pedidos'}</dt><dd>{availableUnits??'Existencias sin contar'}</dd></div>}
   {kind==='products'&&<div><dt>Uso en pedidos</dt><dd>{form.orderable?'Habilitado (sujeto a disponibilidad)':'No habilitado'}{isGift&&form.status!=='published'?' · Obsequio privado':''}</dd></div>}
   {(kind==='combos'||isGift)&&<div><dt>Componentes</dt><dd>{form.items?.length?<ul>{form.items.map((item,index)=><li key={index}>{item.quantity} × {componentProducts.find(product=>product.id===item.productId)?.title||'Referencia sin seleccionar'}</li>)}</ul>:'Sin productos incluidos'}</dd></div>}
   <div><dt>Publicación</dt><dd>{publication}</dd></div>
  </dl>
  <p className="hint">{publicationHelp[form.status]}</p>
  {!!checklist.length&&<>
   <h4>Revisión de la ficha</h4>
   <p className={styles.checklistCount}>{checklist.filter(item=>item.complete).length} de {checklist.length} comprobaciones completas</p>
   <ul className="publication-checklist">{checklist.map(item=><li key={item.label} data-complete={item.complete}>{item.complete&&<Icon name="check" size={16}/>}<span>{item.label}: {item.complete?'completo':'pendiente'}</span></li>)}</ul>
   <p className="small muted">Orientación informativa, no aprobación comercial. Guardar respeta las validaciones del formulario y del estado de publicación elegido.</p>
  </>}
 </>;

 return (
  <dialog ref={dialog} className={`editor-drawer ${styles.editor}${configurationContent?' '+configurationStyles.contentEditor:''}`} aria-labelledby="editor-title">
   <header role={configurationContent?'presentation':undefined}>
    <div><p className="eyebrow">{schema.label}</p><h2 id="editor-title" tabIndex="-1" data-dialog-initial-focus>{record.id?'Editar':'Crear'} {schema.singular}</h2><p className="unsaved-flag" role="status">{dirty?'Cambios sin guardar':'Sin cambios pendientes'}</p></div>
    <button type="button" className="icon-button" aria-label="Cerrar editor" onClick={close} disabled={interactionBusy}><Icon name="close"/></button>
   </header>
   <form onSubmit={save} aria-busy={interactionBusy}>
    <fieldset className="editor-fieldset" disabled={interactionBusy}>
     <div className="drawer-body">
      {error&&<div ref={errorSummary} className="editor-error error" role="alert" tabIndex="-1"><p>{error.message}</p>{error.status===409&&record.id&&<button type="button" className="button subtle" onClick={reload} disabled={interactionBusy}>Cargar versión guardada</button>}</div>}
      <p className="hint">{schema.help}</p>
      <p className="small muted">Los campos con <span className="required">*</span> son obligatorios. Revisa las secciones y el resumen antes de guardar. Elegir «Publicado» aplica la visibilidad al guardar, si la vitrina global está habilitada.</p>
      <div className="editor-jump"><label htmlFor="editor-section">Ir a sección del formulario</label><select id="editor-section" name="editorSection" value={activeSection} onChange={event=>goToSection(event.target.value)}>{sections.map(section=><option key={section.key} value={section.key}>{section.title}</option>)}</select></div>
      <details className="editor-mobile-summary"><summary>Así va tu ficha</summary>{summary}</details>
      <div className="editor-layout">
       <nav className="editor-index" aria-label="Secciones del formulario">{sections.map((section,index)=><a key={section.key} href={`#form-section-${section.key}`} aria-current={activeSection===section.key?'location':undefined} onClick={event=>{event.preventDefault();goToSection(section.key);}}><span className={styles.sectionNumber} aria-hidden="true">{index+1}</span>{section.title}</a>)}</nav>
       <div className="editor-fields">
        {sections.map((section,index)=>section.collapsible?<details className="editor-more-options" key={section.key} open={!!record.id&&initialForm.productType==='gift'}>
         <summary id={`form-section-${section.key}`} tabIndex="0">{section.title}</summary>
         <p className="hint">{section.description}</p>
         <div className="product-form-grid">
          {['productType','sku','orderable'].map(name=>renderField(fieldByName.get(name)))}
          {!isGift&&['unitCostMinor','costEffectiveOn'].map(name=>renderField(fieldByName.get(name)))}
         </div>
         {isGift&&<><p className="hint">El obsequio puede guardarse como borrador y utilizarse en pedidos sin publicarlo. Un precio de cero es válido. Su costo depende únicamente de sus componentes.</p><ProductComponents label="Productos del obsequio" value={form.items} onChange={value=>change('items',value)} products={componentProducts} excludeId={record.id}/>{componentCost}</>}
         {!isGift&&<p className="small muted">La fecha de vigencia es una fecha de negocio; si no la indicas, se usa hoy en Bogotá al guardar el costo. Vacío conserva el costo como desconocido, no como cero. Registrar costo no genera un gasto ni movimiento de caja.</p>}
        </details>:<section className={`form-section product-form-section ${styles.section}`} key={section.key} aria-labelledby={`form-section-${section.key}`}>
         <div className="product-form-section-heading"><p className={styles.sectionStep}>Sección {index+1} de {sections.length}</p><h3 id={`form-section-${section.key}`} tabIndex="-1">{section.title}</h3><p>{section.description}</p></div>
         <div className={`product-form-grid${section.singleColumn?' product-form-grid--single':''}`}>
          {section.fields.filter(name=>!(isGift&&name==='stockQuantity')).map(name=><div className={`product-form-field product-form-field--${name} ${['textarea','image','comboItems','multi'].includes(fieldByName.get(name).type)?styles.fullWidth:''}`} key={name}>{renderField(fieldByName.get(name))}</div>)}
         </div>
         {section.key==='inventory'&&<>{isGift?<p className="hint">Este obsequio no tiene existencias propias: utiliza las unidades de sus componentes. Posibles ahora: {availableUnits??'por contar'}.</p>:<><p className="hint">Reservadas: {record.stockReserved||0} · Disponibles para nuevos pedidos: {availableUnits??'sin contar'}. El conteo físico debe incluir las unidades reservadas.</p>{form.stockQuantity==null&&<p className="hint">Sin un conteo no se pueden reservar ni despachar nuevas unidades de esta referencia.</p>}</>}<p className="small muted">El conteo queda auditado. Registrar existencias no crea compras, gastos ni movimientos de caja. Las reservas se confirman al guardar el pedido, no al seleccionar productos.</p></>}
         {kind==='combos'&&section.key==='components'&&componentCost}
        </section>)}
        {record.id&&<details className="editor-more-options"><summary>{configurationContent?'Eliminar contenido':'Más opciones'}</summary><p className="hint">Eliminar retira este registro de forma irreversible. Si tiene referencias, el servidor puede impedir su eliminación.</p><button className="text-button danger" type="button" onClick={remove} disabled={interactionBusy}>Eliminar {schema.singular}</button></details>}
       </div>
       <aside className="editor-summary" aria-label="Resumen de la ficha" tabIndex={configurationContent?0:undefined}>{summary}</aside>
      </div>
     </div>
     <footer className="editor-footer">
      <span className="unsaved-flag">{dirty?'Cambios sin guardar':'Sin cambios pendientes'}</span>
      <button type="button" className="button subtle" onClick={close} disabled={interactionBusy}>{configurationContent?'Cancelar edición':'Cancelar'}</button>
      <button type="submit" className="button primary" disabled={interactionBusy}>{busy?'Procesando…':uploadingImage?'Subiendo imagen…':record.id?'Guardar cambios':`Crear ${schema.singular}`}<Icon name="check" size={16}/></button>
     </footer>
    </fieldset>
   </form>
  </dialog>
 );
}
