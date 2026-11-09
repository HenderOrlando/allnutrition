'use client';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { getImportColumnIssues, importFields, isImportFieldAllowed, normalizeImportFieldName, shipmentStates } from '@/lib/schema.mjs';
import useDialog from './useDialog';
import Icon from './Icons';
import { Field } from './Fields';
import ImportColumnMapping from './ImportColumnMapping';
import OrderLineCosts from './OrderLineCosts';
import ImportSheetCards from './ImportSheetCards';
import ImportHistory from './ImportHistory';
import ImportDecisionDialog from './ImportDecisionDialog';
import ImportedData from './ImportedData';
import ImportReviewEffects, { InventoryOpeningControls, ReviewExpenses } from './ImportReviewEffects';
import { formatMoneyMinor } from '@/lib/business/money.mjs';
import styles from './OrderExperience.module.css';

const MAX_BYTES=10*1024*1024;
const ACTIVE_STATES=new Set(['uploaded','previewing','queued','applying']);
const LOCKED_STATES=new Set(['queued','applying']);
const FINAL_STATES=new Set(['completed','completed_with_errors','expired','cancelled']);
const LINE_FIELDS=new Set(importFields.filter(field=>field.scope==='line').map(field=>field.value));
const FIELD_DEFINITIONS=new Map(importFields.map(field=>[field.value,field]));
const STATE_LABELS={uploaded:'Archivo recibido',previewing:'Preparando revisión',review:'Por revisar',queued:'Importación en cola',applying:'Importando',completed:'Importación completada',completed_with_errors:'Importación parcial: quedan pendientes',failed:'Requiere corrección',expired:'Archivo vencido',cancelled:'Importación cancelada'};
const COMMERCIAL_FIELDS=importFields.filter(field=>field.scope==='order'&&field.effect==='commercial'&&!['sellerExternalKey','shippingCharge'].includes(field.value));
const RESULT_LABELS={created:'Operaciones nuevas',updated:'Operaciones actualizadas',unchanged:'Sin cambios',conflict:'Conflictos',rejected:'Rechazados',applied:'Aplicados',new:'Nuevos',valid:'Válidos',invalid:'Con errores',omitted:'Omitidos',errors:'Con excepciones',groupsProcessed:'Grupos procesados',settlementsProcessed:'Liquidaciones procesadas',settlementsPending:'Liquidaciones pendientes de aplicación'};
const RESOLUTION_LABELS={link_product:'Vincular producto',link_person:'Vincular vendedor',link_order:'Vincular pedido',link_shipment:'Vincular envío',link_expense:'Vincular gasto importado',duplicate:'Marcar fila duplicada',independent_record:'Confirmar operación independiente',additional_quantity:'Contar como cantidad adicional',status:'Asignar estado externo',review_policy:'Aprobar política histórica',review_authority:'Revisar autoridad o rectificación',accept_formulas:'Aceptar valores guardados de fórmulas',omit_group:'Omitir grupo completo',omit_settlement_package:'Excluir paquete Heka completo',commercial_update:'Completar o corregir datos del pedido',cell_value:'Completar o corregir celda',line_costs:'Completar costos históricos',opening_observation:'Clasificar hecho frente al conteo'};
const RESOLUTION_GROUPS=[
 {label:'Vincular registros',actions:['link_product','link_person','link_order','link_shipment','link_expense']},
 {label:'Interpretar el archivo',actions:['status','duplicate','independent_record','additional_quantity','accept_formulas']},
 {label:'Correcciones con motivo',actions:['cell_value','line_costs','opening_observation','review_policy','review_authority','commercial_update','omit_group']}
];
const GROUP_RESOLUTIONS=RESOLUTION_GROUPS.flatMap(group=>group.actions).filter(action=>!['accept_formulas','opening_observation'].includes(action));
const ROW_RESOLUTIONS=['link_product','link_person','link_order','link_expense','duplicate','independent_record','additional_quantity','cell_value'];
const FILE_RESOLUTIONS=['accept_formulas'];
const STEP_GUIDANCE=[
 ['Elige el archivo y su origen','Elige un origen existente o crea uno para tus archivos. Guardar el original no incorpora pedidos ni gastos.'],
 ['Confirma las hojas y sus datos','Elige qué contiene cada hoja. Revisa las variantes, sus columnas y el corte real del archivo; las propuestas nunca se aceptan solas.'],
 ['Completa lo que falta y revisa el efecto','Resuelve los vínculos y datos que necesite este archivo. Confirma los costos históricos y revisa el inventario de cada producto; un conteo físico de apertura es opcional y debe ser real. Cada cambio exige una revisión nueva.'],
 ['Confirma y continúa tu negocio','La importación avanza por operaciones completas y puede retomarse. Las excepciones quedan pendientes; no se fabrica dinero ni stock.']
];
const blankSheetConfig=(sheetName='')=>({sheetName,enabled:true,headerRow:1,dateFormat:'DMY',decimalSeparator:',',groupSeparator:'.',layout:'item_rows',purpose:'orders',columns:[],statusMap:{},oneOrderPerGuide:false,reportAsOf:null,defaults:{},identityMode:'provided',expenseGroupNames:{},expenseCategoryMap:{}});
const blankConfig=()=>({formatVersion:2,sheets:[]});
function clientConfig(value){
 if(value?.formatVersion===2)return {...value,sheets:(value.sheets||[]).map(sheet=>({...blankSheetConfig(sheet.sheetName),...sheet}))};
 return value?.sheetName?{formatVersion:2,sheets:[{...blankSheetConfig(value.sheetName),...value,columns:(value.columns||[]).map(column=>({...column,destination:column.destination||'ignore'}))}]}:blankConfig();
}
const records=data=>Array.isArray(data)?data:data?.records||[];
const catalogRecords=data=>data.flatMap((result,index)=>records(result).map(item=>({...item,kind:index===0?'products':'combos'})));
const catalogType=item=>item?.kind==='combos'?'Combo':item?.productType==='gift'?'Obsequio':'Producto';
const normalizedHeader=normalizeImportFieldName;
const cellText=cell=>cell==null?'':typeof cell==='object'?String(cell.text??cell.value??''):String(cell);
const json=value=>JSON.stringify(value);
const requestId=()=>crypto.randomUUID();
const groupKey=group=>String(group.entityKey??group.key??group.groupKey??'');
function groupCaption(group){
 const orders=[...new Set((group.units||[]).map(unit=>unit.values?.internalOrderNumber?`AN-${unit.values.internalOrderNumber}`:unit.values?.externalOrderId).filter(Boolean))];
 if(orders.length)return `${orders.length===1?'Pedido':'Pedidos'} ${orders.join(', ')}`;
 const guides=[...new Set((group.units||[]).flatMap(unit=>unit.shipments||[]).map(shipment=>shipment.values?.tracking||shipment.values?.externalShipmentId).filter(Boolean))];
 return guides.length?`${guides.length===1?'Guía':'Guías'} ${guides.join(', ')}`:group.kind==='expenses'?`Gastos · ${(group.expenses||[]).map(expense=>expense.input.concept).filter(Boolean).join(', ')||'Por completar'}`:`Filas ${(group.rowRefs||[]).map(ref=>`${ref.sheet}: ${ref.rowNumber}`).join(' · ')||'por revisar'}`;
}
const diagnosticValue=value=>typeof value==='string'||typeof value==='number'?String(value):'';
function diagnosticText(error){
 if(error==null)return '';
 return diagnosticValue(error)||diagnosticValue(error.message)||diagnosticValue(error.reason)||diagnosticValue(error.code)||'No se recibió un detalle legible del error.';
}
function diagnosticLocation(error){
 if(!error||typeof error!=='object')return '';
 return [['Hoja',error.sheet],['Fila',error.rowNumber],['Filas',error.rowNumbers?.join(', ')],['Ubicación',error.rowRefs?.map(ref=>`${ref.sheet} · fila ${ref.rowNumber}`).join('; ')],['Columna',error.column],['Campo',error.field||error.key]].map(([label,value])=>diagnosticValue(value)?`${label}: ${diagnosticValue(value)}`:'').filter(Boolean).join(' · ');
}
const messages=errors=>(Array.isArray(errors)?errors:errors?[errors]:[]).map(error=>[diagnosticText(error),diagnosticLocation(error),diagnosticValue(error?.action)].filter(Boolean).join(' · '));
function ImportDiagnostic({diagnostic,alertRef}){
 const category=diagnostic?.category,title=category==='file'?'Problema comprobado del archivo':category==='configuration'?'Revisa la configuración de extracción':'Problema del sistema o causa no determinada',location=diagnosticLocation(diagnostic),actions=Array.isArray(diagnostic?.actions)?diagnostic.actions.map(diagnosticValue).filter(Boolean):[diagnosticValue(diagnostic?.action)].filter(Boolean);
 return <section className="error" role="alert" tabIndex={-1} ref={alertRef} aria-label="Diagnóstico de importación"><h3>{title}</h3><p>{diagnosticText(diagnostic)}</p>{location&&<p>{location}</p>}{actions.map((action,index)=><p key={index}><strong>Qué hacer:</strong> {action}</p>)}{!actions.length&&<p>Conserva esta importación y la evidencia disponible. Puedes salir y retomarla.{category!=='file'&&category!=='configuration'?' No se ha determinado que el archivo sea la causa.':''}</p>}{diagnostic?.code&&<details><summary>Detalles técnicos del diagnóstico</summary><p>Código: {diagnosticValue(diagnostic.code)}{diagnosticValue(diagnostic.phase)?` · Fase: ${diagnosticValue(diagnostic.phase)}`:''}</p></details>}</section>;
}
const safeName=value=>String(value||'archivo.xlsx').replace(/[\\/\u0000-\u001f]/g,'_');
function profileConfig(profile){const {id,name,sourceId,version,createdAt,updatedAt,...data}=profile||{};const config=clientConfig(profile?.profile||profile?.data||data);return {...config,sheets:config.sheets.map(sheet=>({...sheet,reportAsOf:null}))};}
function summaryItems(summary){return Object.entries(summary||{}).filter(([key,value])=>RESULT_LABELS[key]&&typeof value==='number');}
function problemLabel(code){return ({IMPORT_PRODUCT_LINK:'Productos por vincular',IMPORT_GIFT_LINK:'Obsequios por vincular',IMPORT_GIFT_QUANTITY:'Cantidad de obsequios por confirmar',IMPORT_GIFT_REQUIRED:'Referencia de obsequio pendiente',IMPORT_ORDER_INCOMPLETE:'Datos de pedidos incompletos',IMPORT_SHIPMENT_IDENTITY:'Identidad del envío pendiente',IMPORT_POLICY_REQUIRED:'Regla histórica por confirmar',IMPORT_YEAR_CONFIRMATION:'Año de fecha por confirmar',IMPORT_OPENING_CLASSIFICATION:'Hechos frente al conteo',IMPORT_INVENTORY:'Existencias por revisar',IMPORT_DUPLICATE_IDENTITY:'Operaciones posiblemente duplicadas',IMPORT_DUPLICATE_EXPENSE:'Gastos posiblemente duplicados',IMPORT_DUPLICATE_ROW:'Filas posiblemente duplicadas',IMPORT_EXPENSE_AUTHORITY:'Correcciones de gastos',IMPORT_COMMERCIAL_AUTHORITY:'Correcciones de pedidos',IMPORT_FORMULA_ACCEPTANCE:'Fórmulas por revisar',IMPORT_CUTOFF_REQUIRED:'Corte por confirmar',IMPORT_COMPONENT_COSTS:'Costos de componentes',IMPORT_COST_AUTHORITY:'Costos por confirmar',complete_lines:'Cantidad y precio pendientes',link_order:'Pedido por completar o vincular',cost_date:'Fecha del cargo pendiente',review_authority:'Datos discrepantes'})[code]||`Datos por revisar · ${code}`;}
function serverGroups(batch){return batch?.preview?.groups||[];}
function cutoffDate(value){if(!value)return '';if(!value.includes('T'))return value;const instant=new Date(value);return Number.isNaN(instant.getTime())?'':new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(instant);}
function rowExternalKey(action,row){const values=row.normalized?.values||{};if(action==='link_product')return row.normalized?.lines?.[0]?.productExternalKey||'';if(action==='link_person')return values.sellerExternalKey||'';if(action==='link_order')return values.externalOrderId||'';if(action==='link_shipment')return values.externalShipmentId||values.tracking||'';return '';}
const resolutionIdentity=item=>json([item.action,item.action==='cell_value'?null:item.entityKey||null,item.sheet||null,item.rowNumber?Number(item.rowNumber):null,item.action==='cell_value'?null:item.externalKey||null,item.action==='cell_value'?item.columnIndex:null]);

export default function ImportWizard({api,view:inputView,onViewChange,onNavigate,onInteractionStateChange,onCreateProduct,onMutation}){
 const view=inputView||{},isNew=view.batch==='new',savedBatchId=isNew?'':view.batch||'';
 const errorRef=useRef(null),headingRef=useRef(null),currentBatch=useRef(null),loadSequence=useRef(0),sourceSequence=useRef(0),profileSequence=useRef(0),lookupSequence=useRef(0),mounted=useRef(true),baseline=useRef(''),lastNotification=useRef('');
 const prefillContext=useRef(''),diagnosticRef=useRef(null),requestBusy=useRef(false),listSequence=useRef(0),optionsSequence=useRef(0),navigation=useRef(onViewChange);
 navigation.current=onViewChange;
 const cancellationRequested=useRef(false),pendingCreation=useRef(null),pendingOperation=useRef(null),operationAbort=useRef(null);
 const mappingRootRef=useRef(null),focusColumnProblems=useRef(false);
 const stepHeadingRef=useRef(null);
 const fileHelpId=useId();
 const [sheetFocus,setSheetFocus]=useState(''),[readingOpen,setReadingOpen]=useState(false),[mappingInteraction,setMappingInteraction]=useState(false);
 const [decision,setDecision]=useState(null),decisionRef=useRef(null),decisionContext=useRef('');
 const [batch,setBatch]=useState(null),[listResource,setListResource]=useState({data:null,loading:false,error:''}),[options,setOptions]=useState({platforms:[],sources:[],loading:false,error:''}),[platforms,setPlatforms]=useState([]),[sources,setSources]=useState([]),[profiles,setProfiles]=useState([]),[platformId,setPlatformId]=useState(''),[sourceId,setSourceId]=useState(''),[profileId,setProfileId]=useState(''),[platformName,setPlatformName]=useState(''),[sourceName,setSourceName]=useState(''),[advancedSource,setAdvancedSource]=useState(false),[profileName,setProfileName]=useState(''),[file,setFile]=useState(null),[workbookConfig,setWorkbookConfig]=useState(blankConfig),[activeSheet,setActiveSheet]=useState(''),[inventoryOpening,setInventoryOpening]=useState(null),[resolutions,setResolutions]=useState([]),[step,setStep]=useState(1),[busy,setBusy]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[page,setPage]=useState(1),[rowState,setRowState]=useState(''),[includeValidOnly,setIncludeValidOnly]=useState(false),[resolver,setResolver]=useState(null),[lookup,setLookup]=useState([]),[lookupQuery,setLookupQuery]=useState(''),[lookupLoading,setLookupLoading]=useState(false),[rules,setRules]=useState([]),[statusDraft,setStatusDraft]=useState('');
 const config=workbookConfig.sheets.find(sheet=>sheet.sheetName===activeSheet)||blankSheetConfig(activeSheet);
 function setConfig(change){if(!activeSheet)return;setWorkbookConfig(previous=>{const old=previous.sheets.find(sheet=>sheet.sheetName===activeSheet)||blankSheetConfig(activeSheet),next=typeof change==='function'?change(old):change;return {...previous,sheets:[...previous.sheets.filter(sheet=>sheet.sheetName!==activeSheet),next]};});}
 function selectSheet(name){setActiveSheet(name);setSheetFocus('editor');}
 function includeHekaPackage(packet,include){
  const externalKey=packet.id.trim();
  setResolutions(previous=>[...previous.filter(item=>item.action!=='omit_settlement_package'||item.externalKey!==externalKey),{action:'omit_settlement_package',externalKey,...(include?{remove:true}:{value:true})}]);
  setIncludeValidOnly(false);
 }
 function includeSheet(name){const previous=workbookConfig.sheets.find(sheet=>sheet.sheetName===name);chooseSheetConfig({...previous||blankSheetConfig(name),enabled:true});}
 const [ownFiles,setOwnFiles]=useState(false),[fileCutoff,setFileCutoff]=useState(''),[openingDate,setOpeningDate]=useState(''),[selectedGroups,setSelectedGroups]=useState([]),[issueFilter,setIssueFilter]=useState('');
 const [pendingOnly,setPendingOnly]=useState(false),[rowQuery,setRowQuery]=useState(''),[rowLocation,setRowLocation]=useState(null),[sourceRowsOpen,setSourceRowsOpen]=useState(false);
 const [resultLimits,setResultLimits]=useState({orders:20,shipments:20,expenses:20});
 const [productRecords,setProductRecords]=useState([]);
 const savedProductLinks=(batch?.resolutions||[]).filter(item=>item.action==='link_product');
 const savedProductIds=json([...new Set(savedProductLinks.map(item=>item.internalId))].sort());
 function chooseSheetConfig(next){setWorkbookConfig(previous=>({...previous,sheets:[...previous.sheets.filter(sheet=>sheet.sheetName!==next.sheetName),next]}));setActiveSheet(next.sheetName);setIncludeValidOnly(false);}
 async function useSheetProposal(name){
  const proposal=batch.workbook.suggestions?.sheets?.find(sheet=>sheet.sheetName===name);if(!proposal)return;
  if(proposal.possibleDuplicateOf&&!await decide({title:'Revisar una posible copia',description:'Importar esta hoja no la hace independiente.',items:[{key:name,label:name,detail:`Coincide con ${proposal.possibleDuplicateOf.sheetName} en ${proposal.possibleDuplicateOf.range}`}],warning:'Deberás resolver los duplicados antes de sumar gastos.',confirmLabel:'Revisar esta hoja'}))return;
  chooseSheetConfig({...blankSheetConfig(name),...proposal.config,enabled:true,reportAsOf:null});setNotice(`Propuesta elegida para ${name}. Confirma su significado, identidades y estados.`);
 }
 function excludeSheet(name){setWorkbookConfig(previous=>{const old=previous.sheets.find(sheet=>sheet.sheetName===name)||blankSheetConfig(name);return {...previous,sheets:[...previous.sheets.filter(sheet=>sheet.sheetName!==name),{...old,enabled:false}]};});setIncludeValidOnly(false);}
 function excludeMissingSheets(){setWorkbookConfig(previous=>({...previous,sheets:previous.sheets.map(sheet=>({...sheet,enabled:sheet.enabled&&batch.workbook.sheets.some(item=>item.name===sheet.sheetName)}))}));setNotice('Hojas ausentes excluidas solo de este lote. El perfil guardado no se ha modificado.');}
 async function applySimilarSheets(name){
  const current=workbookConfig.sheets.find(sheet=>sheet.sheetName===name),proposal=batch.workbook.suggestions?.sheets?.find(sheet=>sheet.sheetName===name);
  const targets=batch.workbook.suggestions?.sheets?.filter(sheet=>sheet.sheetName!==name&&sheet.variantKey===proposal?.variantKey&&!sheet.possibleDuplicateOf)||[];
  if(!current||!targets.length)return;
  if(!await decide({title:'Aplicar configuración a hojas similares',description:`Se copiarán propósito, columnas, equivalencias y decisiones de «${name}».`,items:targets.map(sheet=>({key:sheet.sheetName,label:sheet.sheetName,detail:'Compatible por encabezados y tipos'})),warning:'El corte se confirmará por separado para este archivo. Las otras variantes no cambiarán.',confirmLabel:'Aplicar a estas hojas'}))return;
  const names=new Set(targets.map(sheet=>sheet.sheetName));
  setWorkbookConfig(previous=>({...previous,sheets:[...previous.sheets.filter(sheet=>!names.has(sheet.sheetName)),...targets.map(sheet=>({...current,sheetName:sheet.sheetName,headerRow:sheet.config.headerRow,enabled:true,reportAsOf:null}))]}));setIncludeValidOnly(false);setNotice(`Variante aplicada a ${targets.length} hojas. Las variantes con otros tipos no cambiaron.`);
 }
 async function applyWorkbookProposal(){
  const proposals=batch.workbook.suggestions?.sheets||[],chosen=proposals.filter(sheet=>!sheet.possibleDuplicateOf&&sheet.config.columns.some(column=>column.destination&&column.destination!=='ignore')),chosenNames=new Set(chosen.map(sheet=>sheet.sheetName)),excluded=batch.workbook.sheets.filter(sheet=>!chosenNames.has(sheet.name));
  if(!chosen.length)return;
  if(!await decide({title:'Revisar propuesta del libro',description:'Esta decisión reemplaza las hojas y columnas del borrador.',items:[...chosen.map(sheet=>({key:sheet.sheetName,label:sheet.sheetName,detail:'Incluir y usar propuesta'})),...excluded.map(sheet=>({key:sheet.name,label:sheet.name,detail:'No importar'}))],warning:'En ventas de una fila por pedido, confirmo que cada fila es un pedido y un envío; si faltan IDs, autorizo identidades técnicas estables. En gastos sin ID se generarán identidades técnicas, no recibos de pago. Revisaré columnas, estados y fechas antes de aplicar. Las equivalencias y el corte no se aceptan con esta propuesta.',confirmLabel:'Usar estas propuestas'}))return;
  setWorkbookConfig({formatVersion:2,sheets:batch.workbook.sheets.map(sheet=>{
   const proposal=chosen.find(item=>item.sheetName===sheet.name);if(!proposal)return {...blankSheetConfig(sheet.name),enabled:false};
   const next={...blankSheetConfig(sheet.name),...proposal.config,enabled:true,reportAsOf:null},hasId=next.columns.some(column=>column.destination===(next.purpose==='expenses'?'expenseExternalId':'externalOrderId'));
   return {...next,identityMode:!hasId&&(next.purpose==='expenses'||next.purpose==='orders'&&next.layout==='order_rows')?'generated':next.identityMode};
  })});setActiveSheet(chosen[0].sheetName);setIncludeValidOnly(false);setNotice('Propuesta confirmada. Las equivalencias de estado, el corte y los datos faltantes se revisan antes de importar.');
 }
 async function confirmFileCutoff(){
  const chosen=workbookConfig.sheets.filter(sheet=>sheet.enabled&&!sheet.columns.some(column=>column.destination==='reportAsOf'));
  if(!fileCutoff){setError('Indica la fecha real hasta la que está actualizado este archivo.');return;}
  if(!chosen.length){setError('Elige hojas sin una columna de corte para aplicar esta fecha.');return;}
  if(!await decide({title:'Confirmar corte del archivo',description:`Confirmo que estas hojas están actualizadas hasta ${fileCutoff}, al final del día en Bogotá.`,items:chosen.map(sheet=>({key:sheet.sheetName,label:sheet.sheetName,detail:`Corte: ${fileCutoff}`})),warning:'No es la fecha de entrega, del gasto ni de subida. Las columnas de corte no se reemplazan.',confirmLabel:'Confirmar este corte'}))return;
  const names=new Set(chosen.map(sheet=>sheet.sheetName));setWorkbookConfig(previous=>({...previous,sheets:previous.sheets.map(sheet=>names.has(sheet.sheetName)?{...sheet,reportAsOf:fileCutoff}:sheet)}));setIncludeValidOnly(false);setNotice('Corte confirmado para las hojas indicadas; una columna de corte nunca fue reemplazada.');
 }
 async function confirmStatusProposals(){
  const chosen=workbookConfig.sheets.filter(sheet=>sheet.enabled&&['orders','tracking','settlements'].includes(sheet.purpose)),proposals=batch.workbook.suggestions?.sheets||[],changes=chosen.map(sheet=>({sheet,proposal:proposals.find(item=>item.sheetName===sheet.sheetName)})).filter(item=>Object.keys(item.proposal?.statusMapSuggestions||{}).length);
  if(!changes.length)return;
  if(!await decide({title:'Confirmar equivalencias de seguimiento',description:'Revisa el significado de cada estado original.',items:changes.flatMap(({sheet,proposal})=>Object.entries(proposal.statusMapSuggestions).map(([raw,value])=>({key:json([sheet.sheetName,raw]),label:`${sheet.sheetName} · ${raw}`,detail:`→ ${shipmentStates.find(state=>state.value===value)?.label||value}`}))),warning:'Un estado administrativo no confirma entrega ni cobro. Las equivalencias que ya editaste se conservan.',confirmLabel:'Usar estas equivalencias'}))return;
  const mappings=new Map(changes.map(({sheet,proposal})=>[sheet.sheetName,proposal.statusMapSuggestions]));setWorkbookConfig(previous=>({...previous,sheets:previous.sheets.map(sheet=>mappings.has(sheet.sheetName)?{...sheet,statusMap:{...mappings.get(sheet.sheetName),...sheet.statusMap}}:sheet)}));setIncludeValidOnly(false);
 }
 async function ignorePendingSheets(selection){
  const pending=Array.isArray(selection)?selection:(batch?.workbook?.sheets||[]).map(sheet=>sheetWork(sheet)).filter(item=>item.selected?.enabled).map(item=>({sheetName:item.sheet.name,columns:item.pending})).filter(sheet=>sheet.columns.length);
  if(!pending.length){setNotice('No hay columnas pendientes en las hojas elegidas.');return;}
  if(!await decide({title:'Confirmar columnas que no se importarán',description:'Sus celdas seguirán en el original y la copia ampliada mientras estén disponibles.',items:pending.flatMap(sheet=>sheet.columns.map(column=>({key:json([sheet.sheetName,column.index]),label:`${sheet.sheetName} · columna ${column.index+1}`,detail:column.header||'Sin encabezado'}))),warning:'Los valores de estas columnas no crearán registros.',confirmLabel:'Excluir estas columnas'}))return;
  const bySheet=new Map(pending.map(sheet=>[sheet.sheetName,new Map(sheet.columns.map(column=>[column.index,column]))]));
  setWorkbookConfig(previous=>({...previous,sheets:previous.sheets.map(sheet=>{const affected=bySheet.get(sheet.sheetName);return affected?{...sheet,columns:[...sheet.columns.filter(column=>!affected.has(column.index)),...[...affected.values()].map(column=>({index:column.index,header:normalizedHeader(column.header),destination:'ignore',group:0}))].sort((a,b)=>a.index-b.index)}:sheet;})}));setIncludeValidOnly(false);setNotice('Columnas excluidas por tu confirmación; no se creó ningún registro con sus valores.');
 }
 async function editInventoryProduct(productId){
  const saved=await perform('save',()=>saveDraft());if(!saved)return;
  onInteractionStateChange?.({busy:false,dirty:false});await new Promise(resolve=>requestAnimationFrame(resolve));
  try{const result=await onCreateProduct?.({productId,batchId:saved.id});if(result&&mounted.current){setNotice('Conteo físico guardado en el producto real. Genera una revisión nueva para comprobar reservas y disponibles.');await saveAndPreview();}}catch(cause){if(mounted.current)setError(cause.message);}
 }
 const [resourceRetry,setResourceRetry]=useState(0);
 useEffect(()=>{
  if(savedProductIds==='[]')return;
  let active=true;
  Promise.all([api('/api/admin/products'),api('/api/admin/combos')]).then(data=>{if(active)setProductRecords(catalogRecords(data));}).catch(cause=>{if(active)setError(cause.message);});
  return()=>{active=false;};
 },[api,savedProductIds,resourceRetry]);
 const [groupPage,setGroupPage]=useState(1);
 const [operationError,setOperationError]=useState(null);
 const cancelled=batch?.state==='cancelled',cancellation=batch?.cancellation;
 const workLocked=LOCKED_STATES.has(batch?.state),previewing=batch?.state==='previewing',fileUnavailable=!!(batch?.fileExpired||batch?.fileDiscarded||['expired','cancelled'].includes(batch?.state));
 const canEditDraft=!!batch?.fileHash&&!fileUnavailable&&!workLocked&&!previewing&&batch.state!=='completed';
 const showResult=step===4&&(workLocked||fileUnavailable||FINAL_STATES.has(batch?.state)||batch?.state==='failed'&&!!batch.acceptedRevision);
 const progressPhase=batch?.progress?.phase,hasAppliedProgress=batch?.state==='completed'||batch?.state==='completed_with_errors'||(workLocked||!!batch?.acceptedRevision)&&progressPhase!=='inspect'&&progressPhase!=='preview'&&progressPhase!=='review';
 const draft=json({config:workbookConfig,resolutions,profileId,inventoryOpening}),draftChanged=!!batch&&draft!==baseline.current;
 const dirty=!cancelled&&(!!resolver||!!decision||mappingInteraction||!!statusDraft||!!profileName||canEditDraft&&draftChanged||!batch?.fileHash&&!!(file||platformName||sourceName));
 const reportMappingInteraction=useCallback(({open})=>setMappingInteraction(open),[]);
 decisionContext.current=json([batch?.id,batch?.version,draft,activeSheet,selectedGroups,fileCutoff,file?.name]);
 function decide(presentation){
  if(resolver||mappingInteraction)return Promise.resolve(false);
  decisionRef.current?.resolve(false);
  return new Promise(resolve=>{const next={...presentation,context:decisionContext.current,resolve};decisionRef.current=next;setDecision(next);});
 }
 function finishDecision(confirmed){
  const pending=decisionRef.current;if(!pending)return;
  decisionRef.current=null;setDecision(null);
  const valid=pending.context===decisionContext.current;
  pending.resolve(!!(confirmed&&valid&&mounted.current));
 }
 useEffect(()=>{const pending=decisionRef.current;if(pending&&pending.context!==decisionContext.current){finishDecision(false);setNotice('El contexto cambió. Abre la decisión de nuevo para revisar la lista actual.');}});
 useEffect(()=>()=>{decisionRef.current?.resolve(false);decisionRef.current=null;},[]);
 const diagnostic=batch?.error||batch?.progress?.error||(batch?.state==='failed'?(batch.progress?.message||{message:'El servidor no completó este lote.',category:'system'}):null);
 const listSource=view.source||'',listStatus=view.status||'',listPage=Number(view.page)||1;
 const diagnosticKey=diagnostic?[diagnosticText(diagnostic),diagnosticLocation(diagnostic),diagnosticValue(diagnostic.code),diagnosticValue(diagnostic.phase)].join('|'):'';
 currentBatch.current=batch;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;requestBusy.current=false;loadSequence.current++;sourceSequence.current++;profileSequence.current++;lookupSequence.current++;};},[]);
 useEffect(()=>{onInteractionStateChange?.({dirty,busy:!!busy});},[dirty,busy,onInteractionStateChange]);
 useEffect(()=>()=>onInteractionStateChange?.({dirty:false,busy:false}),[onInteractionStateChange]);
 useEffect(()=>{if(error&&!busy){if(focusColumnProblems.current){const problem=focusColumnProblems.current;focusColumnProblems.current=false;requestAnimationFrame(()=>{const target=mappingRootRef.current?.querySelector(Number.isInteger(problem.index)?`[data-import-column="${problem.index}"] [data-import-destination]`:'[data-import-column-issues]');(target||errorRef.current)?.focus();});}else errorRef.current?.focus();}},[error,busy]);
 useEffect(()=>{if(diagnosticKey)diagnosticRef.current?.focus();},[diagnosticKey]);
 useEffect(()=>{(stepHeadingRef.current||headingRef.current||document.querySelector('[data-import-history-heading]'))?.focus();},[step,batch?.id,isNew]);
 useEffect(()=>{setGroupPage(1);setSelectedGroups([]);setIssueFilter('');setRowLocation(null);setPage(1);if(batch?.id&&(page!==1||rowLocation))void loadBatch(batch.id,{state:rowState,q:rowQuery});},[batch?.id,batch?.preview?.previewHash]);
 const acceptBatch=useCallback((data,{hydrate=false}={})=>{
  if(!data?.id)return;
  const previous=currentBatch.current;
  if(previous?.id===data.id&&previous.version>data.version)return;
  const phaseChanged=previous?.id!==data.id||previous?.state!==data.state||previous?.progress?.phase!==data.progress?.phase||previous?.acceptedRevision!==data.acceptedRevision||!!previous?.fileExpired!==!!data.fileExpired||!!previous?.fileDiscarded!==!!data.fileDiscarded;
  setBatch(data);
  if(hydrate||data.state==='cancelled'||data.workbook&&!previous?.workbook){const next=clientConfig(data.config);setWorkbookConfig(next);setActiveSheet(current=>next.sheets.some(sheet=>sheet.sheetName===current)?current:next.sheets.find(sheet=>sheet.enabled)?.sheetName||'');setInventoryOpening(data.inventoryOpening||null);setOpeningDate(data.inventoryOpening?.on||'');setFileCutoff('');setOwnFiles(false);setResolutions(data.resolutions||[]);setProfileId(data.profileId||'');baseline.current=json({config:next,resolutions:data.resolutions||[],profileId:data.profileId||'',inventoryOpening:data.inventoryOpening||null});setPlatformId(data.platformId||'');setSourceId(data.sourceId||'');}
  if(data.state==='cancelled'){setFile(null);setResolver(null);setStatusDraft('');setProfileName('');}
  currentBatch.current=data;
  if(hydrate||phaseChanged){
   if(data.fileExpired||data.fileDiscarded||LOCKED_STATES.has(data.state)||FINAL_STATES.has(data.state)||data.state==='failed'&&data.acceptedRevision)setStep(4);
   else if(!data.fileHash)setStep(1);
   else if(data.preview?.previewHash||data.pendingProductLinks?.length||['preview','review'].includes(data.progress?.phase))setStep(3);
   else setStep(2);
  }
 },[]);
 const loadLists=useCallback(async()=>{
  const sequence=++listSequence.current;
  setListResource(previous=>({...previous,loading:true,error:''}));
  try{
   const data=await api('/api/admin/imports?'+new URLSearchParams({source:listSource,state:listStatus,page:String(listPage)}));
   if(!mounted.current||sequence!==listSequence.current)return;
   const maxPage=Math.max(1,Math.ceil(data.total/data.pageSize));
   setListResource({data,loading:false,error:''});
   if(listPage>maxPage)navigation.current?.({page:maxPage});
  }catch(cause){if(mounted.current&&sequence===listSequence.current)setListResource(previous=>({...previous,loading:false,error:diagnosticText(cause)}));}
 },[api,listSource,listStatus,listPage]);
 const loadOptions=useCallback(async()=>{
  const sequence=++optionsSequence.current;
  setOptions(previous=>({...previous,loading:true,error:''}));
  try{
   const [platformData,sourceData]=await Promise.all([api('/api/admin/business/platforms'),api('/api/admin/business/sources')]);
   if(!mounted.current||sequence!==optionsSequence.current)return;
   setPlatforms(records(platformData));
   setOptions({platforms:records(platformData),sources:records(sourceData),loading:false,error:''});
  }catch(cause){if(mounted.current&&sequence===optionsSequence.current)setOptions(previous=>({...previous,loading:false,error:diagnosticText(cause)}));}
 },[api]);
 useEffect(()=>{void loadOptions();return()=>{optionsSequence.current++;};},[loadOptions,resourceRetry]);
 useEffect(()=>{if(!isNew&&!savedBatchId)void loadLists();return()=>{listSequence.current++;};},[loadLists,isNew,savedBatchId]);
 useEffect(()=>{if(!isNew&&view.record)navigation.current?.({record:undefined});},[isNew,view.record]);
 const loadBatch=useCallback(async(id,{hydrate=false,targetPage=1,state='',q='',sheet='',rowNumber=null}={})=>{
  const sequence=++loadSequence.current;setLoading(true);
  const filters=new URLSearchParams({page:String(targetPage)});for(const [key,value] of Object.entries({state,q,sheet,rowNumber}))if(value!==''&&value!=null)filters.set(key,String(value));
  try{const data=await api(`/api/admin/imports/${encodeURIComponent(id)}?${filters}`);if(sequence!==loadSequence.current||!mounted.current)return;acceptBatch(data,{hydrate});setError('');return data;}
  catch(cause){if(sequence===loadSequence.current&&mounted.current){setOperationError({operation:'read',status:cause.status});setError(`No se pudo actualizar la importación. Conservamos el trabajo local y la última lectura. ${diagnosticText(cause)}`);}}
  finally{if(sequence===loadSequence.current&&mounted.current)setLoading(false);}
 },[api,acceptBatch]);
 async function inspectRows(location){
  const exact=location?.sheet&&Number.isInteger(Number(location.rowNumber))?{sheet:location.sheet,rowNumber:Number(location.rowNumber)}:null;
  setSourceRowsOpen(true);setRowQuery('');setRowState('');setPage(1);setRowLocation(exact);
  const data=await loadBatch(batch.id,{...(exact||{})});
  if(data)requestAnimationFrame(()=>document.querySelector('[data-import-source-rows]')?.focus());
 }
 function configureSheet(name,section='columns'){
  setIncludeValidOnly(false);setStep(2);setActiveSheet(batch?.workbook?.sheets.some(sheet=>sheet.name===name)?name:'');setSheetFocus(section);
  if(section==='cutoff')setReadingOpen(true);
 }
 useEffect(()=>{
  if(savedBatchId&&currentBatch.current?.id===savedBatchId)return;
  loadSequence.current++;setError('');setOperationError(null);setResolver(null);setStatusDraft('');setProfileName('');setIncludeValidOnly(false);setPage(1);setRowState('');setRowQuery('');setRowLocation(null);setSourceRowsOpen(false);
  if(savedBatchId){if(currentBatch.current?.id!==savedBatchId){setBatch(null);void loadBatch(savedBatchId,{hydrate:true});}}
  else{setBatch(null);setWorkbookConfig(blankConfig());setActiveSheet('');setInventoryOpening(null);setOpeningDate('');setFileCutoff('');setOwnFiles(false);setResolutions([]);setFile(null);setPlatformId('');setSourceId('');setProfileId('');setStep(1);baseline.current='';prefillContext.current='';}
 },[savedBatchId,isNew,loadBatch]);
 useEffect(()=>{
  if(!isNew)return;
  const context=json([view?.source||'',view?.record||'']);
  if(context!==prefillContext.current){
   prefillContext.current=context;setSourceId('');setPlatformId('');setProfileId('');setWorkbookConfig(blankConfig());setActiveSheet('');setInventoryOpening(null);setResolutions([]);setFile(null);setPlatformName('');setSourceName('');setProfileName('');
  }
  if(!view?.source&&!view?.record)return;
  let active=true;
  async function prefill(){
   try{
    const profile=view.record?await api('/api/admin/business/profiles/'+encodeURIComponent(view.record)):null;
    if(view.source&&profile&&profile.sourceId!==view.source)throw new Error('El perfil no pertenece a la cuenta del enlace. Selecciona un perfil de esta cuenta.');
    const source=await api('/api/admin/business/sources/'+encodeURIComponent(view.source||profile.sourceId));
    if(!active||currentBatch.current)return;
    setPlatformId(source.platformId);setSourceId(source.id);setAdvancedSource(source.name!=='Principal');setProfileId(profile?.id||'');
    if(profile)setWorkbookConfig(profileConfig(profile));
    setNotice(profile?'Cuenta y perfil del enlace seleccionados. Revisa el archivo antes de importar.':'Cuenta del enlace seleccionada. Elige el archivo de esta cuenta.');
   }catch(cause){if(active)setError(cause.message);}
  }
  void prefill();return()=>{active=false;};
 },[api,view.source,view.record,isNew,resourceRetry]);
 useEffect(()=>{if(!batch?.id||!ACTIVE_STATES.has(batch.state)||error||busy||decision)return;const id=batch.id,timer=setTimeout(()=>{void loadBatch(id,{targetPage:page,state:rowState,q:rowQuery,...rowLocation||{}});},1500);return()=>clearTimeout(timer);},[batch,page,rowState,rowQuery,rowLocation,error,busy,decision,loadBatch]);
 useEffect(()=>{
  if(!batch?.id||!FINAL_STATES.has(batch.state))return;const key=`${batch.id}:${batch.state}:${batch.version}`;if(lastNotification.current!==key){lastNotification.current=key;onMutation?.({type:'import',batchId:batch.id,state:batch.state});}
 },[batch,onMutation]);
 useEffect(()=>{
  const sequence=++sourceSequence.current;setSources([]);if(!platformId)return;
  api('/api/admin/business/sources?'+new URLSearchParams({platform:platformId})).then(data=>{if(sequence!==sourceSequence.current||!mounted.current)return;const rows=records(data);setSources(rows);setSourceId(current=>currentBatch.current?.sourceId|| (rows.some(row=>row.id===current)?current:rows.find(row=>row.active&&row.name==='Principal')?.id||''));}).catch(cause=>{if(sequence===sourceSequence.current)setError(cause.message);});
 },[platformId,api,resourceRetry]);
 useEffect(()=>{
  const sequence=++profileSequence.current;setProfiles([]);if(!sourceId)return;
  api('/api/admin/business/profiles?'+new URLSearchParams({source:sourceId})).then(data=>{if(sequence===profileSequence.current&&mounted.current)setProfiles(records(data));}).catch(cause=>{if(sequence===profileSequence.current)setError(cause.message);});
 },[sourceId,api,resourceRetry]);
 async function perform(label,fn){
  if(requestBusy.current||cancellationRequested.current)return;
  requestBusy.current=true;loadSequence.current++;setLoading(false);setBusy(label);setError('');setOperationError(null);setNotice('');
  const controller=new AbortController();operationAbort.current=controller;
  const pending=(async()=>{
   try{return await fn();}
   catch(cause){if(mounted.current&&!cancellationRequested.current){setOperationError({operation:label,status:cause.status});setError(diagnosticText(cause));}}
   finally{requestBusy.current=false;if(operationAbort.current===controller)operationAbort.current=null;if(mounted.current&&!cancellationRequested.current)setBusy('');}
  })();
  pendingOperation.current=pending;
  try{return await pending;}finally{if(pendingOperation.current===pending)pendingOperation.current=null;}
 }
 async function discardImport(){
  if(cancellationRequested.current)return;
  const target=currentBatch.current,creation=pendingCreation.current,active=pendingOperation.current,controller=operationAbort.current;
  if(target&&!target.canCancel)return;
  if(!await decide({title:target?.acceptedRevision?'Cancelar importación':'Descartar archivo',description:'Se detendrá lo pendiente cuando el servidor confirme la cancelación.',items:[{key:target?.id||'file',label:target?.filename||file?.name||'Archivo en carga',detail:target?.acceptedRevision?'Importación aceptada; sus operaciones confirmadas se conservan.':'Archivo privado de esta importación.'}],warning:'El original se descartará de forma irreversible. No se deshacen pedidos, inventario ni cobros ya confirmados. Si el servidor terminó primero, la cancelación puede rechazarse.',confirmLabel:'Descartar original y cancelar'}))return;
  if(!target&&!creation){setFile(null);setNotice('Archivo descartado. No se enviaron datos para importar.');return;}
  cancellationRequested.current=true;loadSequence.current++;setLoading(false);setBusy('cancel');setError('');setNotice('');
  let id=target?.id,data=null,failure=null;
  try{
   try{
    if(!id)id=(await creation).id;
    controller?.abort();
    data=await api(`/api/admin/imports/${encodeURIComponent(id)}/cancel`,{method:'POST',body:json({requestId:requestId()})});
    if(data.state!=='cancelled')throw new Error('El servidor no confirmó la cancelación.');
   }catch(cause){failure=cause;}
   await active;
   if(!mounted.current)return;
   if(!failure){
    acceptBatch(data,{hydrate:true});setIncludeValidOnly(false);
    await loadLists();
    if(view?.batch!==id){
     onInteractionStateChange?.({busy:false,dirty:false});
     await new Promise(resolve=>requestAnimationFrame(resolve));
     if(mounted.current)onViewChange?.({batch:id,record:undefined});
    }
   }else{
    if(id)await loadBatch(id,{targetPage:page,state:rowState,q:rowQuery,...rowLocation||{}});
    if(mounted.current)setError(`No se confirmó la cancelación; no afirmamos que el archivo se haya descartado. ${diagnosticText(failure)} Revisa el estado actual antes de continuar.`);
   }
  }finally{cancellationRequested.current=false;if(mounted.current)setBusy('');}
 }
 async function createResource(resource,name){const created=await api('/api/admin/business/'+resource,{method:'POST',body:json({name,requestId:requestId(),...(resource==='sources'?{platformId}:{})})});void loadOptions();return created;}
 async function addPlatform(event){event.preventDefault();await perform('platform',async()=>{const created=await createResource('platforms',platformName);setPlatforms(old=>[...old,created]);setPlatformId(created.id);setSourceId('');setPlatformName('');setNotice('Plataforma creada. Se usará su cuenta Principal.');});}
 async function addSource(event){event.preventDefault();await perform('source',async()=>{const created=await createResource('sources',sourceName);setSources(old=>[...old,created]);setSourceId(created.id);setProfileId('');setSourceName('');setNotice('Cuenta creada: sus identidades serán independientes.');});}
 async function addOwnSource(event){event.preventDefault();await perform('platform',async()=>{const created=await createResource('platforms',platformName);setPlatforms(old=>[...old,created]);setPlatformId(created.id);setSourceId('');setProfileId('');setPlatformName('');setOwnFiles(false);setNotice('Origen propio creado. Usaremos Principal para conservar sus identidades; no se creó ninguna cuenta de dinero.');});}
 function selectProfile(id){
  const replace=()=>{const selected=profiles.find(profile=>profile.id===id);setProfileId(id);setWorkbookConfig(selected?profileConfig(selected):blankConfig());setActiveSheet('');setIncludeValidOnly(false);setNotice(selected?'Perfil elegido. Confirma el corte de este archivo; no copiamos el corte anterior.':'Configura las hojas de este archivo.');};
  if(batch&&draft!==baseline.current&&!window.confirm('Hay cambios en el borrador. Cancelar conserva tus cambios; Aceptar los descarta y carga el perfil elegido.'))return;
  replace();
 }
 function chooseFile(event){const selected=event.target.files?.[0];event.target.value='';if(!selected)return;setError('');if(selected.size>MAX_BYTES){setError('El archivo supera el máximo de 10 MiB.');return;}if(!/\.(xlsx|xls|xlsb|xlsm)$/i.test(selected.name)){setError('Selecciona un archivo .xlsx, .xls, .xlsb o .xlsm.');return;}setFile(selected);}
 async function upload(event){event.preventDefault();let createdId=null;
  await perform('upload',async()=>{
   if(!platformId||!sourceId)throw new Error('Selecciona una plataforma y una cuenta real.');if(!file)throw new Error('Selecciona el archivo Excel.');
   let target=batch;
   if(!target){const creation=api('/api/admin/imports',{method:'POST',signal:operationAbort.current?.signal,body:json({sourceId,profileId:profileId||undefined,requestId:requestId()})});pendingCreation.current=creation;try{target=await creation;}finally{if(pendingCreation.current===creation)pendingCreation.current=null;}createdId=target.id;acceptBatch(target,{hydrate:false});}
   if(cancellationRequested.current)return;
   if(target.fileHash)throw new Error('Los bytes de este lote son inmutables. Crea otro lote para otro archivo.');
   const uploaded=await api(`/api/admin/imports/${encodeURIComponent(target.id)}/file`,{method:'PUT',signal:operationAbort.current?.signal,headers:{'Content-Type':file.type||'application/octet-stream','x-filename':encodeURIComponent(file.name),'x-batch-version':String(target.version),'x-request-id':requestId()},body:file});
   if(cancellationRequested.current)return;
   acceptBatch(uploaded,{hydrate:true});setFile(null);if(uploaded.state!=='cancelled')setNotice('Archivo guardado. El servidor leerá las hojas sin ejecutar fórmulas ni macros. Puedes volver a importaciones mientras trabaja.');
  });
  if(createdId){
   // Let perform finish rendering before handing the persisted ID to navigation.
   await new Promise(resolve=>requestAnimationFrame(resolve));
   if(!mounted.current||cancellationRequested.current||currentBatch.current?.id!==createdId||currentBatch.current.state==='cancelled')return;
   onInteractionStateChange?.({busy:false,dirty:false});
   onViewChange?.({batch:createdId,record:undefined});
   // This URL handoff is not a discard: failed uploads still have unsaved bytes.
   onInteractionStateChange?.({busy:false,dirty:!!file&&!currentBatch.current?.fileHash});
  }
 }
 function sheetWork(sheet,configuration=workbookConfig){
  const selected=configuration.sheets.find(item=>item.sheetName===sheet.name);
  if(!selected)return {sheet,undecided:true,pending:[],issues:[]};
  const samples=batch?.workbook?.inspections?.find(item=>item.sheetName===sheet.name&&Number(item.headerRow)===Number(selected.headerRow))||(batch?.workbook?.sheetName===sheet.name&&Number(batch.workbook.headerRow)===Number(selected.headerRow)?batch.workbook:null);
  const header=samples?.rows?.find(row=>row.rowNumber===Number(selected.headerRow))?.cells||[],count=samples?Math.min(200,Math.max(header.length,sheet.columnCount||0,...(samples.rows||[]).map(row=>row.cells?.length||0))):0;
  const pending=Array.from({length:count},(_,index)=>selected.columns.find(column=>column.index===index)||{index,header:normalizedHeader(cellText(header[index])),destination:'',group:0}).filter(column=>!column.destination);
  return {sheet,selected,samples,pending,issues:getImportColumnIssues(selected.columns,selected.layout,selected.purpose)};
 }
 function focusNextSheet(){
  const next=(batch?.workbook?.sheets||[]).map(sheet=>sheetWork(sheet)).find(item=>item.undecided||item.selected.enabled&&(!item.samples||item.pending.length||item.issues.length||!item.selected.columns.some(column=>column.destination&&column.destination!=='ignore')));
  if(next){selectSheet(next.sheet.name);setNotice(next.undecided?'Decide si incluyes esta hoja.':!next.samples?'Lee las muestras de esta hoja y encabezado.':'Completa las columnas de esta hoja.');}
  else{const missing=workbookConfig.sheets.find(sheet=>sheet.enabled&&!batch.workbook.sheets.some(item=>item.name===sheet.sheetName));if(missing){setActiveSheet('');setNotice('La configuración tiene hojas ausentes. Exclúyelas en el catálogo para continuar.');requestAnimationFrame(()=>document.querySelector('[data-import-missing-sheets] button')?.focus());}else if(batch.workbook.sheets.length){selectSheet(batch.workbook.sheets[0].name);setNotice('Incluye al menos una hoja del catálogo para revisar datos.');}}
 }
 function focusPendingColumns(){
  const next=(batch?.workbook?.sheets||[]).map(sheet=>sheetWork(sheet)).find(item=>item.selected?.enabled&&(!item.samples||item.pending.length||item.issues.length||!item.selected.columns.some(column=>column.destination&&column.destination!=='ignore')));
  if(!next){focusNextSheet();return;}setActiveSheet(next.sheet.name);setSheetFocus(next.samples?'columns':'samples');
 }
 useEffect(()=>{
  if(!sheetFocus||step!==2)return;
  const frame=requestAnimationFrame(()=>{const root=mappingRootRef.current?.closest('form')||document.querySelector('[data-import-sheet-form]'),target=root?.querySelector(`[data-import-config="${sheetFocus}"]`);for(let node=target?.parentElement;node&&node!==root;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;if(sheetFocus==='defaults')target?.querySelectorAll('details').forEach(node=>{node.open=true;});if(sheetFocus==='columns')target?.querySelector('[data-import-next-column]')?.click();else (target?.querySelector('input:not(:disabled),button:not(:disabled),select:not(:disabled)')||target||document.querySelector('[data-import-sheet-catalog-title]'))?.focus();setSheetFocus('');});
  return()=>cancelAnimationFrame(frame);
 },[sheetFocus,activeSheet,step]);
 async function saveDraft({nextConfig=workbookConfig,nextResolutions=resolutions,nextProfileId=profileId}={}){
  const target=currentBatch.current;if(!target)throw new Error('Primero guarda el archivo.');
  if(!canEditDraft)throw new Error('Esta importación no permite editar el borrador ahora.');
  nextConfig={...nextConfig,sheets:nextConfig.sheets.map(sheet=>{const actual=batch?.workbook?.sheets?.find(item=>item.name===sheet.sheetName);if(!actual||!sheet.enabled)return sheet;const missing=sheetWork(actual,nextConfig).pending.filter(column=>!sheet.columns.some(item=>item.index===column.index));return {...sheet,columns:[...sheet.columns,...missing].sort((a,b)=>a.index-b.index)};})};
  const invalid=nextConfig.sheets.filter(sheet=>sheet.enabled).flatMap(sheet=>getImportColumnIssues(sheet.columns,sheet.layout,sheet.purpose).map(issue=>({...issue,sheetName:sheet.sheetName})));
  if(invalid.length){focusColumnProblems.current=true;setActiveSheet(invalid[0].sheetName);setStep(2);throw new Error(invalid[0].message);}
  const base=new Map((target.resolutions||[]).map(item=>[resolutionIdentity(item),item])),changes=nextResolutions.filter(item=>{const saved=base.get(resolutionIdentity(item));return !saved||(saved.internalId||null)!==(item.internalId||null)||(saved.entityKey||null)!==(item.entityKey||null)||json(saved.value??null)!==json(item.value??null)||(saved.reason||'').trim()!==(item.reason||'').trim();});
  let result=target;
  for(let offset=0;offset<Math.max(1,changes.length);offset+=100){
   if(cancellationRequested.current)return null;
   try{
    result=await api(`/api/admin/imports/${encodeURIComponent(target.id)}`,{method:'PUT',signal:operationAbort.current?.signal,body:json({version:result.version,requestId:requestId(),...(offset===0?{config:nextConfig,profileId:nextProfileId||null,inventoryOpening}:{}),resolutions:changes.slice(offset,offset+100)})});
   }catch(cause){const failure=new Error(`Se guardaron ${offset} de ${changes.length} resoluciones nuevas. Las restantes siguen en este borrador. ${diagnosticText(cause)}`,{cause});failure.status=cause.status;throw failure;}
   if(cancellationRequested.current)return null;
   acceptBatch(result);
  }
  const storedConfig=clientConfig(result.config||nextConfig),storedResolutions=result.resolutions||nextResolutions,storedProfile=result.profileId||nextProfileId||'';
  acceptBatch(result);setWorkbookConfig(storedConfig);setResolutions(storedResolutions);setProfileId(storedProfile);setInventoryOpening(result.inventoryOpening||null);baseline.current=json({config:storedConfig,resolutions:storedResolutions,profileId:storedProfile,inventoryOpening:result.inventoryOpening||null});return result;
 }
 async function saveAndPreview(event){
  event?.preventDefault();await perform('preview',async()=>{
   if(batch?.state==='previewing')return;
   const work=(batch?.workbook?.sheets||[]).map(sheet=>sheetWork(sheet));
   if(work.some(item=>item.undecided)||workbookConfig.sheets.some(sheet=>sheet.enabled&&!batch.workbook?.sheets.some(item=>item.name===sheet.sheetName))){focusNextSheet();setStep(2);throw new Error('Decide qué hacer con cada hoja, incluidas las ausentes de la configuración guardada.');}
   if(work.some(item=>item.selected?.enabled&&(!item.samples||item.pending.length||item.issues.length))){focusPendingColumns();setStep(2);throw new Error('Lee las muestras y resuelve las columnas pendientes antes de revisar.');}
   const selected=workbookConfig.sheets.filter(sheet=>sheet.enabled);
   if(!selected.length)throw new Error('Elige y confirma al menos una hoja para revisar.');
   for(const sheet of selected){const pending=sheet.columns.find(column=>!column.destination);if(pending){focusColumnProblems.current={index:pending.index};setActiveSheet(sheet.sheetName);setStep(2);throw new Error(`Completa o ignora explícitamente la columna ${pending.index+1} «${pending.header||'Sin encabezado'}» de ${sheet.sheetName}. Guardar el borrador no decide por ti.`);}}
   if(selected.some(sheet=>!sheet.columns.some(column=>column.destination&&column.destination!=='ignore')))throw new Error('Confirma las columnas de cada hoja elegida; puedes excluir las hojas que no contienen registros.');
   const saved=await saveDraft();if(!saved)return;
   const data=await api(`/api/admin/imports/${encodeURIComponent(saved.id)}/preview`,{method:'POST',signal:operationAbort.current?.signal,body:json({version:saved.version,requestId:requestId()})});
   if(cancellationRequested.current)return;acceptBatch(data);setIncludeValidOnly(false);
  });
 }
 async function saveProfile(event){
  event.preventDefault();await perform('profile',async()=>{
   if(!profileName.trim())throw new Error('Escribe un nombre para el perfil.');
   const saved=canEditDraft?await saveDraft():currentBatch.current;if(!saved)return;
   const selected=profiles.find(profile=>profile.id===profileId),data=await api('/api/admin/business/profiles'+(selected?'/'+encodeURIComponent(selected.id):''),{method:selected?'PUT':'POST',body:json({name:profileName,sourceId,profile:saved.config,requestId:requestId(),...(selected?{version:selected.version}:{})})});
   if(cancellationRequested.current)return;
   setProfiles(old=>[...old.filter(profile=>profile.id!==data.id),data]);
   if(canEditDraft){setProfileId(data.id);currentBatch.current=saved;await saveDraft({nextConfig:saved.config,nextProfileId:data.id});}
   if(cancellationRequested.current)return;
   setProfileName('');setNotice(`Perfil «${data.name}» guardado para próximas cargas. El corte debe confirmarse otra vez; guardar un perfil no aplica operaciones.`);
  });
 }
 async function commit(){await perform('commit',async()=>{if(commitBlockedReason)throw new Error(commitBlockedReason);const data=await api(`/api/admin/imports/${encodeURIComponent(batch.id)}/commit`,{method:'POST',signal:operationAbort.current?.signal,body:json({version:batch.version,previewHash:batch.preview.previewHash,includeValidOnly,requestId:requestId()})});if(cancellationRequested.current)return;acceptBatch(data);setStep(4);onMutation?.({type:'import',batchId:data.id,state:data.state});});}
 async function download(kind){await perform('download',async()=>{const path=kind==='template'?'/api/admin/imports/template':`/api/admin/imports/${encodeURIComponent(batch.id)}/${kind}`,blob=await api(path,{responseType:'blob',signal:operationAbort.current?.signal});if(cancellationRequested.current)return;const url=URL.createObjectURL(blob),anchor=document.createElement('a'),names={template:'plantilla-negocio.xlsx',file:batch?.filename,expanded:`${batch?.filename?.replace(/\.[^.]+$/,'')||'negocio'} - con operacion.xlsx`,prepared:`datos-preparados-${batch?.id}.xlsx`,errors:`errores-${batch?.id}.xlsx`};try{anchor.href=url;anchor.download=safeName(names[kind]);document.body.appendChild(anchor);anchor.click();anchor.remove();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}});}
 function updateConfig(key,value){setConfig(old=>{
  if(key==='purpose')return {...old,purpose:value,layout:value==='expenses'?'expense_rows':['allocations','component_costs','observations'].includes(value)?'relation_rows':'item_rows',identityMode:'provided',defaults:{},expenseGroupNames:{},expenseCategoryMap:{},columns:old.columns.map(column=>({...column,destination:column.destination==='ignore'||isImportFieldAllowed(column.destination,value)?column.destination:'',group:0}))};
  return {...old,[key]:value,...(key==='layout'?{identityMode:value==='item_rows'||value==='relation_rows'?'provided':old.identityMode,columns:old.columns.map(column=>({...column,group:0})),...(value!=='expense_columns'?{expenseGroupNames:{}}:{})}:{})};
 });setIncludeValidOnly(false);}
 function changeColumn(index,header,patch){setConfig(old=>{const columns=[...old.columns],position=columns.findIndex(column=>column.index===index),previous={...(columns[position]||{})};if(patch.destination!==undefined&&patch.destination!==previous.destination)delete previous.fieldName;const next={destination:'ignore',group:0,...previous,index,header:normalizedHeader(header),...patch},definition=FIELD_DEFINITIONS.get(next.destination);if(definition?.type!=='additional')delete next.fieldName;if(!(definition?.scope==='line'&&old.layout==='order_rows'||definition?.scope==='expense_line'&&old.layout==='expense_columns'))next.group=0;if(position<0)columns.push(next);else columns[position]=next;return {...old,columns};});setIncludeValidOnly(false);}
 function addResolutions(items){const keys=new Set(items.map(resolutionIdentity));setResolutions(old=>[...old.filter(item=>!keys.has(resolutionIdentity(item))),...items]);setIncludeValidOnly(false);}
 function addResolution(item){addResolutions([item]);}
 async function openResolver(action,context={}){
  if(!canEditDraft)return;
  if(resolver&&!window.confirm('Hay una resolución sin guardar. ¿Descartarla?'))return;
  const group=groups.find(group=>groupKey(group)===(context.entityKey||groupKey(context))),items=group?.lines||[],unit=group?.units?.[0];
  let value=['review_authority','commercial_update'].includes(action)?{}:'';
  if(action==='line_costs')value={lineCosts:items.map(line=>{const cost=group.units?.flatMap(unit=>unit.lineCosts||[]).find(cost=>cost.lineId===line.lineId);return {lineId:line.lineId,selected:true,unitCostMinor:cost?.unitCostMinor??line.orderUnitCostMinor??line.unitCostMinor??null,...(line.components?.length?{components:line.components.map(component=>({productId:component.productId,unitCostMinor:cost?.components?.find(item=>item.productId===component.productId)?.unitCostMinor??component.unitCostMinor??null}))}:{})};})};
  const refs=context.rowRefs||group?.rowRefs||[],single=refs.length===1?refs[0]:{};
  const next={...context,action,entityKey:context.allRows?'':context.entityKey||groupKey(context),sheet:context.allRows?'':context.sheet||single.sheet||'',rowNumber:context.allRows?'':context.rowNumber||single.rowNumber||'',externalKey:context.externalKey||(action==='line_costs'?unit?.values?.externalOrderId||unit?.key:'')||'',columnIndex:context.columnIndex??0,cellType:context.cellType||'text',internalId:context.internalId||'',value:context.value??value,reason:context.reason||''};
  if(action==='link_product'){
   const matchingLines=(context.normalized?.lines||[]).filter(line=>line.productExternalKey===next.externalKey);
   next.giftOnly=context.giftOnly===true||context.productType==='gift'||batch?.pendingProductLinks?.some(link=>link.externalKey===next.externalKey&&link.giftOnly)||matchingLines.length>0&&matchingLines.every(line=>line.giftOnly)||group?.errors?.some(issue=>issue.code==='IMPORT_GIFT_LINK'&&issue.externalKey===next.externalKey)||false;
   const saved=resolutions.find(item=>resolutionIdentity(item)===resolutionIdentity(next))||[...resolutions].reverse().find(item=>item.action===action&&item.externalKey===next.externalKey&&(!item.entityKey||item.entityKey===next.entityKey)&&(!item.sheet||item.sheet===next.sheet)&&(!item.rowNumber||Number(item.rowNumber)===Number(next.rowNumber)));
   if(saved&&!next.internalId){next.internalId=saved.internalId;next.reason=next.reason||saved.reason||'';}
  }
  setError('');setResolver(next);setLookup([]);setLookupQuery('');
  if(action==='review_policy')await perform('rules',async()=>{const data=await api('/api/admin/business/settings');setRules(data.rulesVersions||[]);});
 }
 function closeResolver(){setResolver(null);}
 const searchLookup=useCallback(async(action,query)=>{
  const sequence=++lookupSequence.current;setLookupLoading(true);setError('');
  try{
   let found;
   if(action==='link_product'){const data=await Promise.all([api('/api/admin/products'),api('/api/admin/combos')]);found=catalogRecords(data);if(sequence===lookupSequence.current&&mounted.current)setProductRecords(found);}
   else{let path;if(action==='link_person')path='/api/admin/business/people?active=1';else if(action==='link_order')path='/api/admin/orders?'+new URLSearchParams({q:query,page:'1',lookup:'identity'});else if(action==='link_shipment')path='/api/admin/business/shipments?'+new URLSearchParams({q:query,page:'1'});else if(action==='link_expense')path='/api/admin/finance/expenses?'+new URLSearchParams({q:query,page:'1'});else return;found=records(await api(path));}
   if(sequence===lookupSequence.current)setLookup(found.filter(item=>action!=='link_expense'||item.sourceId===currentBatch.current?.sourceId&&item.importIdentity).filter(item=>!query||['link_product','link_order','link_shipment','link_expense'].includes(action)||[item.title,item.name,item.sku,item.presentation].some(value=>String(value||'').toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es')))));
  }
  catch(cause){if(sequence===lookupSequence.current)setError(cause.message);}finally{if(sequence===lookupSequence.current)setLookupLoading(false);}
 },[api]);
 useEffect(()=>{if(!resolver?.action?.startsWith('link_'))return;const timer=setTimeout(()=>{void searchLookup(resolver.action,lookupQuery);},250);return()=>{clearTimeout(timer);lookupSequence.current++;};},[resolver?.action,lookupQuery,searchLookup]);
 async function applyResolution(event){
  event.preventDefault();const {action,entityKey,sheet,rowNumber,externalKey,internalId,value,reason,columnIndex,cellType}=resolver;
  let resolvedValue=value;
  if(action==='review_policy')resolvedValue={ruleVersionId:value};
  if(action==='accept_formulas')resolvedValue=true;
  if(action==='accept_formulas'&&!sheet){setError('Elige la hoja cuyos valores guardados revisaste.');return;}
  if(action==='independent_record'&&!resolver.bulkRows?.length)resolvedValue=value||requestId();
  if(action==='opening_observation'&&typeof value!=='boolean'){setError('Confirma si este hecho estaba incluido en el conteo.');return;}
  if(action==='cell_value'){
   if(cellType==='null')resolvedValue=null;
   else if(cellType==='number'){if(String(value).trim()===''||!Number.isFinite(Number(value))){setError('Indica un número literal válido.');return;}resolvedValue=Number(value);}
   else if(cellType==='boolean'){if(!['true','false'].includes(value)){setError('Elige verdadero o falso.');return;}resolvedValue=value==='true';}
  }
  if(action==='line_costs')resolvedValue={lineCosts:value.lineCosts.filter(line=>line.selected).map(({selected,...line})=>line)};
  if(action==='commercial_update'&&!Object.keys(value).length){setError('Selecciona al menos un dato comercial o completa las líneas.');return;}
  if(resolver.bulkRows?.length){addResolutions(resolver.bulkRows.map(ref=>({action:'independent_record',sheet:ref.sheet,rowNumber:ref.rowNumber,value:requestId(),reason})));closeResolver();setNotice('Cada fila seleccionada tiene su propia identidad técnica nueva. Guarda y revisa antes de aplicar.');return;}
  if(resolver.bulkObservations?.length){addResolutions(resolver.bulkObservations.map(({sheet,rowNumber,externalKey})=>({action:'opening_observation',sheet,rowNumber,externalKey,value:resolvedValue,reason})));closeResolver();setNotice('Hechos concretos clasificados. Guarda y revisa de nuevo sus efectos físicos.');return;}
  if(['duplicate','additional_quantity','independent_record','cell_value','link_expense','opening_observation'].includes(action)&&(!rowNumber||!sheet)){setError('Indica la hoja y fila exactas de esta corrección.');return;}
  const cellOnly=action==='cell_value',prepared={action,...(entityKey&&!cellOnly?{entityKey}:{}),...(sheet?{sheet}:{}),...(rowNumber?{rowNumber:Number(rowNumber)}:{}),...(externalKey&&!cellOnly?{externalKey}:{}),...(internalId&&!cellOnly?{internalId}:{}),...(cellOnly?{columnIndex:Number(columnIndex)}:{}),...(resolvedValue!==''||cellOnly?{value:resolvedValue}:{}),...(reason?{reason}:{})};
  if(action==='link_product'){
   if(!internalId||!externalKey.trim()){setError('Selecciona la referencia existente y su identificador del archivo.');return;}
   if(resolver.giftOnly&&!productRecords.some(item=>item.id===internalId&&item.kind==='products'&&item.productType==='gift')){setError('Esta referencia necesita un Obsequio con componentes. Cambia el vínculo seleccionado.');return;}
   const next=[...resolutions.filter(item=>resolutionIdentity(item)!==resolutionIdentity(prepared)),prepared];
   await perform('save-link',async()=>{
    const saved=await saveDraft({nextResolutions:next});if(!saved)return;
    closeResolver();setStep(3);setNotice(`Vínculo guardado: ${externalKey} → ${productRecords.find(item=>item.id===internalId)?.title||internalId}. Revisa los datos guardados para validar el pedido; no se creó otro producto ni se importaron operaciones.`);
   });
   return;
  }
  if(resolver.bulkKeys?.length){const keys=new Set(resolver.bulkKeys);addResolutions(groups.filter(group=>keys.has(groupKey(group))).map(group=>({...prepared,entityKey:groupKey(group),sheet:undefined,rowNumber:undefined})));}
  else addResolution(prepared);
  closeResolver();setNotice('Resolución preparada. Genera una revisión nueva para validar sus consecuencias.');
 }
 async function createProduct(kind='products',productType='product'){
  if(resolver.internalId){setError('Ya seleccionaste una referencia existente. Usa «Guardar vínculo»; no necesitas crear otra.');return;}
  const previousResolver={...resolver};
  const context=await perform('create-product',async()=>{const saved=await saveDraft();if(!saved)return null;return {batchId:saved.id,sourceId:saved.sourceId,externalKey:previousResolver.externalKey,entityKey:previousResolver.entityKey,rowNumber:previousResolver.rowNumber,sheet:previousResolver.sheet,kind,productType};});
  if(!context)return;setResolver(null);onInteractionStateChange?.({busy:false,dirty:false});
  await new Promise(resolve=>requestAnimationFrame(resolve));
  if(view?.batch!==context.batchId){onViewChange?.({batch:context.batchId,record:undefined});await new Promise(resolve=>requestAnimationFrame(resolve));}
  try{
   const created=await onCreateProduct?.(context),product=created?.record||created;
   if(!mounted.current)return;
   if(!product?.id){setResolver(previousResolver);setStep(3);setNotice('Creación cancelada. Conservamos el lote y sus vínculos guardados; elige una referencia existente o crea una nueva.');return;}
   const resolution={action:'link_product',externalKey:context.externalKey,...(context.entityKey?{entityKey:context.entityKey}:{}),...(context.sheet?{sheet:context.sheet}:{}),...(context.rowNumber?{rowNumber:context.rowNumber}:{}),internalId:product.id};
   const next=[...(currentBatch.current.resolutions||[]).filter(item=>resolutionIdentity(item)!==resolutionIdentity(resolution)),resolution];
   const createdProduct={...product,kind};setProductRecords(old=>[...old.filter(item=>item.id!==product.id),createdProduct]);setResolutions(next);
   await perform('save',async()=>{await saveDraft({nextResolutions:next});setNotice(`${catalogType(createdProduct)} creado y vínculo guardado: ${context.externalKey} → ${product.title}. Genera una nueva revisión antes de importar.`);});
  }catch(cause){if(mounted.current){setResolver(previousResolver);setStep(3);setError(cause.message);}}
 }
 const workbook=batch?.workbook,sheets=workbook?.sheets||[],inspection=workbook?.inspections?.find(sheet=>sheet.sheetName===config.sheetName&&Number(sheet.headerRow)===Number(config.headerRow))||(workbook?.sheetName===config.sheetName&&Number(workbook?.headerRow)===Number(config.headerRow)?workbook:null),samplesCurrent=!!inspection,sampleRows=inspection?.rows||[],selectedSheet=sheets.find(sheet=>sheet.name===config.sheetName),headerSample=sampleRows.find(row=>row.rowNumber===Number(config.headerRow)),headers=headerSample?.cells||[],sampleColumns=samplesCurrent?Math.min(200,Math.max(headers.length,selectedSheet?.columnCount||0,...sampleRows.map(row=>row.cells?.length||0))):0,groups=serverGroups(batch),summary=batch?.preview?.summary||batch?.summary||{},invalidGroups=groups.filter(group=>['conflict','rejected','invalid'].includes(group.state)||group.valid===false||group.errors?.length),invalidCount=Number(summary.conflict??0)+Number(summary.rejected??summary.invalid??0)||invalidGroups.length,validCount=Number(summary.valid??groups.length-invalidGroups.length),hasPreview=!!batch?.preview?.previewHash;
 const settlementsPending=Number(summary.settlementsPending||0),hasImportable=validCount>0||settlementsPending>0;
 const reviewReady=batch?.state==='review'&&hasPreview&&!diagnostic&&!draftChanged&&!fileUnavailable;
 const sheetWorkItems=sheets.map(sheet=>sheetWork(sheet)),pendingSheetDecisions=!workbookConfig.sheets.some(sheet=>sheet.enabled)||sheetWorkItems.some(item=>item.undecided)||workbookConfig.sheets.some(sheet=>sheet.enabled&&!sheets.some(item=>item.name===sheet.sheetName)),pendingSheetColumns=sheetWorkItems.some(item=>item.selected?.enabled&&(!item.samples||item.pending.length||item.issues.length||!item.selected.columns.some(column=>column.destination&&column.destination!=='ignore')));
 const columnsConfirmed=!!workbook&&!pendingSheetDecisions&&!pendingSheetColumns&&workbookConfig.sheets.some(sheet=>sheet.enabled);
 useEffect(()=>{setIncludeValidOnly(false);},[draft,batch?.preview?.previewHash,batch?.fileHash]);
 const commitBlockedReason=fileUnavailable?'El archivo original ya no está disponible. Inicia una nueva importación.':workLocked?'El servidor está aplicando esta importación.':!canEditDraft?'Esta importación es de consulta.':dirty?'Guarda los cambios y genera una revisión nueva antes de importar.':!reviewReady?'Espera una revisión actualizada antes de importar.':!hasImportable?'No hay operaciones o liquidaciones elegibles para importar.':invalidCount>0&&!includeValidOnly?'Resuelve los pendientes o elige explícitamente la importación parcial.':'';
 const retained=!!batch?.fileHash&&!fileUnavailable;
 const downloadItems=[
  {kind:'file',label:'Original',description:'El archivo recibido, sin modificar.',available:retained,reason:batch?.fileDiscarded?'El original fue descartado.':fileUnavailable?'Venció la retención del original.':'Primero guarda el archivo.'},
  {kind:'prepared',label:'Datos preparados para volver a importar',description:batch?.acceptedRevision?'Descarga la revisión aceptada, no las correcciones preparadas después.':'Datos seleccionados, correcciones e identidades estables; no es una copia íntegra del original.',available:retained&&(!!batch?.acceptedRevision||hasPreview&&!dirty),reason:!retained?'Necesita el original retenido.':'Guarda los cambios y genera una revisión actualizada.'},
  {kind:'errors',label:'Pendientes y errores',description:'Filas con sus motivos conservados; puede estar vacío si no hay pendientes.',available:!!batch?.fileHash,reason:'Primero guarda el archivo.'},
  ...(/\.xlsx$/i.test(batch?.filename||'')?[{kind:'expanded',label:'Copia con hoja de gastos de operación',description:'Agrega GASTOS OPERACION al XLSX sin cambiar tus otras hojas.',available:retained,reason:'Necesita el original XLSX retenido.'}]:[]),
  {kind:'template',label:'Plantilla vacía',description:'Tablas vacías e instrucciones para preparar un archivo nuevo.',available:true}
 ];
 const savedStatus=cancelled?'Archivo descartado':fileUnavailable?'Archivo no disponible':workLocked||previewing||batch?.state==='uploaded'&&batch?.fileHash?'Procesando en el servidor':dirty?'Sin guardar':hasPreview?'Revisión actualizada':'Guardado; falta revisar';
 function goToStep(next){if(!!busy||workLocked||showResult||next>1&&!batch?.fileHash||next>2&&!columnsConfirmed||next===4&&!hasPreview)return;setIncludeValidOnly(false);setStep(next);}
 const showWizard=!!batch||isNew;
 const issueCounts=useMemo(()=>{const issues=new Map();for(const group of groups)for(const code of new Set((group.errors||[]).map(issue=>issue.code||'Otros datos')))issues.set(code,(issues.get(code)||0)+1);return issues;},[groups]);
 const filteredGroups=groups.filter(group=>(!pendingOnly||group.errors?.length>0)&&(!issueFilter||(group.errors||[]).some(issue=>(issue.code||'Otros datos')===issueFilter))),groupPages=Math.max(1,Math.ceil(filteredGroups.length/20)),shownGroups=filteredGroups.slice((groupPage-1)*20,groupPage*20);
 useEffect(()=>{setPendingOnly(serverGroups(batch).some(group=>group.errors?.length));},[batch?.preview?.previewHash]);
 function changeReviewFilter(code,pending=false){setIssueFilter(code);setPendingOnly(pending);setGroupPage(1);if(selectedGroups.length)setNotice('La selección se limpió al cambiar el filtro.');setSelectedGroups([]);}
 function resolveFirstPending(){setPendingOnly(true);setIssueFilter('');setGroupPage(1);requestAnimationFrame(()=>document.querySelector('[data-import-operation] :is(button,input):not(:disabled)')?.focus());}
 const selectedOperations=useMemo(()=>{const keys=new Set(selectedGroups);return groups.filter(group=>keys.has(groupKey(group)));},[groups,selectedGroups]);
 const [newIdentityRows,openingObservations,yearDates]=useMemo(()=>{
  const rows=new Map(),observations=new Map(),dates=new Map();
  for(const group of selectedOperations)for(const issue of group.errors||[]){
   if(issue.code==='IMPORT_NEW_IDENTITY_REVIEW'&&issue.sheet&&issue.rowNumber)rows.set(json([issue.sheet,issue.rowNumber]),{sheet:issue.sheet,rowNumber:issue.rowNumber});
   if(issue.code==='IMPORT_YEAR_CONFIRMATION'&&issue.sheet&&issue.rowNumber&&Number.isInteger(issue.columnIndex))dates.set(json([issue.sheet,issue.rowNumber,issue.columnIndex]),issue);
   if(issue.code!=='IMPORT_OPENING_CLASSIFICATION'||!issue.externalKey)continue;
   const ref=issue.rowRefs?.[0];if(!ref)continue;
   const event=group.units?.flatMap(unit=>unit.shipments.flatMap(shipment=>shipment.events)).find(event=>event.observationKey===issue.externalKey);
   observations.set(json([ref.sheet,ref.rowNumber,issue.externalKey]),{...ref,externalKey:issue.externalKey,label:`${shipmentStates.find(state=>state.value===event?.status)?.label||'Hecho físico'} · ${event?.occurredOn||event?.occurredAt||'Sin fecha del hecho'}`});
  }
  return [[...rows.values()],[...observations.values()],[...dates.values()]];
 },[selectedOperations]);
 async function keepSelectedOriginalDates(){
  if(!yearDates.length)return;
  if(!await decide({title:'Conservar fechas originales',description:'Se conservarán aunque no coincidan con el año del nombre de la hoja o el archivo.',items:yearDates.map(issue=>({key:json([issue.sheet,issue.rowNumber,issue.columnIndex]),label:`${issue.sheet} · fila ${issue.rowNumber} · columna ${issue.columnIndex+1}`,detail:`Original: ${cellText(issue.originalValue)} · Interpretación: ${issue.normalizedDate}`})),warning:'No se copiará una fecha común ni se corregirá el año por el nombre.',confirmLabel:'Confirmar estas fechas'}))return;
  addResolutions(yearDates.map(issue=>({action:'cell_value',sheet:issue.sheet,rowNumber:issue.rowNumber,columnIndex:issue.columnIndex,value:issue.originalValue,reason:'Conservar las fechas originales tras revisar la discrepancia de año en la selección confirmada'})));setNotice('Fechas originales confirmadas por celda, sin copiar una fecha común. Guarda y revisa de nuevo.');
 }
 const setResolverField=(key,value)=>setResolver(old=>({...old,[key]:value,...(key==='externalKey'&&old.action==='link_product'?{giftOnly:!!batch?.pendingProductLinks?.some(link=>link.externalKey===value&&link.giftOnly)}:{})}));
 const select=(key,label,options)=><Field field={{name:key,label,type:'select',options:options.map(([value,label])=>({value,label}))}} value={config[key]} onChange={value=>updateConfig(key,value)}/>;
 const resume=id=>onViewChange?.({batch:id,record:undefined});
 function startNewBatch(){onViewChange?.({batch:'new',record:undefined});}
 function returnToHistory(){onViewChange?.({batch:undefined,record:undefined});}
 function refreshStatus(){if(resolver?.action?.startsWith('link_'))void searchLookup(resolver.action,lookupQuery);if(batch)void loadBatch(batch.id,{targetPage:page,state:rowState,q:rowQuery,...rowLocation||{}});else if(savedBatchId)void loadBatch(savedBatchId,{hydrate:true});else if(isNew)setResourceRetry(value=>value+1);else void loadLists();}
 async function reloadSaved(){
  if(dirty&&!window.confirm('Hay cambios locales sin guardar. ¿Descartarlos y recargar lo guardado? Cancelar conserva el borrador.'))return;
  const data=await loadBatch(batch.id,{hydrate:true,targetPage:page,state:rowState,q:rowQuery,...rowLocation||{}});
  if(data){setResolver(null);setStatusDraft('');setProfileName('');setNotice('Estado guardado recargado. Revisa antes de continuar.');}
 }
 async function generateNewPreview(){
  if(!retained)return;
  if(draftChanged&&!window.confirm('Hay correcciones locales sin guardar. ¿Descartarlas y generar una revisión desde lo guardado?'))return;
  await perform('preview',async()=>{const data=await api(`/api/admin/imports/${encodeURIComponent(batch.id)}/preview`,{method:'POST',signal:operationAbort.current?.signal,body:json({version:batch.version,requestId:requestId()})});if(cancellationRequested.current)return;acceptBatch(data,{hydrate:true});setIncludeValidOnly(false);setStep(3);setNotice('Revisión nueva solicitada. Las operaciones ya incorporadas se conservan.');});
 }
 async function rereadFile(){
  if(!retained||batch.workbook||diagnostic?.category==='file')return;
  if(draftChanged&&!window.confirm('Se volverá a leer con la configuración guardada. ¿Descartar los cambios locales?'))return;
  await perform('samples',async()=>{const data=await api(`/api/admin/imports/${encodeURIComponent(batch.id)}`,{method:'PUT',signal:operationAbort.current?.signal,body:json({version:batch.version,config:batch.config,requestId:requestId()})});if(cancellationRequested.current)return;acceptBatch(data,{hydrate:true});setStep(2);setNotice('El servidor volverá a leer el mismo original. No se creó otra importación.');});
 }
 const stateChanged=operationError?.status===409&&operationError.operation!=='download';
 const lookupOptions=resolver?.action==='link_product'?lookup.filter(item=>(!resolver.giftOnly||item.kind==='products'&&item.productType==='gift')&&(item.id===resolver.internalId||!lookupQuery||[item.title,item.name,item.sku,item.presentation].some(value=>String(value||'').toLocaleLowerCase('es').includes(lookupQuery.toLocaleLowerCase('es'))))):lookup;
 const selectedProduct=resolver?.action==='link_product'?productRecords.find(item=>item.id===resolver.internalId):null;
 return <section className={`admin-card ${styles.wizard}`} aria-label="Importar Excel">
  {showWizard&&<header className="admin-heading"><div><p className="eyebrow">Incorporar mi negocio · Excel</p><h2 ref={headingRef} tabIndex={-1}>Importar Excel</h2><p className="muted">Pedidos, envíos y gastos, sin confirmar cobros ni pagos.</p></div><div className="admin-actions">{batch&&<button type="button" className="button subtle" disabled={!!busy} onClick={startNewBatch}>Nueva importación</button>}{(batch?batch.canCancel:!!file)&&<button type="button" className="button subtle" disabled={busy==='cancel'} onClick={discardImport}>{busy==='cancel'?'Cancelando…':batch?.acceptedRevision?'Cancelar importación':'Descartar archivo'}</button>}</div></header>}
  {showWizard&&!showResult&&<><ol className={`order-progress ${styles.progress}`} aria-label="Pasos de importación">{['Archivo','Hojas y columnas','Revisar datos','Confirmar'].map((label,index)=>{const number=index+1,saved=number===1?!!batch?.fileHash:number===2?columnsConfirmed:number===3?reviewReady:false,reason=number>1&&!batch?.fileHash?'Primero guarda el archivo':number>2&&!columnsConfirmed?'Completa las hojas y columnas':number===4&&!hasPreview?'Genera una revisión actualizada':'';return <li key={label} aria-current={step===number?'step':undefined} data-saved={saved}><button type="button" className="text-button" disabled={!!busy||workLocked||!!reason} onClick={()=>goToStep(number)}><strong>{number}. {label}</strong></button><span>{step===number?'Estás aquí':saved?'Guardado':reason||'Por confirmar'}</span></li>;})}</ol>
  <div className={styles.stepGuide}><p className={styles.sectionLabel}>Paso {step} de 4</p><h3 ref={stepHeadingRef} tabIndex={-1}>{STEP_GUIDANCE[step-1][0]}</h3><p>{STEP_GUIDANCE[step-1][1]}</p></div></>}
  {error&&!resolver&&<div className="error" role="alert" tabIndex={-1} ref={errorRef}>{stateChanged&&<h3>El estado cambió; revisa antes de continuar</h3>}<p>{diagnosticText(error)}</p><button type="button" className="button subtle" disabled={!!busy} onClick={stateChanged&&batch?reloadSaved:refreshStatus}>{stateChanged&&batch?'Recargar lo guardado':'Actualizar estado'}</button></div>}
  {notice&&<p role="status">{notice}</p>}
  {showWizard&&batch&&<p role="status" aria-live="polite">{savedStatus}</p>}
  {loading&&<p className="muted" role="status">Consultando datos del servidor…</p>}
  {batch&&<details><summary>{batch.filename||'Archivo por guardar'} · {STATE_LABELS[batch.state]||batch.state} · Detalles técnicos</summary><p>ID: {batch.id} · Versión: {batch.version}</p>{batch.fileHash&&<p>Hash: {batch.fileHash}</p>}</details>}
  {batch?.shippingOrigin&&<section aria-label="Paquetes Heka originales">
   <h3>Paquetes Heka completos</h3>
   <p>Cada paquete se incluye completo o se excluye expresamente. Excluir un paquete no excluye el seguimiento ni otros paquetes de la misma guía. Guarda los cambios y revisa antes de confirmar.</p>
   <p>Captura: {batch.shippingOrigin.capturedAt} · Hash de origen: {batch.shippingOrigin.sourceHash}</p>
   <p>El neto ya descuenta el envío total. La comisión es informativa; no se descuenta otra vez. Esta declaración no confirma recaudos, gastos ni recepción bancaria.</p>
   {batch.shippingOrigin.packages.map(packet=><article className={styles.importGroup} key={packet.id}>
    <label className="checkbox-field"><input type="checkbox" checked={!resolutions.some(item=>item.action==='omit_settlement_package'&&item.externalKey===packet.id.trim()&&item.value===true&&!item.remove)} disabled={!!busy||!canEditDraft||previewing} onChange={event=>includeHekaPackage(packet,event.target.checked)}/><span>Incluir paquete completo {packet.id}</span></label>
    <p>{packet.settlementDate} · {packet.rows.length} filas · Bruto {formatMoneyMinor(packet.grossMinor)} · Envío total {formatMoneyMinor(packet.shippingMinor)} · Comisión informada {formatMoneyMinor(packet.commissionMinor)} · Neto firmado {formatMoneyMinor(packet.netMinor)}</p>
    <details><summary>IDs e importes originales por fila · {packet.id}</summary><div className={styles.resultsTable} role="region" aria-label={`Filas originales de ${packet.id}`} tabIndex={0}><table><thead><tr><th scope="col">Origen</th><th scope="col">Documento</th><th scope="col">Envío / guía</th><th scope="col">Transportadora</th><th scope="col">Recaudo</th><th scope="col">Envío total</th><th scope="col">Comisión informada</th><th scope="col">Neto firmado</th></tr></thead><tbody>{packet.rows.map(row=><tr key={`${row.sheet}:${row.rowNumber}`}><td>{row.sheet} · {row.rowNumber}</td><td>{row.documentId}</td><td>{row.externalShipmentId||'Sin ID de envío'} · {row.tracking}</td><td>{row.carrier} · {row.carrierCollection}</td><td>{formatMoneyMinor(row.grossMinor)}</td><td>{formatMoneyMinor(row.shippingMinor)}</td><td>{formatMoneyMinor(row.commissionMinor)}</td><td>{formatMoneyMinor(row.netMinor)}</td></tr>)}</tbody></table></div></details>
   </article>)}
  </section>}
  {diagnostic&&<ImportDiagnostic diagnostic={diagnostic} alertRef={diagnosticRef}/>}
  {diagnostic&&batch&&<section aria-label="Acciones para recuperar la importación"><p>Actualizar estado solo consulta; no repara ni vuelve a procesar el archivo.</p><div className="admin-actions"><button type="button" className="button subtle" disabled={!!busy||loading} onClick={refreshStatus}>Actualizar estado</button>{retained&&!batch.workbook&&diagnostic.category!=='file'&&<button type="button" className="button subtle" disabled={!!busy||previewing} onClick={rereadFile}>Volver a leer el archivo</button>}{retained&&batch.workbook&&diagnostic.category!=='file'&&<><button type="button" className="button subtle" disabled={!!busy||previewing} onClick={()=>configureSheet(diagnostic.sheet,diagnostic.code==='IMPORT_CUTOFF_REQUIRED'?'cutoff':'columns')}>Corregir configuración</button><button type="button" className="button subtle" disabled={!!busy||previewing||draftChanged} onClick={generateNewPreview}>Generar revisión nueva</button></>}{(diagnostic.category==='file'||!retained)&&<button type="button" className="button subtle" onClick={startNewBatch}>Nueva importación</button>}</div>{diagnostic.category==='file'&&<p>Conserva la evidencia y prepara otro archivo. Volver a consultar no cambia un archivo defectuoso.</p>}</section>}
  {previewing&&<p role="status">Preparando revisión en el servidor. El archivo y la configuración están guardados. Puedes navegar o cerrar el panel y retomar este lote; la confirmación estará disponible solo cuando termine la revisión.</p>}
  {!diagnostic&&batch?.progress?.message&&<p role="status">{diagnosticText(batch.progress.message)}</p>}
  {batch?.progress?.settlementIssues?.length>0&&<section className="error" role="alert"><h3>{cancelled?'Excepciones conservadas de liquidaciones':'Liquidaciones por revisar'}</h3><p>{cancelled?'Este lote está cancelado; las excepciones se conservan como historial. Para corregirlas, crea un lote nuevo.':'Los pedidos ya aplicados no se repetirán. Corrige estos vínculos o documentos y genera una revisión nueva.'}</p><ul>{batch.progress.settlementIssues.map((issue,index)=><li key={diagnosticValue(issue.key)||index}>{diagnosticValue(issue.key)} · {messages([issue.error||issue]).join(' ')}</li>)}</ul></section>}
  {!batch&&savedBatchId&&!loading&&!error&&<p role="status">Abriendo importación…</p>}
  {!isNew&&!savedBatchId&&<><ImportHistory resource={listResource} options={options} view={view} onFilter={filters=>onViewChange?.({...filters,record:undefined})} onPage={next=>onViewChange?.({page:next})} onOpen={resume} onNew={startNewBatch} onRetry={loadLists} onRetryOptions={loadOptions} onManageSources={()=>onNavigate?.({section:'business',tab:'platforms'})}/><button type="button" className="button subtle" disabled={!!busy} onClick={()=>download('template')}>Descargar plantilla</button></>}
  {showWizard&&(showResult||step===2&&!workbook)&&<button type="button" className="button subtle" disabled={!!busy} onClick={returnToHistory}>Volver a importaciones</button>}
  {showWizard&&step===1&&(isNew||batch)&&<>
   <h3>¿De dónde viene tu archivo?</h3>
   <p>El origen permite reconocer las mismas operaciones en próximas cargas. No es una cuenta bancaria.</p>
   {options.error&&<div className="error" role="alert"><p>No se pudieron actualizar los orígenes. {options.error}</p><button type="button" className="button subtle" onClick={loadOptions}>Reintentar opciones</button></div>}
   {!batch&&<><button type="button" className="button subtle" aria-expanded={ownFiles} disabled={!!busy} onClick={()=>setOwnFiles(value=>!value)}>Crear un origen para mis archivos</button>{ownFiles&&<form onSubmit={addOwnSource} className={styles.importProposal}><label className="field">Nombre del origen<input required maxLength={150} value={platformName} onChange={event=>setPlatformName(event.target.value)}/></label><p className="small muted">Se creará una cuenta Principal para conservar las identidades de tus archivos.</p><button className="button subtle" disabled={!!busy}>Crear origen</button></form>}</>}
   <form onSubmit={upload}>
    <fieldset disabled={!!busy||!!batch?.fileHash} className={`field ${styles.importGroup}`}><legend>Origen y configuración</legend>
     <label className="field">Origen<select required disabled={!!batch} value={platformId} onChange={event=>{setPlatformId(event.target.value);setSourceId('');setProfileId('');setAdvancedSource(false);}}><option value="">Elige un origen existente</option>{platforms.map(platform=><option key={platform.id} disabled={!platform.active&&!batch} value={platform.id}>{platform.name}{platform.active?'':' · Archivado'}</option>)}</select></label>
     {platformId&&<p>Cuenta: <strong>{sources.find(source=>source.id===sourceId)?.name||'Cargando Principal…'}</strong></p>}
     {platformId&&<details open={advancedSource} onToggle={event=>setAdvancedSource(event.currentTarget.open)}><summary>Uso otra cuenta de este origen</summary><p>Solo si sus operaciones tienen identidades independientes de Principal.</p><label className="field">Cuenta de origen<select disabled={!!batch} value={sourceId} onChange={event=>{setSourceId(event.target.value);setProfileId('');}}><option value="">Elige una cuenta</option>{sources.map(source=><option key={source.id} disabled={!source.active&&!batch} value={source.id}>{source.name}{source.active?'':' · Archivada'}</option>)}</select></label></details>}
     {(platforms.find(item=>item.id===platformId)?.active===false||sources.find(item=>item.id===sourceId)?.active===false)&&<p className="error">Este origen o cuenta está archivado. Conservamos su nombre; reactívalo desde Configuración antes de una nueva carga.</p>}
     {sourceId&&<label className="field">Usar una configuración guardada (opcional)<select disabled={!!batch} value={profileId} onChange={event=>selectProfile(event.target.value)}><option value="">Configurar este archivo desde cero</option>{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>}
     <section className={styles.importProposal} aria-label="Archivo privado"><h3>Archivo Excel</h3>
      {batch?.fileHash?<><p><strong>{batch.filename}</strong> · Guardado en el servidor.</p><p>El original no se puede sustituir. Para otros datos, inicia una nueva importación.</p></>:<><label className="field">{file?'Cambiar archivo':'Seleccionar archivo Excel'}<input type="file" aria-label="Archivo Excel" accept=".xlsx,.xls,.xlsb,.xlsm" onChange={chooseFile} required={!file}/></label><p>.xlsx, .xls, .xlsb o .xlsm · máximo 10 MiB</p>{file&&<p><strong>{file.name}</strong> · {(file.size/1024/1024).toLocaleString('es-CO',{maximumFractionDigits:2})} MiB · listo para guardar</p>}</>}
      <details><summary>Requisitos del archivo</summary><p>Hasta 50 hojas, 200 columnas y 10.000 filas por hoja; 50.000 filas seleccionadas por libro. No ejecutamos fórmulas, macros ni enlaces externos. Usar valores guardados de fórmulas requiere tu confirmación; una fórmula sin valor guardado debe corregirse.</p></details>
     </section>
    </fieldset>
    <div className={`admin-actions ${styles.importActions}`}>
     {batch?.fileHash?<button type="button" className="button primary" onClick={()=>goToStep(2)}>Continuar a hojas y columnas</button>:<button className="button primary" aria-describedby={fileHelpId} disabled={!!busy||!sourceId||!file||platforms.find(item=>item.id===platformId)?.active===false||sources.find(item=>item.id===sourceId)?.active===false}>{busy==='upload'?'Guardando archivo…':'Guardar archivo y continuar'}</button>}
     <button type="button" className="button subtle" disabled={!!busy} onClick={returnToHistory}>Volver a importaciones</button>
     <p id={fileHelpId}>{busy==='upload'?`Guardando ${file?.name||'el archivo'}; espera la respuesta del servidor.`:!sourceId?'Elige un origen y su cuenta para continuar.':!file&&!batch?.fileHash?'Selecciona un archivo para continuar.':'Todavía no incorpora pedidos ni gastos.'}</p>
    </div>
   </form>
   <button type="button" className="button subtle" disabled={!!busy} onClick={()=>download('template')}>Descargar plantilla</button>
   {!batch&&!ownFiles&&<details><summary>Crear origen de una plataforma</summary><form onSubmit={addPlatform}><label className="field">Nombre de la plataforma<input required maxLength={150} value={platformName} onChange={event=>setPlatformName(event.target.value)}/></label><button className="button subtle" disabled={!!busy}>Crear plataforma y cuenta Principal</button></form></details>}
   {!batch&&platformId&&advancedSource&&<form onSubmit={addSource}><label className="field">Nombre de la otra cuenta<input required maxLength={150} value={sourceName} onChange={event=>setSourceName(event.target.value)}/></label><button className="button subtle" disabled={!!busy}>Crear cuenta independiente</button></form>}
  </>}
  {batch&&[2,3].includes(step)&&savedProductLinks.length>0&&<details aria-label="Vínculos de productos guardados"><summary>Vínculos guardados · {savedProductLinks.length}</summary><p>Persisten aunque salgas o recargues. Guardar un vínculo no crea otro producto ni aplica la operación; genera una revisión actualizada al terminar.</p>{savedProductLinks.map(link=><article className={styles.importProposal} key={resolutionIdentity(link)}><p><strong>{link.externalKey}</strong> → {productRecords.find(item=>item.id===link.internalId)?.title||'Referencia guardada'}</p>{link.sheet&&<p>{link.sheet}{link.rowNumber?` · fila ${link.rowNumber}`:''}</p>}<button type="button" className="button subtle" disabled={!!busy||!canEditDraft} onClick={()=>openResolver('link_product',{...link,allRows:!link.entityKey&&!link.sheet&&!link.rowNumber})}>Cambiar vínculo de {link.externalKey}</button></article>)}</details>}
  {batch&&[2,3].includes(step)&&batch.pendingProductLinks?.length>0&&<section aria-label="Productos por vincular"><h4>Vincula cada referencia una sola vez</h4><p>{hasPreview?'Puedes guardar los vínculos uno tras otro.':'Pendientes de la última revisión: puedes seguir vinculando y revisar todos los cambios al terminar. Esta lista no permite importar sin una revisión actualizada.'}</p>{batch.pendingProductLinks.map(({externalKey,count,giftOnly})=><article key={externalKey} className={styles.importProposal}><strong>{externalKey}</strong><p>{count} operaciones usan esta referencia.{giftOnly?' Esta referencia corresponde a un obsequio con componentes.':''} El vínculo corresponde a este origen, no al nombre o teléfono de sus clientes.</p><button type="button" className="button subtle" disabled={!!busy||!canEditDraft||previewing} onClick={()=>openResolver('link_product',{externalKey,giftOnly,allRows:true})}>Vincular o crear {externalKey}</button></article>)}</section>}
  {batch&&step===2&&<>
   {!workbook?<p role="status">{diagnostic?'No se pudo completar la lectura de las hojas. Consulta el diagnóstico de este lote; el original guardado sigue disponible.':'El servidor está leyendo las hojas. Puedes salir y retomar este lote después.'}</p>:<>
    {sourceId&&<label className="field">Usar una configuración guardada (opcional)<select disabled={!!busy||!canEditDraft} value={profileId} onChange={event=>selectProfile(event.target.value)}><option value="">Configurar este archivo desde cero</option>{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>}
    <ImportSheetCards sheets={sheets} inspections={workbook.inspections||(workbook.sheetName?[workbook]:[])} config={workbookConfig} suggestions={workbook.suggestions} preview={batch.preview} activeSheet={activeSheet} disabled={!!busy||!canEditDraft} onChoose={selectSheet} onProposal={useSheetProposal} onExclude={excludeSheet} onEnable={includeSheet} onApplySimilar={applySimilarSheets} onApplyPreset={applyWorkbookProposal} onExcludeMissing={excludeMissingSheets}/>
    <fieldset disabled={!!busy||!canEditDraft||previewing} className={styles.importGroup}><legend>Corte de este archivo, no del perfil anterior</legend><label className="field">Este archivo está actualizado hasta…<input type="date" value={fileCutoff} onChange={event=>setFileCutoff(event.target.value)}/></label><p>Confirma una sola vez las hojas elegidas sin columna de corte. No reemplaza fechas mapeadas, ni se copia la fecha de otro mes.</p><button type="button" className="button subtle" onClick={confirmFileCutoff}>Confirmar corte para hojas elegidas</button><button type="button" className="button subtle" onClick={confirmStatusProposals}>Revisar equivalencias de estados propuestas</button></fieldset>
    <button type="button" className="button subtle" disabled={!!busy||!canEditDraft||previewing} onClick={ignorePendingSheets}>Revisar columnas pendientes de las hojas elegidas</button>
    <button type="button" className="button subtle" disabled={!!busy} onClick={focusNextSheet}>Siguiente hoja pendiente</button>
    <form onSubmit={event=>{event.preventDefault();if(pendingSheetDecisions)focusNextSheet();else if(pendingSheetColumns)focusPendingColumns();else void saveAndPreview();}} data-import-sheet-form>
     <label className="field">Hoja actual<select value={activeSheet} onChange={event=>selectSheet(event.target.value)}><option value="">Selecciona una hoja del catálogo</option>{sheets.map(sheet=><option key={sheet.name} value={sheet.name}>{sheet.name}</option>)}</select></label>
     {activeSheet&&<h3 data-import-config="editor" tabIndex={-1}>{activeSheet}</h3>}
     {activeSheet&&!workbookConfig.sheets.some(sheet=>sheet.sheetName===activeSheet)&&<section className={styles.importProposal}><p>Visitar esta hoja no la incluye. Consulta sus muestras en el catálogo y decide.</p><button type="button" className="button subtle" disabled={!!busy||!canEditDraft} onClick={()=>includeSheet(activeSheet)}>Incluir esta hoja</button><button type="button" className="button subtle" disabled={!!busy||!canEditDraft} onClick={()=>excludeSheet(activeSheet)}>No importar esta hoja</button></section>}
     {activeSheet&&workbookConfig.sheets.some(sheet=>sheet.sheetName===activeSheet&&!sheet.enabled)&&<p>Hoja excluida. Su configuración se conserva; puedes volver a incluirla desde el catálogo.</p>}
     <fieldset disabled={!!busy||!canEditDraft} className={`field ${styles.importGroup}`}>
      <legend>Contenido y estructura</legend>
      {activeSheet&&workbookConfig.sheets.some(sheet=>sheet.sheetName===activeSheet&&sheet.enabled)&&<><div className="form-grid">
      {select('purpose','Qué contiene esta hoja',[['orders','Pedidos y sus envíos'],['tracking','Solo seguimiento (no exige productos)'],['settlements','Liquidaciones declaradas (no ingresa dinero a caja)'],['expenses','Gastos de publicidad u operación'],['allocations','Información que acompaña: reparto entre envíos'],['component_costs','Información que acompaña: costos de componentes'],['observations','Información que acompaña: datos informativos']])}
      {['orders','tracking','settlements'].includes(config.purpose)&&<p className="small muted">Usa Solo seguimiento únicamente si esa es la intención del archivo. Un pedido nuevo necesita datos comerciales completos; no se rebajará a seguimiento ni se inventarán productos.</p>}
      {config.purpose==='expenses'?select('layout','Distribución de los gastos',[['expense_rows','Una fila por gasto'],['expense_columns','Cantidad × costo unitario por campaña']]):['orders','tracking','settlements'].includes(config.purpose)?select('layout','Distribución de productos',[['item_rows','Una fila por producto; agrupar por ID de pedido'],['order_rows','Una fila por pedido; varios grupos de columnas']]):<p>Estas relaciones acompañan a pedidos, envíos y gastos identificados; no crean registros por sí solas.</p>}
      </div>
      <details><summary>Encabezado y muestras de esta hoja</summary><label className="field">Fila de encabezados<input type="number" min={1} max={10000} required value={config.headerRow} onChange={event=>updateConfig('headerRow',Number(event.target.value))}/></label>{samplesCurrent?<dl>{headers.map((cell,index)=><div key={index}><dt>Columna {index+1}</dt><dd>{cellText(cell)||'(sin encabezado)'}</dd></div>)}</dl>:<p>Lee las muestras del encabezado elegido antes de asignar columnas.</p>}</details>
      {!samplesCurrent&&<p role="status">La hoja o el encabezado cambió. Lee sus muestras antes de asignar columnas.</p>}
      <button data-import-config="samples" type="button" className="button subtle" disabled={!!busy||!canEditDraft||samplesCurrent} onClick={()=>perform('samples',async()=>{await saveDraft();setNotice('Lectura de muestras solicitada al servidor.');})}>Leer muestras de esta hoja y encabezado</button>
      <details open={readingOpen} onToggle={event=>setReadingOpen(event.currentTarget.open)}><summary>Cómo leer fechas y números · {config.dateFormat} · decimal «{config.decimalSeparator}» · miles «{config.groupSeparator||'sin separador'}» · corte {cutoffDate(config.reportAsOf)||'sin confirmar'}</summary><div className="form-grid" data-import-config="cutoff" tabIndex={-1}>
      {select('dateFormat','Orden explícito de las fechas',[['DMY','Día / mes / año'],['MDY','Mes / día / año'],['ISO','Año-mes-día (ISO)']])}
      {select('decimalSeparator','Separador decimal',[ [',','Coma (1234,50)'],['.','Punto (1234.50)'] ])}
      {select('groupSeparator','Separador de miles',[['.','Punto'],[',','Coma'],[' ','Espacio'],['','Sin separador']])}
      <label className="field">Fecha de corte del reporte, si no existe columna<input type="date" value={cutoffDate(config.reportAsOf)} onChange={event=>updateConfig('reportAsOf',event.target.value)}/><small className="muted">Corte al final de este día en Bogotá. Obligatorio para observar estados o costos sin fecha propia; no se usa la fecha de subida.</small></label>
      </div></details>
     {config.purpose==='orders'&&<label className="checkbox-field"><input type="checkbox" checked={!!config.oneOrderPerGuide} onChange={event=>updateConfig('oneOrderPerGuide',event.target.checked)}/><span>Cada guía corresponde a un pedido: usar la guía como identidad solo con datos comerciales completos.</span></label>}
     {(config.purpose==='expenses'||config.purpose==='orders'&&config.layout==='order_rows')&&<label className="checkbox-field"><input type="checkbox" checked={config.identityMode==='generated'} onChange={event=>updateConfig('identityMode',event.target.checked?'generated':'provided')}/><span>{config.purpose==='orders'?'Confirmo que cada fila representa un pedido y un envío. Generar identidades técnicas si no hay IDs; la guía real permanece vacía.':'Generar identidad técnica para cada gasto sin ID. Conservaré estos IDs en el archivo preparado para las próximas cargas.'}</span></label>}
     <div ref={mappingRootRef} data-import-config="columns" tabIndex={-1}><ImportColumnMapping config={config} headers={headers} sampleRows={sampleRows} columnCount={sampleColumns} disabled={!!busy||!canEditDraft} onChangeColumn={changeColumn} onIgnoreUnassigned={columns=>ignorePendingSheets([{sheetName:activeSheet,columns}])} onNextSheet={focusNextSheet} onInteractionStateChange={reportMappingInteraction}/></div>
     {['orders','tracking','settlements'].includes(config.purpose)&&<StatusMapping config={config} headers={headers} sampleRows={sampleRows} disabled={!!busy||!canEditDraft||previewing||batch.fileExpired} onChange={value=>updateConfig('statusMap',value)} statusDraft={statusDraft} setStatusDraft={setStatusDraft}/>}
     <div data-import-config="defaults" tabIndex={-1}><SheetFixedValues config={config} onChange={value=>updateConfig('defaults',value)}/></div>
     {config.purpose==='expenses'&&config.layout==='expense_columns'&&<fieldset className="order-line"><legend>Nombres de las campañas</legend><p>Cantidad y unitario comparten grupo; cada campaña debe tener un nombre distinto.</p>{[...new Set(config.columns.filter(column=>FIELD_DEFINITIONS.get(column.destination)?.scope==='expense_line').map(column=>column.group||0))].sort((a,b)=>a-b).map(group=><label className="field" key={group}>Grupo de campaña {group+1}<input required maxLength={200} value={config.expenseGroupNames?.[group]||''} onChange={event=>updateConfig('expenseGroupNames',{...config.expenseGroupNames,[group]:event.target.value})}/></label>)}</fieldset>}
     {config.purpose==='expenses'&&<ExpenseCategoryMapping config={config} sampleRows={sampleRows} onChange={value=>updateConfig('expenseCategoryMap',value)}/>}
     </>}
     </fieldset><div className={`admin-actions ${styles.importActions}`}><button className="button primary" disabled={!!busy||!canEditDraft}>{busy==='preview'?'Solicitando revisión…':previewing?'Preparando revisión…':pendingSheetDecisions?'Completar hojas pendientes':pendingSheetColumns?'Resolver columnas pendientes':'Guardar columnas y revisar'}</button><button type="button" className="button subtle" disabled={!!busy} onClick={()=>goToStep(1)}>Atrás</button><button type="button" className="button subtle" disabled={!!busy||!canEditDraft} onClick={()=>perform('save',async()=>{await saveDraft();setNotice('Configuración guardada; falta revisar.');})}>Guardar borrador</button><button type="button" className="button subtle" disabled={!!busy} onClick={returnToHistory}>Volver a importaciones</button>{hasPreview&&!previewing&&<button type="button" className="button subtle" onClick={()=>goToStep(3)}>Volver a la revisión</button>}</div>
    </form>
   </>}
  </>}
  {batch&&step===3&&<>
   <p>El inventario se revisa por producto. Sin existencias físicas registradas se permiten pedidos y guías, y el saldo sigue desconocido: no se descuenta un saldo supuesto. Con existencias positivas se controlan reservas y salidas. Un saldo físico de cero bloquea una venta nueva hasta actualizar el conteo real. No se inventan cobros, pagos ni fechas de entrega.</p>
   {!hasPreview?<p role="status">{previewing?'El servidor está generando una revisión nueva; espera para confirmar.':'Los cambios guardados necesitan una revisión nueva. Lo ya incorporado se conserva; esta revisión solo prepara lo pendiente.'}</p>:<>
    <h3>Qué falta por resolver</h3><p>Una operación es un pedido con sus envíos, o una fila completa de gastos. Se aplica completa, nunca a medias.</p>
    <dl className={`form-grid ${styles.summaryMetrics}`}><div><dt>Listas</dt><dd>{validCount}</dd></div><div><dt>Por corregir</dt><dd>{invalidCount}</dd></div><div><dt>Ya incorporadas</dt><dd>{Number(summary.applied||0)}</dd></div><div><dt>Excluidas</dt><dd>{Number(summary.skipped||0)}</dd></div></dl>
    {workbookConfig.sheets.some(sheet=>sheet.enabled&&sheet.purpose==='orders')&&<InventoryOpeningControls date={openingDate} opening={inventoryOpening} disabled={!!busy||!canEditDraft} onDate={date=>{setOpeningDate(date);setInventoryOpening(null);}} onConfirm={confirmed=>{setInventoryOpening(confirmed?{on:openingDate,confirmed:true}:null);setIncludeValidOnly(false);}}/>}
    <section aria-label="Problemas por resolver"><h4>Bloqueos de esta revisión</h4><div className="admin-actions"><button type="button" className="button subtle" aria-pressed={pendingOnly&&!issueFilter} onClick={()=>changeReviewFilter('',true)}>Pendientes · {invalidCount}</button><button type="button" className="button subtle" aria-pressed={!pendingOnly&&!issueFilter} onClick={()=>changeReviewFilter('')}>Todas las operaciones</button>{Array.from(issueCounts,([code,count])=><button key={code} type="button" className="button subtle" aria-pressed={issueFilter===code} onClick={()=>changeReviewFilter(code)}>{problemLabel(code)} · {count}</button>)}</div>{!invalidCount&&<p>No hay bloqueos. Los avisos y tareas informativas no impiden confirmar.</p>}</section>
    <div className="admin-actions"><button type="button" className="button subtle" disabled={!!busy||!canEditDraft} onClick={()=>setSelectedGroups(old=>[...new Set([...old,...shownGroups.filter(group=>!['applied','skipped'].includes(group.state)).map(groupKey)])])}>Seleccionar las {shownGroups.filter(group=>!['applied','skipped'].includes(group.state)).length} visibles</button><button type="button" className="button subtle" disabled={!!busy||!canEditDraft||!filteredGroups.length} onClick={()=>setSelectedGroups(filteredGroups.filter(group=>!['applied','skipped'].includes(group.state)).map(groupKey))}>Seleccionar todas las {filteredGroups.filter(group=>!['applied','skipped'].includes(group.state)).length} filtradas</button></div>
    {!!selectedGroups.length&&<section aria-label="Acciones para seleccionadas"><h4>Acciones para {selectedGroups.length} seleccionadas</h4><div className="admin-actions"><button type="button" className="button subtle" onClick={()=>setSelectedGroups([])}>Limpiar selección</button><button type="button" className="button subtle" disabled={!!busy||!canEditDraft||selectedOperations.some(group=>group.kind==='expenses')} onClick={()=>openResolver('review_policy',{allRows:true,bulkKeys:[...selectedGroups]})}>Aplicar regla histórica a seleccionados</button><button type="button" className="button subtle" disabled={!!busy||!newIdentityRows.length} onClick={()=>openResolver('independent_record',{allRows:true,bulkRows:[...newIdentityRows]})}>Confirmar como nuevas {newIdentityRows.length} filas seleccionadas</button><button type="button" className="button subtle" disabled={!!busy||!openingObservations.length} onClick={()=>openResolver('opening_observation',{allRows:true,bulkObservations:[...openingObservations]})}>Clasificar {openingObservations.length} hechos ambiguos seleccionados</button><button type="button" className="button subtle" disabled={!!busy||!yearDates.length} onClick={keepSelectedOriginalDates}>Conservar fechas originales de seleccionadas ({yearDates.length})</button></div><p>La selección se conserva entre páginas de este filtro; cambiar de filtro o revisión la limpia.</p></section>}
    {workbook?.warnings?.length>0&&<details><summary>Advertencias del archivo</summary><ul>{messages(workbook.warnings).map((message,index)=><li key={index}>{message}</li>)}</ul></details>}
    {batch.preview?.warnings?.length>0&&<section aria-label="Avisos de la revisión"><h4>Avisos, no bloqueos</h4><ul>{messages(batch.preview.warnings).map((message,index)=><li key={index}>{message}</li>)}</ul></section>}
    {!groups.length&&<p>{settlementsPending>0?`Los pedidos ya están aplicados; quedan ${settlementsPending} liquidaciones para esta revisión.`:hasPreview?'La revisión no contiene grupos importables. Revisa la hoja y sus columnas.':'Todavía no hay una revisión. Configura las columnas y solicita revisarla.'}</p>}
    <div>{shownGroups.map((group,index)=><article data-import-operation tabIndex={-1} className="order-line" key={groupKey(group)||index}><h4>{group.label || groupCaption(group)}</h4><p><strong>{RESULT_LABELS[group.state]||group.state||'Por revisar'}</strong>{group.orderNumber?` · AN-${group.orderNumber}`:''}{group.tracking?` · Guía ${group.tracking}`:''}</p>{group.rowRefs?.length>0&&<p className="small muted">Ubicación: {group.rowRefs.map(ref=>`${ref.sheet} · fila ${ref.rowNumber}`).join('; ')}</p>}{messages(group.errors).map((message,i)=><p className="error" key={i}>{message}</p>)}{messages(group.warnings).map((message,i)=><p key={i}>Aviso: {message}</p>)}{group.reason&&<p>{group.reason}</p>}
     {!['applied','skipped'].includes(group.state)&&<label className="checkbox-field"><input type="checkbox" aria-label={`Seleccionar operación ${groupKey(group)}`} disabled={!!busy||!canEditDraft} checked={selectedGroups.includes(groupKey(group))} onChange={event=>setSelectedGroups(old=>event.target.checked?[...new Set([...old,groupKey(group)])]:old.filter(key=>key!==groupKey(group)))}/><span>Seleccionar operación; los datos personales y costos no se rellenan en masa.</span></label>}
     {canEditDraft&&!['applied','skipped'].includes(group.state)&&<GroupIssueActions group={group} disabled={!!busy} onResolve={openResolver} onConfigureSheet={configureSheet} onInspectRows={inspectRows} onEditProduct={editInventoryProduct} onKeepDate={issue=>{addResolution({action:'cell_value',sheet:issue.sheet,rowNumber:issue.rowNumber,columnIndex:issue.columnIndex,value:issue.originalValue,reason:'Conservar la fecha original del archivo tras revisar el año discrepante'});setNotice('Fecha original confirmada. Guarda y revisa de nuevo.');}}/>}
     {group.tasks?.length>0&&<ul aria-label="Tareas informativas">{messages(group.tasks).map((task,i)=><li key={i}>{task}</li>)}</ul>}
     <details data-import-operation-effects><summary>Ver datos y efectos de esta operación</summary>
     {group.lines?.length>0&&<ul>{group.lines.map((item,i)=><li key={i}>{item.productExternalKey||item.title||item.itemId||'Producto por resolver'} · cantidad {item.quantity} · {item.unitPriceMinor==null?'Precio sin resolver':`${(item.unitPriceMinor/100).toLocaleString('es-CO')} COP`}{item.discountMinor?` · descuento ${(item.discountMinor/100).toLocaleString('es-CO')} COP`:''}</li>)}</ul>}
     {(group.units||[]).map(unit=><section key={unit.key} aria-label="Datos preparados del pedido y sus envíos"><ReviewOrderValues values={unit.values}/>{(unit.shipments||[]).map((shipment,index)=><ReviewShipment key={shipment.existingId||shipment.values?.externalShipmentId||shipment.values?.tracking||`${unit.key}:${index}`} shipment={shipment}/>)}</section>)}
     {(group.units||[]).map(unit=><section key={`costs:${unit.key}`}><h5>Costos históricos del pedido</h5>{unit.lineCosts?.length?<ul>{unit.lineCosts.map(cost=><li key={cost.lineId}>{group.lines?.find(line=>line.lineId===cost.lineId)?.title||cost.lineId} · {cost.unitCostMinor==null?'Costo compuesto por completar':formatMoneyMinor(cost.unitCostMinor)}{cost.components?.length?` · ${cost.components.length} componentes`:''}</li>)}</ul>:<p>Sin costo histórico explícito en el archivo; revisa la cobertura del pedido, no se convierte un desconocido en cero.</p>}<p className="small muted">Estos costos pertenecen a la venta histórica. No cambian el costo vigente del catálogo.</p>{!!unit.importedFields?.length&&<details><summary>Datos informativos del pedido y procedencia</summary><ImportedData record={{importedFields:unit.importedFields}}/></details>}</section>)}
     <ReviewExpenses group={group}/>
     {(group.orderId||group.shipmentIds?.length>0)&&<details><summary>Destino identificado</summary>{group.orderId&&<p>Pedido: {group.orderId}</p>}{group.shipmentIds?.map(id=><p key={id}>Envío: {id}</p>)}</details>}
     </details>
     {canEditDraft&&!['applied','skipped'].includes(group.state)&&<details data-import-other-options><summary>Otras opciones de corrección</summary><p className="small muted">Los vínculos se guardan para este origen. Las demás correcciones se preparan hasta guardar y revisar.</p><ResolutionActions actions={GROUP_RESOLUTIONS.filter(action=>group.kind==='expenses'?!['link_product','link_person','link_order','link_shipment','line_costs','commercial_update','additional_quantity','status','review_policy'].includes(action):action!=='link_expense')} disabled={!!busy} onResolve={action=>openResolver(action,{entityKey:groupKey(group),rowRefs:group.rowRefs,externalKey:group.externalKey||''})}/></details>}
    </article>)}</div>
    {filteredGroups.length>20&&<div className="admin-actions"><button type="button" className="button subtle" disabled={groupPage<=1} onClick={()=>setGroupPage(value=>value-1)}>Grupos anteriores</button><span>Grupos · página {groupPage} de {groupPages}</span><button type="button" className="button subtle" disabled={groupPage>=groupPages} onClick={()=>setGroupPage(value=>value+1)}>Más grupos</button></div>}
    {resolutions.length>0&&<details><summary>Resoluciones preparadas ({resolutions.length}){dirty?' · pendientes de validar':''}</summary><ul>{resolutions.map((resolution,index)=><li key={index}>{RESOLUTION_LABELS[resolution.action]||resolution.action} · {resolution.externalKey||resolution.entityKey||'Todo el lote'}{resolution.rowNumber?` · fila ${resolution.rowNumber}`:''}{resolution.reason?` · ${resolution.reason}`:''}</li>)}</ul></details>}
    <ImportReviewEffects preview={batch.preview} opening={batch.inventoryOpening} disabled={!!busy||!canEditDraft} onEditProduct={editInventoryProduct}/>
    <details><summary>Otras opciones de corrección del archivo</summary><ResolutionActions actions={FILE_RESOLUTIONS} disabled={!!busy||!canEditDraft} onResolve={()=>openResolver('accept_formulas')}/></details>
   </>}
   <div className={`admin-actions ${styles.importActions}`}><button type="button" className="button primary" disabled={!!busy||previewing||!canEditDraft||!hasImportable&&hasPreview&&!dirty&&!invalidCount} onClick={dirty||!hasPreview?saveAndPreview:invalidCount?resolveFirstPending:()=>goToStep(4)}>{dirty||!hasPreview?'Guardar cambios y revisar':invalidCount?'Resolver primer pendiente':'Continuar a confirmación'}</button>{hasPreview&&invalidCount>0&&hasImportable&&!dirty&&<button type="button" className="button subtle" onClick={()=>goToStep(4)}>Revisar importación parcial</button>}<button type="button" className="button subtle" disabled={!!busy} onClick={()=>goToStep(2)}>Atrás</button><button type="button" className="button subtle" disabled={!!busy||!canEditDraft} onClick={()=>perform('save',()=>saveDraft())}>Guardar borrador</button><button type="button" className="button subtle" disabled={!!busy} onClick={returnToHistory}>Volver a importaciones</button></div>
  </>}
  {batch&&step===4&&<>
   <h3 ref={showResult?stepHeadingRef:undefined} tabIndex={-1}>{showResult?'Resultado y progreso':'Confirmar importación'}</h3>
   {!showResult&&<section aria-label="Resumen antes de importar"><h4>{batch.filename}</h4><p>{platforms.find(item=>item.id===platformId)?.name||'Origen no disponible'} · {sources.find(item=>item.id===sourceId)?.name||'Cuenta no disponible'}</p><p>Hojas incluidas: {workbookConfig.sheets.filter(sheet=>sheet.enabled).map(sheet=>sheet.sheetName).join(' · ')||'Ninguna'}</p><p>Hojas excluidas: {workbookConfig.sheets.filter(sheet=>!sheet.enabled).map(sheet=>sheet.sheetName).join(' · ')||'Ninguna'}</p><dl className={`form-grid ${styles.summaryMetrics}`}>{['new','updated','unchanged'].map(key=><div key={key}><dt>{key==='new'?'Operaciones nuevas':key==='updated'?'Por actualizar':'Sin cambios'}</dt><dd>{Number(summary[key]||0)}</dd></div>)}</dl><p><strong>Se aplican operaciones completas por separado.</strong> Cancelar después no revierte las ya confirmadas. No se confirma dinero recibido ni pagado.</p>{settlementsPending>0&&<p>{settlementsPending} liquidaciones pendientes de esta revisión; la recepción de dinero se confirma por separado en Caja.</p>}</section>}
   {!showResult&&batch.preview?.sheets&&<section aria-label="Selección final por hoja"><h4>Hojas que se aplicarán</h4><p>Una operación puede aparecer en ventas y seguimiento; no se suman dos ventas por estar en dos hojas.</p><div className={styles.resultsTable} role="region" aria-label="Revisión por hoja" tabIndex={0}><table><caption>Revisión por hoja; no son totales deduplicados del libro</caption><thead><tr><th scope="col">Hoja</th><th scope="col">Válidas</th><th scope="col">Pendientes</th><th scope="col">Omitidas</th></tr></thead><tbody>{batch.preview.sheets.filter(sheet=>sheet.enabled).map(sheet=><tr key={sheet.sheetName}><th scope="row">{sheet.sheetName}</th><td>{sheet.groups.filter(group=>['new','updated','unchanged','valid'].includes(group.state)).length}</td><td>{sheet.groups.filter(group=>['rejected','conflict','invalid'].includes(group.state)).length}</td><td>{sheet.groups.filter(group=>['skipped','omitted','applied'].includes(group.state)).length}</td></tr>)}</tbody></table></div></section>}
   {workLocked&&<section aria-label="Progreso guardado"><p role="status">{STATE_LABELS[batch.state]}. Puedes cerrar el panel; el trabajo sigue guardado en el servidor.</p><progress aria-label="Operaciones procesadas" {...(Number(batch.progress?.total)>0?{max:Number(batch.progress.total),value:Number(batch.progress.processed??batch.progress.applied)||0}:{})} style={{width:'100%'}}/><p>{batch.progress?.phase==='settlements'?'Vinculando liquidaciones':'Aplicando operaciones completas'} · {Number(batch.progress?.processed??batch.progress?.applied)||0}{Number(batch.progress?.total)>0?` de ${batch.progress.total}`:' · total aún no informado'}</p></section>}
   {cancelled?<div role="status">
    <p><strong>Importación cancelada. Archivo descartado de este lote.</strong></p>
    <p>{cancellation?Number(cancellation.appliedGroups)+Number(cancellation.appliedSettlements)>0?`Grupos confirmados: ${cancellation.appliedGroups}. Liquidaciones confirmadas: ${cancellation.appliedSettlements}. Se conservan sus pedidos, inventario y cobros; cancelar no los revierte.`:'No se aplicaron operaciones de importación.':'Los hechos ya confirmados se conservan; cancelar no los revierte.'}</p>
    {batch.acceptedRevision&&cancellation&&<p>Pendientes detenidos — grupos: {cancellation.remainingGroups}; liquidaciones: {cancellation.remainingSettlements}.</p>}
    <p>Este lote no se reanudará; para otro archivo, crea un lote nuevo.</p>
   </div>:batch.state==='completed_with_errors'?<section className={styles.importResult} data-result="partial" role="status"><h4>Importación parcial: quedan pendientes</h4><p>Se incorporaron las operaciones válidas. Las demás no se incorporaron a medias; revisa los pendientes antes de una nueva confirmación.</p></section>:batch.state==='completed'?<section className={styles.importResult} data-result="complete" role="status"><h4>Importación completada</h4><p>El progreso muestra lo aplicado en esta aceptación. Los hechos incorporados se conservan.</p></section>:fileUnavailable?<section className={styles.importResult} role="status"><h4>Archivo no disponible</h4><p>{batch.fileDiscarded?'El original fue descartado.':'Venció la retención del original.'} La historia aplicada se conserva; no se garantiza conservar todas las filas fuente. Para continuar necesitas una nueva importación explícita.</p><button type="button" className="button subtle" onClick={startNewBatch}>Nueva importación</button></section>:null}
   {showResult&&hasAppliedProgress&&<dl className={`form-grid ${styles.summaryMetrics}`} aria-label="Hechos de esta aceptación">{summaryItems(batch.progress||batch.result||{}).map(([key,value])=><div key={key}><dt>{RESULT_LABELS[key]}</dt><dd>{value}</dd></div>)}</dl>}
   {batch.preview&&(showResult?<details><summary>{hasAppliedProgress?'Proyección anterior de la revisión aceptada; no es el resultado aplicado':'Última revisión guardada; no es una aceptación nueva ni un resultado aplicado'}</summary>{fileUnavailable&&!hasAppliedProgress&&<p>El original ya no está disponible. Esta revisión conservada no puede confirmarse ni volver a generarse en esta importación.</p>}<ImportReviewEffects preview={batch.preview} opening={batch.inventoryOpening} accepted={hasAppliedProgress} disabled/></details>:<ImportReviewEffects preview={batch.preview} opening={batch.inventoryOpening} disabled/>)}
   {!!batch.progress?.sheets?.length&&showResult&&hasAppliedProgress&&<section aria-label="Resultado por hoja y tipo"><h4>Operaciones completas por hoja</h4><p>No sumes estas cifras como total del libro: una operación puede aparecer en varias hojas. Registros asociados: {batch.progress.orderIds?.length||0} pedidos · {batch.progress.shipmentIds?.length||0} envíos · {batch.progress.expenseIds?.length||0} gastos, incluidos los que ya existían sin cambios.</p><div className={styles.resultsTable} role="region" aria-label="Resultados por hoja" tabIndex={0}><table><caption>Hechos aplicados de esta aceptación por hoja y tipo</caption><thead><tr>{['Hoja','Tipo de operación','Nuevas','Actualizadas','Sin cambios','Omitidas','Pendientes'].map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{batch.progress.sheets.flatMap(sheet=>['commercial','expenses'].map(type=><tr key={`${sheet.sheetName}:${type}`}><th scope="row">{sheet.sheetName}</th><td>{type==='expenses'?'Filas completas de gastos':'Operaciones comerciales'}</td>{['created','updated','unchanged','omitted','pending'].map(state=><td key={state}>{sheet[type]?.[state]||0}</td>)}</tr>))}</tbody></table></div></section>}
   {FINAL_STATES.has(batch.state)&&hasAppliedProgress&&!cancelled&&<details><summary>Abrir registros asociados a esta importación</summary>{[['orders','Pedidos','orderIds'],['shipments','Envíos','shipmentIds'],['expenses','Gastos','expenseIds']].map(([type,label,key])=>{const ids=batch.progress?.[key]||[];return <section key={type}><h4>{label} · {ids.length}</h4><div className="admin-actions">{ids.slice(0,resultLimits[type]).map(id=><button key={id} type="button" className="button subtle" onClick={()=>type==='expenses'?onNavigate?.({section:'cash',tab:'expenses',record:id}):onViewChange?.({tab:type==='orders'?'list':'shipments',record:id,batch:undefined})}>Abrir {type==='orders'?'pedido':type==='shipments'?'envío':'gasto'} · {id.slice(0,8)}</button>)}{ids.length>resultLimits[type]&&<button type="button" className="button subtle" onClick={()=>setResultLimits(previous=>({...previous,[type]:previous[type]+20}))}>Mostrar más {label.toLocaleLowerCase('es')}</button>}</div></section>;})}</details>}
   {(FINAL_STATES.has(batch.state)||fileUnavailable)&&!cancelled&&<><p>La incorporación no confirma cobros ni pagos. Los costos desconocidos y las excepciones siguen visibles.</p><div className="admin-actions"><button type="button" className="button subtle" onClick={()=>onViewChange?.({tab:'list',batch:undefined,record:undefined})}>Ver pedidos</button><button type="button" className="button subtle" onClick={()=>onViewChange?.({tab:'shipments',batch:undefined,record:undefined})}>Ver envíos</button><button type="button" className="button subtle" onClick={()=>onNavigate?.({section:'cash',tab:'expenses'})}>Ver gastos</button><button type="button" className="button subtle" onClick={()=>onNavigate?.({section:'reports'})}>Ver informes</button></div></>}
   {(batch.state==='failed'&&batch.acceptedRevision||batch.state==='completed_with_errors')&&<section aria-label="Continuar pendientes">{retained?<><p>Generaremos una revisión nueva antes de corregir. No se reutiliza la revisión congelada ni se repiten las operaciones incorporadas.</p><button type="button" className="button primary" disabled={!!busy||previewing} onClick={generateNewPreview}>Revisar pendientes</button></>:<><p>El original ya no está disponible. Descarga los pendientes conservados como evidencia y prepara una nueva importación.</p><button type="button" className="button primary" onClick={startNewBatch}>Nueva importación</button></>}</section>}
   {!showResult&&<>{invalidCount>0&&<section aria-label="Decisión de importación parcial"><h4>{invalidCount} operaciones siguen pendientes</h4><p>Revisa los pendientes por hoja. Ninguna operación se incorpora a medias y las válidas no corrigen las demás.</p><label className="checkbox-field"><input type="checkbox" checked={includeValidOnly} onChange={event=>setIncludeValidOnly(event.target.checked)} disabled={!!busy||dirty||!reviewReady}/><span>Importar {validCount} operaciones válidas y dejar {invalidCount} pendientes</span></label></section>}<p>Se aplicará únicamente la revisión guardada. El archivo, las correcciones y las versiones de destino quedan congelados al confirmar.</p><details><summary>Detalles técnicos de esta revisión</summary><p>Hash de revisión: {batch.preview?.previewHash||'Sin revisión'} · Versión: {batch.version}</p></details><div className={`admin-actions ${styles.importActions}`}><button type="button" className="button primary" aria-describedby={`${fileHelpId}-commit`} disabled={!!busy||!!commitBlockedReason} onClick={commit}>{busy==='commit'?'Aceptando importación…':'Confirmar e importar'}</button><button type="button" className="button subtle" disabled={!!busy} onClick={()=>goToStep(3)}>Atrás</button><button type="button" className="button subtle" disabled={!!busy} onClick={returnToHistory}>Volver a importaciones</button><p id={`${fileHelpId}-commit`}>{busy==='commit'?'Esperando la aceptación del servidor.':commitBlockedReason||'La revisión está actualizada. Confirma solo después de revisar sus efectos.'}</p></div></>}
  </>}
  {batch&&[3,4].includes(step)&&<SourceRows batch={batch} page={page} rowState={rowState} query={rowQuery} location={rowLocation} open={sourceRowsOpen} onToggle={setSourceRowsOpen} busy={!!busy||loading} onClearLocation={()=>{setRowLocation(null);setPage(1);void loadBatch(batch.id,{state:rowState,q:rowQuery});}} onFilter={state=>{setRowLocation(null);setRowState(state);setPage(1);void loadBatch(batch.id,{state,q:rowQuery});}} onSearch={q=>{setRowLocation(null);setRowQuery(q);setPage(1);void loadBatch(batch.id,{state:rowState,q});}} onPage={next=>{setPage(next);void loadBatch(batch.id,{targetPage:next,state:rowState,q:rowQuery,...rowLocation||{}});}} onResolve={step===3&&canEditDraft?(action,row)=>openResolver(action,{entityKey:row.entityKey||row.groupKey,sheet:row.sheet,rowNumber:row.rowNumber,columnIndex:row.columnIndex,original:row.original,externalKey:rowExternalKey(action,row)}):undefined}/>}
  {decision&&<ImportDecisionDialog {...decision} onConfirm={()=>finishDecision(true)} onClose={()=>finishDecision(false)}/>}
  {resolver&&canEditDraft&&<ResolutionDialog title={RESOLUTION_LABELS[resolver.action]} submitLabel={resolver.action==='link_product'?'Guardar vínculo':'Preparar corrección'} busy={!!busy} onClose={closeResolver} onSubmit={applyResolution}>
   {error&&<div className="error" role="alert" tabIndex={-1} ref={errorRef}>{stateChanged&&<h3>El estado cambió; revisa antes de continuar</h3>}<p>{diagnosticText(error)}</p><button type="button" className="button subtle" disabled={!!busy} onClick={stateChanged?reloadSaved:refreshStatus}>{stateChanged?'Recargar lo guardado':'Actualizar estado'}</button></div>}
   <fieldset className="field" disabled={!!busy}>
    {resolver.entityKey&&<p>{groupCaption(groups.find(group=>groupKey(group)===resolver.entityKey)||{})}</p>}
    {(resolver.sheet||resolver.rowNumber||resolver.externalKey)&&<p>Ubicación conocida: {resolver.sheet||'Hoja por elegir'}{resolver.rowNumber?` · fila ${resolver.rowNumber}`:''}{resolver.externalKey?` · Referencia ${resolver.externalKey}`:''}</p>}
    {(resolver.bulkRows||resolver.bulkObservations||resolver.bulkKeys)&&<section><h3>Aplica solo a la selección mostrada</h3><ul>{resolver.bulkRows?.map(ref=><li key={json([ref.sheet,ref.rowNumber])}>{ref.sheet} · fila {ref.rowNumber} · una identidad técnica distinta por fila; no es una corrección ni una copia</li>)}{resolver.bulkObservations?.map(ref=><li key={ref.externalKey}>{ref.sheet} · fila {ref.rowNumber} · {ref.label} · observación {ref.externalKey}</li>)}{resolver.bulkKeys?.map(key=><li key={key}>{groupCaption(groups.find(group=>groupKey(group)===key)||{key})}</li>)}</ul><label className="checkbox-field"><input type="checkbox" required/><span>Revisé todos los elementos de esta selección y confirmo que comparten esta decisión.</span></label></section>}
    {!resolver.bulkRows&&!resolver.bulkObservations&&!resolver.bulkKeys&&<details open={!!error||['cell_value','independent_record','opening_observation','link_expense','duplicate','additional_quantity'].includes(resolver.action)&&(!resolver.sheet||!resolver.rowNumber)||['link_product','link_person','status'].includes(resolver.action)&&!resolver.externalKey}><summary>Cambiar ubicación o identificación</summary><div className="form-grid">{!['cell_value','accept_formulas'].includes(resolver.action)&&<label className="field">Hoja de origen<select value={resolver.sheet||''} onChange={event=>setResolverField('sheet',event.target.value)}><option value="">Elige una hoja si aplica</option>{sheets.map(sheet=><option key={sheet.name} value={sheet.name}>{sheet.name}</option>)}</select></label>}<label className="field">Fila de origen (si aplica)<input type="number" min={1} max={10001} value={resolver.rowNumber||''} onChange={event=>setResolverField('rowNumber',event.target.value)}/></label>{['link_product','link_person','link_order','link_shipment','status'].includes(resolver.action)&&<label className="field">Identificador exacto del archivo<input required={['link_product','link_person','status'].includes(resolver.action)} maxLength={300} value={resolver.externalKey} onChange={event=>setResolverField('externalKey',event.target.value)}/><small className="muted">Respeta mayúsculas y ceros iniciales. Para estado, escribe el texto exacto de la celda.</small></label>}</div></details>}
    {resolver.action.startsWith('link_')&&<>
     <label className="field">Buscar registro real<input value={lookupQuery} maxLength={100} onChange={event=>setLookupQuery(event.target.value)} placeholder={resolver.action==='link_order'?'Número AN o búsqueda del listado':'Nombre o referencia'}/></label>
     {lookupLoading&&<p role="status">Buscando…</p>}
     <label className="field">Registro que se vinculará<select required value={resolver.internalId} onChange={event=>setResolverField('internalId',event.target.value)}><option value="">Selecciona un registro existente</option>{resolver.internalId&&!lookupOptions.some(item=>item.id===resolver.internalId)&&<option value={resolver.internalId} disabled={resolver.giftOnly&&!(selectedProduct?.kind==='products'&&selectedProduct.productType==='gift')}>{selectedProduct?.title||resolver.internalId}{selectedProduct?` · ${catalogType(selectedProduct)}`:''} · Seleccionado</option>}{lookupOptions.map(item=><option key={item.id} value={item.id}>{item.number?`AN-${String(item.number).padStart(6,'0')} · `:''}{item.title||item.name||item.concept||item.tracking||item.id}{resolver.action==='link_product'?` · ${catalogType(item)}`:''}{item.presentation?` · ${item.presentation}`:''}{resolver.action==='link_expense'?` · ${item.incurredOn} · ${item.campaign||''} · ${formatMoneyMinor(item.amountMinor)}`:''}</option>)}</select></label>
     {!lookupLoading&&!lookupOptions.length&&<p>No se encontraron registros. Cambia la búsqueda{resolver.action==='link_product'?' o crea una referencia nueva si aún no existe.':'.'}</p>}
     {resolver.action==='link_product'&&<>
      <p>{resolver.internalId?`Seleccionado: ${selectedProduct?.title||resolver.internalId}. Pulsa «Guardar vínculo» para guardarlo en este lote; no se creará otra referencia.`:'Para usar una referencia existente, selecciónala y pulsa «Guardar vínculo». Crear es una alternativa solo si todavía no existe.'}</p>
      {resolver.giftOnly&&<p>Esta columna contiene un obsequio: vincula o crea un Obsequio, no un producto normal ni un combo.</p>}
      <p>Las nuevas referencias empiezan como borradores privados, habilitados para pedidos pero fuera de la vitrina. Vincular una existente no cambia su publicación.</p>
      <p>Elige el tipo real; no se deduce por el nombre. En combos y obsequios debes seleccionar sus productos y cantidades explícitamente. Sus costos y existencias dependen de esos componentes; un obsequio importado lleva precio de venta cero, no costo cero.</p>
      {onCreateProduct&&<div className="admin-actions"><button type="button" className="button subtle" disabled={!!busy||!resolver.externalKey.trim()||!!resolver.internalId||resolver.giftOnly} onClick={()=>createProduct('products','product')}>Guardar lote y crear producto</button><button type="button" className="button subtle" disabled={!!busy||!resolver.externalKey.trim()||!!resolver.internalId||resolver.giftOnly} onClick={()=>createProduct('combos')}>Guardar lote y crear combo</button><button type="button" className="button subtle" disabled={!!busy||!resolver.externalKey.trim()||!!resolver.internalId} onClick={()=>createProduct('products','gift')}>Guardar lote y crear obsequio</button></div>}
     </>}
    </>}
    {resolver.action==='link_expense'&&workbookConfig.sheets.find(sheet=>sheet.sheetName===resolver.sheet)?.layout==='expense_columns'&&<label className="field">Campaña de esta fila<select required value={resolver.externalKey} onChange={event=>setResolverField('externalKey',event.target.value)}><option value="">Selecciona el subgasto de campaña</option>{Object.values(workbookConfig.sheets.find(sheet=>sheet.sheetName===resolver.sheet).expenseGroupNames||{}).map(name=><option key={normalizedHeader(name)} value={normalizedHeader(name)}>{name}</option>)}</select></label>}
    {resolver.action==='status'&&<label className="field">Estado en All Nutrition<select required value={resolver.value} onChange={event=>setResolverField('value',event.target.value)}><option value="">Selecciona el significado confirmado</option>{shipmentStates.map(({value,label})=><option key={value} value={value}>{label}</option>)}</select><small className="muted">Estado sin identificar conserva la observación sin cambiar las finanzas.</small></label>}
    {resolver.action==='review_policy'&&<><p>Usa una regla histórica explícita. No se toma la fecha de carga ni se cambia la configuración general.</p><label className="field">Versión de regla aprobada<select required value={resolver.value} onChange={event=>setResolverField('value',event.target.value)}><option value="">Selecciona una regla existente</option>{rules.map(rule=><option key={rule.id} value={rule.id}>{rule.effectiveOn} · {rule.saleRecognition} · {rule.id}</option>)}</select></label>{!rules.length&&<p>No hay reglas disponibles. Configura una regla real en Configuración y retoma este lote.</p>}</>}
    {resolver.action==='review_authority'&&<><p>Autorizar una corrección de fuente o importe exige motivo y nueva revisión de consecuencias. No se borran movimientos existentes.</p><label className="field">ID del evento original que se rectifica (si aplica)<input maxLength={100} value={resolver.value.correctionOf||''} onChange={event=>setResolverField('value',event.target.value?{...resolver.value,correctionOf:event.target.value}:Object.fromEntries(Object.entries(resolver.value).filter(([key])=>key!=='correctionOf')))}/></label><label className="checkbox-field"><input type="checkbox" checked={!!resolver.value.allowCredit} onChange={event=>setResolverField('value',event.target.checked?{...resolver.value,allowCredit:true}:Object.fromEntries(Object.entries(resolver.value).filter(([key])=>key!=='allowCredit')))}/><span>Autorizar explícitamente saldo a favor del cliente si el importe confirmado excede su deuda.</span></label></>}
    {resolver.action==='commercial_update'&&<CommercialResolution api={api} value={resolver.value} group={groups.find(group=>groupKey(group)===resolver.entityKey)} onChange={value=>setResolverField('value',value)}/>}
    {resolver.action==='cell_value'&&<><p>Original conservado: <strong style={{whiteSpace:'pre-wrap'}}>{cellText(resolver.original)||'(vacío)'}</strong></p><div className="form-grid"><label className="field">Hoja de la celda<select required value={resolver.sheet} onChange={event=>setResolverField('sheet',event.target.value)}><option value="">Selecciona la hoja</option>{sheets.map(sheet=><option key={sheet.name} value={sheet.name}>{sheet.name}</option>)}</select></label><label className="field">Columna de la celda<input required type="number" min={1} max={200} value={Number(resolver.columnIndex)+1} onChange={event=>setResolverField('columnIndex',Number(event.target.value)-1)}/></label><label className="field">Tipo de valor<select value={resolver.cellType} onChange={event=>{setResolverField('cellType',event.target.value);setResolverField('value','');}}><option value="text">Texto literal</option><option value="number">Número</option><option value="boolean">Verdadero o falso</option><option value="null">Dejar vacío explícitamente</option></select></label></div>{resolver.cellType==='boolean'?<label className="field">Valor corregido<select required value={resolver.value} onChange={event=>setResolverField('value',event.target.value)}><option value="">Selecciona</option><option value="true">Verdadero</option><option value="false">Falso</option></select></label>:resolver.cellType!=='null'&&<label className="field">Valor corregido<textarea maxLength={4000} value={resolver.value} onChange={event=>setResolverField('value',event.target.value)}/></label>}<p>No se ejecutan fórmulas. El original no se modifica; esta corrección exige una revisión nueva.</p></>}
    {resolver.action==='opening_observation'&&<><p>{resolver.bulkObservations?'Confirma la misma relación con el conteo para cada hecho de la lista.':`Hecho concreto: ${resolver.externalKey}.`} La fecha de carga o el corte del reporte no sustituyen esta decisión.</p><label className="field">Relación con el conteo físico<select required value={typeof resolver.value==='boolean'?String(resolver.value):''} onChange={event=>setResolverField('value',event.target.value===''?'':event.target.value==='true')}><option value="">Por confirmar</option><option value="true">Ya estaba reflejado en el conteo</option><option value="false">Ocurrió después del conteo</option></select></label></>}
    {resolver.action==='line_costs'&&<><label className="field">ID externo del pedido<input required value={resolver.externalKey} onChange={event=>setResolverField('externalKey',event.target.value)}/></label><p>Conserva el costo histórico real de cada línea o de sus componentes. No cambia el costo del catálogo, el precio ni la caja.</p><OrderLineCosts items={groups.find(group=>groupKey(group)===resolver.entityKey)?.lines||[]} value={resolver.value.lineCosts||[]} onChange={lineCosts=>setResolverField('value',{lineCosts})} renderAmount={(name,label,amount,onChange)=><Field key={name} field={{name,label,type:'moneyOptionalMinor',required:true}} value={amount} onChange={onChange}/>}/></>}
    {resolver.action==='independent_record'&&<p>Confirmo que esta fila es una operación distinta, aunque coincida con otra. Se guardará una identidad técnica nueva, no un número de pedido ni una guía comercial inventada.</p>}
    {resolver.action==='accept_formulas'&&<><div className="form-grid"><label className="field">Hoja con fórmulas<select required value={resolver.sheet} onChange={event=>{setResolverField('sheet',event.target.value);setResolverField('externalKey','');}}><option value="">Selecciona una hoja</option>{workbookConfig.sheets.filter(sheet=>sheet.enabled).map(sheet=><option key={sheet.sheetName} value={sheet.sheetName}>{sheet.sheetName}</option>)}</select></label><label className="field">Campos cuyos valores guardados acepto<select value={resolver.externalKey} onChange={event=>setResolverField('externalKey',event.target.value)}><option value="">Todos los campos asignados de esta hoja</option>{[...new Set((workbookConfig.sheets.find(sheet=>sheet.sheetName===resolver.sheet)?.columns||[]).map(column=>column.destination).filter(destination=>destination&&destination!=='ignore'))].map(destination=><option key={destination} value={destination}>{FIELD_DEFINITIONS.get(destination)?.label||destination}</option>)}</select></label></div><label className="checkbox-field"><input required type="checkbox" checked={resolver.value===true} onChange={event=>setResolverField('value',event.target.checked)}/><span>He revisado estas fórmulas y acepto sus valores guardados, solo en la hoja y los campos indicados. No se ejecutan ni recalculan; una fórmula usada sin caché válido sigue bloqueada.</span></label></>}
    {['duplicate','additional_quantity'].includes(resolver.action)&&<p>{resolver.action==='duplicate'?'Se excluirá esta repetición de fila; no se descontará un producto distinto.':'Se contará esta fila como unidades adicionales reales; revisa la cantidad agrupada antes de confirmar.'}</p>}
    <label className="field">Motivo de la resolución<input required={['review_policy','review_authority','commercial_update','omit_group','duplicate','independent_record','cell_value','line_costs','opening_observation','link_expense','additional_quantity'].includes(resolver.action)} maxLength={2000} value={resolver.reason} onChange={event=>setResolverField('reason',event.target.value)}/></label>
   </fieldset>
  </ResolutionDialog>}
  {batch?.fileHash&&<section aria-label="Guardar configuración reutilizable"><details><summary>Guardar una configuración para próximas importaciones</summary><form onSubmit={saveProfile}><label className="field">Nombre de la configuración<input required maxLength={150} value={profileName} onChange={event=>setProfileName(event.target.value)}/></label>{profileId&&<p>Se actualizará la configuración seleccionada. Las revisiones aceptadas no se modifican.</p>}<button className="button subtle" disabled={!!busy||workLocked||previewing}>Guardar configuración</button>{profileId&&<button type="button" className="button subtle" disabled={!!busy||workLocked||previewing} onClick={()=>setProfileId('')}>Guardar como configuración nueva</button>}</form></details></section>}
  {batch?.fileHash&&<section aria-label="Archivos y descargas" className={styles.importDownloads}><h3>Archivos y descargas</h3>{downloadItems.map(item=><article key={item.kind}><h4>{item.label}</h4><p>{item.description}</p><p>{item.available?'Disponible':`No disponible · ${item.reason}`}</p><button type="button" className="button subtle" disabled={!!busy||!item.available} onClick={()=>download(item.kind)}>Descargar {item.label.toLocaleLowerCase('es')}</button></article>)}<p className="small muted">Original privado: 7 días si abandonas la importación, 90 días después de finalizar. No convertimos XLS, XLSB ni archivos con macros.</p></section>}
 </section>;
}

function ResolutionDialog({title,submitLabel='Preparar corrección',busy,onClose,onSubmit,children}){
 const dialog=useRef(null),titleId=useId();
 const close=useDialog(dialog,{busy,dirty:true,onClose});
 return <dialog ref={dialog} className={`editor-drawer ${styles.editor}`} aria-labelledby={titleId}>
  <header><h2 id={titleId} tabIndex={-1} data-dialog-initial-focus>{title}</h2><button className="icon-button" type="button" aria-label="Cerrar resolución" disabled={busy} onClick={close}><Icon name="close"/></button></header>
  <form onSubmit={onSubmit} aria-busy={busy}>
   <div className="drawer-body">{children}</div>
   <footer className="editor-footer"><span role="status">{busy?'Procesando…':'Corrección sin guardar'}</span><button className="button subtle" type="button" disabled={busy} onClick={close}>Cancelar corrección</button><button className="button primary" disabled={busy}>{submitLabel}</button></footer>
  </form>
 </dialog>;
}

function ResolutionActions({actions,disabled,onResolve}){
 return <div className={styles.resolutionGroups}>{RESOLUTION_GROUPS.map(group=>{
  const available=group.actions.filter(action=>actions.includes(action));
  return available.length>0&&<fieldset key={group.label} className={styles.resolutionGroup} disabled={disabled}><legend>{group.label}</legend><div className="admin-actions">{available.map(action=><button key={action} className="button subtle" type="button" onClick={()=>onResolve(action)}>{RESOLUTION_LABELS[action]}</button>)}</div></fieldset>;
 })}</div>;
}

function StatusMapping({config,headers,sampleRows,disabled,onChange,statusDraft,setStatusDraft}){
 const column=config.columns.find(column=>column.destination==='rawStatus');
 const samples=column?[...new Set(sampleRows.filter(row=>row.rowNumber>Number(config.headerRow)).slice(0,3).map(row=>cellText(row.cells?.[column.index])).filter(Boolean))]:[];
 return <details><summary>Equivalencias del estado de entrega / seguimiento</summary>
  <p>Solo la columna asignada a «Estado de la entrega / seguimiento» alimenta estas equivalencias. El estado del envío en la plataforma es administrativo e informativo; no tiene un mapeo logístico automático.</p>
  {column?<p>Columna {column.index+1} · {cellText(headers[column.index])||column.header||'Sin encabezado'}. {samples.length?`Valores de muestra, no todos los estados del archivo: ${samples.join(' · ')}`:'Sin valores en las muestras disponibles.'}</p>:<p>No hay columna de seguimiento asignada. Puedes conservar equivalencias para el perfil sin aplicarlas al estado administrativo.</p>}
  <p>Escribe el estado exacto del archivo y confirma su significado logístico en All Nutrition. Sin equivalencia se conserva como Estado sin identificar, sin inferir entrega ni cobro.</p>
  {Object.entries(config.statusMap||{}).map(([external,status])=><div className="order-line" key={external}><p>Identificador exacto del archivo: <strong>{external}</strong></p><label className="field">Estado en All Nutrition<select value={status} disabled={disabled} onChange={event=>onChange({...config.statusMap,[external]:event.target.value})}>{shipmentStates.map(({value,label})=><option key={value} value={value}>{label}</option>)}</select></label><button type="button" className="button subtle" disabled={disabled} onClick={()=>onChange(Object.fromEntries(Object.entries(config.statusMap).filter(([key])=>key!==external)))}>Quitar equivalencia</button></div>)}
  <label className="field">Identificador exacto del archivo<input maxLength={500} value={statusDraft} disabled={disabled} onChange={event=>setStatusDraft(event.target.value)}/><small className="muted">Copia el texto exacto de la celda de entrega / seguimiento; esta clave se guarda en statusMap.</small></label><button className="button subtle" type="button" disabled={disabled||!statusDraft.trim()} onClick={()=>{onChange({...config.statusMap,[statusDraft.trim()]:'unknown'});setStatusDraft('');}}>Añadir para revisar (sin identificar)</button>
 </details>;
}

function reviewFieldValue(field,value){
 if(value==null)return 'No informado';
 if(field?.type==='money')return formatMoneyMinor(value);
 if(field?.type==='date')return value.occurredOn||value.occurredAt||String(value);
 if(field?.type==='enum')return field.options.find(option=>option.value===value)?.label||String(value);
 return String(value);
}
function ReviewOrderValues({values={}}){
 const fields=importFields.filter(field=>field.scope==='order'&&!['externalOrderId','internalOrderNumber'].includes(field.value)&&values[field.value]!=null);
 if(!fields.length)return null;
 return <details><summary>Datos del pedido asignados</summary><p>Se aplican al crear un pedido completo. En un pedido existente esperan autorización comercial explícita; observar al destinatario de una guía no autoriza editar su pedido.</p><dl>{fields.map(field=><div key={field.value}><dt>{field.label}</dt><dd>{reviewFieldValue(field,values[field.value])}</dd></div>)}</dl></details>;
}
function ReviewShipment({shipment}){
 const values=shipment.values||{},fields=shipment.importedFields||[],byKey=new Map(fields.map(field=>[field.key,field]));
 const events=shipment.events||[],observation=shipment.insuranceCostObservation||(shipment.insuranceCostMapped?{amountMinor:values.insuranceCost??null,chargeOn:values.insuranceCostDate?.occurredOn||null}:null);
 const alreadyShown=new Set(['rawShipmentStatus','shippingType','insuredValue','expectedCollection']);
 const otherFields=fields.filter(field=>!alreadyShown.has(field.key));
 return <section className="order-line" aria-label="Datos preparados del envío">
  <h5>Envío · {values.tracking||values.externalShipmentId||'Identidad por resolver'}</h5>
  <dl><div><dt>Estado del envío en la plataforma</dt><dd>{byKey.get('rawShipmentStatus')?.value??'No asignado'} · Informativo</dd></div></dl>
  <p className="small muted">El estado administrativo no confirma entrega, cobro ni cancelación.</p>
  <h6>Estado de la entrega / seguimiento en el origen</h6>
  {events.length?<ul>{events.map((event,index)=><li key={`${event.status}:${event.occurredAt||event.occurredOn||event.sourceAsOf}:${index}`}><strong>{event.rawStatus||'Sin texto de origen'}</strong> → Significado logístico revisado: {shipmentStates.find(state=>state.value===event.status)?.label||event.status}. Fecha real: {event.occurredOn||event.occurredAt||'Desconocida'} · Corte: {event.sourceAsOf||'Sin corte conocido'}</li>)}</ul>:<p>No se propone un evento logístico.</p>}
  <dl><div><dt>Tipo de envío</dt><dd>{byKey.get('shippingType')?.value??'No informado'}</dd></div><div><dt>Valor asegurado / declarado</dt><dd>{reviewFieldValue(FIELD_DEFINITIONS.get('insuredValue'),byKey.get('insuredValue')?.value)}</dd></div><div><dt>Valor a recaudar</dt><dd>{reviewFieldValue(FIELD_DEFINITIONS.get('expectedCollection'),byKey.get('expectedCollection')?.value)} · No es recaudo recibido</dd></div></dl>
  <section aria-label="Seguro preparado"><h6>Costo del seguro</h6><dl><div><dt>Importe del cargo</dt><dd>{observation?observation.amountMinor==null?'Costo no informado':formatMoneyMinor(observation.amountMinor):'Sin observación; seguro opcional'}</dd></div><div><dt>Fecha del cargo</dt><dd>{observation?.chargeOn||'No informada; no se toma del corte ni de la carga'}</dd></div><div><dt>Cobertura del seguro</dt><dd>{!observation?'No exigida sin observación':observation.amountMinor==null?'Costo desconocido':!observation.chargeOn?'Importe conocido; fecha pendiente':observation.amountMinor===0?'Sin cargo de seguro; costo y fecha conocidos':'Costo y fecha conocidos'}</dd></div></dl><p className="small muted">Vacío: costo no informado. 0: sin cargo de seguro. Importar el cargo no lo paga; pagos y saldos se consultan en Caja.</p></section>
  {otherFields.length>0&&<details><summary>Otros datos importados y campos adicionales</summary><dl>{otherFields.map(field=><div key={`${field.sourceId}:${field.key}`}><dt>{field.label}</dt><dd>{field.value}<small className="muted"> · Columna {field.columnIndex+1} · {field.header||'Sin encabezado'} · Filas {field.rowNumbers.join(', ')}</small></dd></div>)}</dl></details>}
 </section>;
}
function SourceRows({batch,page,rowState,query,location,open,busy,onFilter,onSearch,onClearLocation,onPage,onToggle,onResolve}){
 const rows=batch?.rows;if(!rows)return null;const list=records(rows).filter(row=>!location||row.sheet===location.sheet&&row.rowNumber===location.rowNumber),maxPage=Math.max(1,Math.ceil((rows.total||0)/(rows.pageSize||20)));
 return <details open={open} onToggle={event=>onToggle(event.currentTarget.open)}>
  <summary data-import-source-rows tabIndex={-1}>Filas originales y motivos ({rows.total||0})</summary>
  {location&&<p><strong>Hoja {location.sheet} · fila {location.rowNumber}</strong> <button type="button" className="button subtle" disabled={busy} onClick={onClearLocation}>Ver todas las filas</button></p>}
  <form key={query} onSubmit={event=>{event.preventDefault();onSearch(String(new FormData(event.currentTarget).get('q')||'').trim());}}><label className="field">Buscar en las filas de este archivo<input type="search" name="q" maxLength={100} defaultValue={query} disabled={busy}/></label><div className="admin-actions"><button className="button subtle" disabled={busy}>Buscar filas</button><button type="reset" className="button subtle" disabled={busy} onClick={()=>onSearch('')}>Limpiar búsqueda</button></div><p className="small muted">Busca solo en las filas de esta importación. La búsqueda no se guarda en la dirección.</p></form>
  <label className="field">Filtrar filas<select value={rowState} disabled={busy} onChange={event=>onFilter(event.target.value)}><option value="">Todas</option>{['pending','new','updated','unchanged','conflict','rejected','ready','skipped','applied'].map(state=><option key={state} value={state}>{({pending:'Pendientes de procesar',new:'Nuevas',updated:'Por actualizar',unchanged:'Sin cambios',conflict:'En conflicto',rejected:'Con errores',ready:'Preparadas',skipped:'Omitidas',applied:'Aplicadas'})[state]}</option>)}</select></label>
  {!list.length?<p>{busy?'Consultando filas…':location?'Esta fila no está disponible en la revisión actual':'No hay filas para este filtro.'}</p>:list.map(row=>{
   const cells=Array.isArray(row.source)?row.source:row.cells||row.source?.cells||[],tasks=row.task||row.tasks||[];
   return <article className="order-line" key={json([row.sheet,row.rowNumber])}>
    <h4>{row.sheet} · fila {row.rowNumber}</h4><p>{RESULT_LABELS[row.state]||row.state} · {row.entityKey||row.groupKey}</p>
    {messages(row.errors).map((message,i)=><p className="error" key={i}>{message}</p>)}
    {messages(tasks).map((message,i)=><p key={i}>{message}</p>)}
    {row.reason&&<p>{row.reason}</p>}
    {cells.length>0&&<details><summary>Valores originales por posición</summary><dl>{cells.map((cell,i)=><div key={i}><dt>Columna {i+1}</dt><dd style={{marginLeft:0,overflowWrap:'anywhere',whiteSpace:'pre-wrap'}}>{cellText(cell)||'(vacío)'}</dd>{onResolve&&row.state!=='applied'&&!row.applied&&<button type="button" className="text-button" disabled={busy} onClick={()=>onResolve('cell_value',{...row,columnIndex:i,original:cell})}>Completar o corregir columna {i+1}</button>}</div>)}</dl></details>}
    {row.normalized?.values?.additionalFields?.length>0&&<details><summary>Campos adicionales normalizados</summary><dl>{row.normalized.values.additionalFields.map(field=><div key={`${field.key}:${field.columnIndex}`}><dt>{field.label} · columna {field.columnIndex+1} · {field.header||'Sin encabezado'}</dt><dd style={{marginLeft:0,overflowWrap:'anywhere'}}>{field.value}</dd></div>)}</dl></details>}
    {row.normalized?.lines?.length>0&&<details><summary>Productos normalizados de esta fila</summary><ul>{row.normalized.lines.map((line,i)=><li key={i}>{line.productExternalKey||line.itemId||'Sin vínculo'} · cantidad {line.quantity??'sin dato'} · {line.unitPriceMinor==null?'precio sin dato':`${(line.unitPriceMinor/100).toLocaleString('es-CO')} COP`}</li>)}</ul></details>}
    {onResolve&&row.state!=='applied'&&!row.applied&&<ResolutionActions actions={ROW_RESOLUTIONS} disabled={busy} onResolve={action=>onResolve(action,row)}/>}
   </article>;
  })}
  <div className="admin-actions"><button type="button" className="button subtle" disabled={busy||page<=1} onClick={()=>onPage(page-1)}>Anterior</button><span>Página {page} de {maxPage}</span><button type="button" className="button subtle" disabled={busy||page>=maxPage} onClick={()=>onPage(page+1)}>Siguiente</button></div>
 </details>;
}

function CommercialResolution({api,value,group,onChange}){
 const [products,setProducts]=useState([]),[people,setPeople]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{let active=true;setLoading(true);setError('');Promise.all([api('/api/admin/products'),api('/api/admin/combos'),api('/api/admin/business/people?active=1')]).then(([productData,comboData,personData])=>{if(active){setProducts([...records(productData).map(item=>({...item,kind:'products'})),...records(comboData).map(item=>({...item,kind:'combos'}))]);setPeople(records(personData));}}).catch(cause=>{if(active)setError(cause.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[api,attempt]);
 const set=(key,next)=>onChange({...value,[key]:next}),remove=key=>onChange(Object.fromEntries(Object.entries(value).filter(([field])=>field!==key))),has=key=>Object.hasOwn(value,key);
 const lineChange=(index,patch)=>set('items',(value.items||[]).map((line,i)=>i===index?{...line,...patch}:line));
 const mapped=group?.units?.[0]?.values||{};
 return <section aria-label="Datos comerciales explícitos">
  <p>Completa productos escritos como texto libre o autoriza datos comerciales concretos. Solo se envían los campos marcados; no se usan precios actuales del catálogo ni se cambian costos de productos.</p>
  <p className="small muted">Actualizar un pedido ya despachado no permite reescribir el acuerdo económico. El servidor comprueba su versión y estado en la nueva revisión.</p>
  {loading&&<p role="status">Cargando productos y vendedores reales…</p>}
  {error&&<div role="alert"><p className="error">{error}</p><button type="button" className="button subtle" onClick={()=>setAttempt(old=>old+1)}>Reintentar registros</button></div>}
  <div className="form-grid">{COMMERCIAL_FIELDS.map(field=>{
   const key=field.value==='orderNotes'?'notes':field.value,label=field.value==='placedOn'?'Fecha comercial del pedido':field.label;
   const proposed=field.type==='date'?mapped[field.value]?.occurredOn||cutoffDate(mapped[field.value]):mapped[field.value]??'';
   const attributes={required:['customerName','phone','city','placedOn'].includes(key),value:value[key]??'',maxLength:field.max,onChange:event=>set(key,event.target.value)};
   return <div key={key}><label className="checkbox-field"><input type="checkbox" checked={has(key)} onChange={event=>event.target.checked?set(key,proposed):remove(key)}/><span>Completar o cambiar {label.toLocaleLowerCase('es')}</span></label>{proposed!==''&&!has(key)&&<p className="small muted">Dato asignado, sin autorizar: {String(proposed)}</p>}{has(key)&&<label className="field">{label}{field.type==='enum'?<select value={value[key]??''} required onChange={attributes.onChange}><option value="">Selecciona la modalidad</option>{field.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>:field.max>500?<textarea {...attributes}/>:<input {...attributes} type={field.type==='date'?'date':key==='email'?'email':'text'}/>}</label>}</div>;
  })}</div>
  <label className="checkbox-field"><input type="checkbox" checked={has('sellerId')} onChange={event=>event.target.checked?set('sellerId',null):remove('sellerId')}/><span>Asignar vendedor explícitamente</span></label>
  {has('sellerId')&&<label className="field">Vendedor<select value={value.sellerId||''} onChange={event=>set('sellerId',event.target.value||null)}><option value="">Sin vendedor</option>{people.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>}
  <label className="checkbox-field"><input type="checkbox" checked={has('shippingChargeMinor')} onChange={event=>event.target.checked?set('shippingChargeMinor',null):remove('shippingChargeMinor')}/><span>Completar o cambiar flete cobrado al cliente</span></label>
  {has('shippingChargeMinor')&&<Field field={{name:'commercialShipping',label:'Flete cobrado COP',type:'moneyOptionalMinor',required:true}} value={value.shippingChargeMinor} onChange={amount=>set('shippingChargeMinor',amount)}/>}
  <label className="checkbox-field"><input type="checkbox" checked={has('items')} onChange={event=>event.target.checked?set('items',[{kind:'products',itemId:'',quantity:1,unitPriceMinor:null,discountMinor:0}]):remove('items')}/><span>Completar las líneas del pedido (lista completa revisada)</span></label>
  {has('items')&&<><p>Incluye todas las líneas que debe conservar el pedido, no solo las que faltaban. Precio y descuento son importes explícitos de este acuerdo.</p>{(value.items||[]).map((line,index)=><fieldset className="order-line" key={index}><legend>Línea {index+1}</legend><label className="field">Producto, obsequio o combo real<select required value={`${line.kind}:${line.itemId}`} onChange={event=>{const selected=products.find(product=>`${product.kind}:${product.id}`===event.target.value);lineChange(index,{kind:selected?.kind||'products',itemId:selected?.id||''});}}><option value={`${line.kind}:`}>Selecciona un registro</option>{products.map(product=><option key={`${product.kind}:${product.id}`} value={`${product.kind}:${product.id}`}>{product.title} · {product.presentation||product.kind}</option>)}</select></label><label className="field">Cantidad<input type="number" required min={1} max={999} step={1} value={line.quantity} onChange={event=>lineChange(index,{quantity:Number(event.target.value)})}/></label><div className="form-grid"><Field field={{name:`commercialPrice${index}`,label:'Precio unitario COP',type:'moneyOptionalMinor',required:true}} value={line.unitPriceMinor} onChange={amount=>lineChange(index,{unitPriceMinor:amount})}/><Field field={{name:`commercialDiscount${index}`,label:'Descuento total de línea COP',type:'moneyOptionalMinor',required:true}} value={line.discountMinor} onChange={amount=>lineChange(index,{discountMinor:amount})}/></div><details><summary>Conservar ID de línea existente</summary><label className="field">ID de línea (solo al corregir una línea existente)<input maxLength={100} value={line.lineId||''} onChange={event=>{const {lineId,...other}=line;lineChange(index,event.target.value?{lineId:event.target.value}:{...other,lineId:undefined});}}/></label></details><button type="button" className="button subtle" disabled={value.items.length===1} onClick={()=>set('items',value.items.filter((_,i)=>i!==index))}>Quitar línea {index+1}</button></fieldset>)}<button type="button" className="button subtle" onClick={()=>set('items',[...value.items,{kind:'products',itemId:'',quantity:1,unitPriceMinor:null,discountMinor:0}])}>Agregar línea real</button></>}
  <details>
    <summary>Distribuir cantidades entre guías (avanzado)</summary>
    <p>Úsalo cuando las filas no expliquen qué productos viajan en cada guía. No crea otra venta. Primero revisa las líneas para obtener sus identificadores estables.</p>
    <label className="checkbox-field"><input type="checkbox" checked={has('shipmentAssignments')} onChange={event=>event.target.checked?set('shipmentAssignments',[]):remove('shipmentAssignments')}/><span>Asignar explícitamente las cantidades por envío</span></label>
    {has('shipmentAssignments')&&<ShipmentAssignmentsResolution group={group} value={value.shipmentAssignments} onChange={next=>set('shipmentAssignments',next)}/>}
  </details>
 </section>;
}

function ShipmentAssignmentsResolution({group,value=[],onChange}){
 const lines=group?.lines||[];
 const guides=[...new Map((group?.units||[]).flatMap(unit=>unit.shipments||[]).map(shipment=>{
  const data=shipment.values||shipment;
  return [json([data.externalShipmentId||'',data.tracking||'']),{externalShipmentId:data.externalShipmentId||'',tracking:data.tracking||''}];
 })).values()];
 const change=(index,patch)=>onChange(value.map((shipment,i)=>i===index?{...shipment,...patch}:shipment));
 const quantity=(index,lineId,count)=>change(index,{assignments:[...(value[index].assignments||[]).filter(line=>line.lineId!==lineId),...(count>0?[{lineId,quantity:count}]:[])]});
 return <div>
  {!lines.length&&<p className="hint">Genera una revisión con las líneas comerciales completas antes de asignar cantidades a guías.</p>}
  {value.map((shipment,index)=><fieldset className="order-line" key={index}>
    <legend>Envío {index+1}</legend>
    {guides.length>0&&<label className="field">Guía observada en este grupo
      <select value={guides.findIndex(guide=>guide.externalShipmentId===shipment.externalShipmentId&&guide.tracking===shipment.tracking)} onChange={event=>{const guide=guides[Number(event.target.value)];if(guide)change(index,guide);}}>
        <option value={-1}>Escribir identificación exacta</option>
        {guides.map((guide,i)=><option key={i} value={i}>{guide.tracking||guide.externalShipmentId}</option>)}
      </select>
    </label>}
    <div className="form-grid">
      <label className="field">ID externo del envío (si existe)<input maxLength={300} value={shipment.externalShipmentId||''} onChange={event=>change(index,{externalShipmentId:event.target.value})}/></label>
      <label className="field">Guía exacta<input required={!shipment.externalShipmentId} maxLength={150} value={shipment.tracking||''} onChange={event=>change(index,{tracking:event.target.value})}/></label>
    </div>
    {lines.map(line=><label className="field" key={line.lineId}>{line.title||line.productExternalKey||line.itemId} · línea {line.lineId}
      <input type="number" min={0} max={Number.isInteger(line.quantity)?line.quantity:999} step={1} value={(shipment.assignments||[]).find(item=>item.lineId===line.lineId)?.quantity||0} onChange={event=>quantity(index,line.lineId,Number(event.target.value))}/>
    </label>)}
    <button type="button" className="button subtle" onClick={()=>onChange(value.filter((_,i)=>i!==index))}>Quitar envío {index+1}</button>
  </fieldset>)}
  <button type="button" className="button subtle" disabled={!lines.length} onClick={()=>onChange([...value,{externalShipmentId:'',tracking:'',assignments:[]}])}>Agregar asignación de guía</button>
  <ul aria-live="polite">{lines.map(line=>{
    const assigned=value.reduce((sum,shipment)=>sum+(shipment.assignments||[]).filter(item=>item.lineId===line.lineId).reduce((sum,item)=>sum+item.quantity,0),0);
    return <li className={assigned>line.quantity?'error':undefined} key={line.lineId}>{line.title||line.productExternalKey||line.itemId}: {assigned} de {line.quantity} unidades asignadas{assigned>line.quantity?' · excede lo comprado':''}</li>;
  })}</ul>
 </div>;
}

function SheetFixedValues({config,onChange}){
 const hasGifts=config.purpose==='orders'&&config.columns.some(column=>column.destination==='giftProductExternalKey');
 const fields=config.purpose==='expenses'?['expenseCategory','expenseConcept','expenseSupplier','expenseCampaign']:['orders','tracking','settlements'].includes(config.purpose)?['deliveryMethod','carrier',...(hasGifts?['giftQuantity']:[])]:[];
 if(!fields.length)return null;
 return <><details open={hasGifts}><summary>Valores comunes de esta hoja{hasGifts?' y cantidad de obsequios':''}</summary><p>Solo completan destinos sin columna asignada. Una celda vacía de una columna asignada sigue pendiente.</p><div className="form-grid">{fields.map(key=>{
  const definition=FIELD_DEFINITIONS.get(key),assigned=key==='giftQuantity'?config.columns.filter(column=>column.destination==='giftProductExternalKey').every(gift=>config.columns.some(column=>column.destination==='giftQuantity'&&(column.group||0)===(gift.group||0))):config.columns.some(column=>column.destination===key);
  const change=value=>onChange(value===''?Object.fromEntries(Object.entries(config.defaults||{}).filter(([field])=>field!==key)):{...config.defaults,[key]:value});
  const giftQuantity=key==='giftQuantity';
  return <label className="field" key={key}>{giftQuantity?'Confirmar cantidad de obsequios por fila en esta hoja':definition?.label||key}{giftQuantity?<input type="number" min={1} max={999} step={1} disabled={assigned} value={config.defaults?.[key]??''} onChange={event=>change(event.target.value===''?'':Number(event.target.value))}/>:definition?.options?<select disabled={assigned} value={config.defaults?.[key]||''} onChange={event=>change(event.target.value)}><option value="">Sin valor fijo</option>{definition.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>:<input disabled={assigned} maxLength={definition?.max||200} value={config.defaults?.[key]||''} onChange={event=>change(event.target.value)}/>}<small>{assigned?'Hay columna asignada: este valor fijo no se aplica ni completa sus celdas vacías.':giftQuantity?'Escribe un entero de 1 a 999 solo si es la cantidad real común de esta hoja, para los grupos sin columna de cantidad de obsequios. Vacío = sin confirmar; incluso 1 debe elegirse explícitamente. Una cantidad mapeada vacía no se completa; tampoco se toma la cantidad del producto ni se interpreta el nombre.':'Opcional; confirma un valor común real.'}</small></label>;
 })}</div></details>{hasGifts&&<p className="small muted">Cada referencia de obsequio no vacía crea una línea independiente con precio de venta cero. Confirma su cantidad mediante una columna o este valor común; sus componentes determinan el costo y las existencias. Una referencia vacía no añade obsequio.</p>}</>;
}

function ExpenseCategoryMapping({config,sampleRows,onChange}){
 const column=config.columns.find(column=>column.destination==='expenseCategory');
 if(!column)return null;
 const names=[...new Set([...Object.keys(config.expenseCategoryMap||{}),...sampleRows.filter(row=>row.rowNumber>config.headerRow).map(row=>cellText(row.cells[column.index])).filter(Boolean)])];
 return <details><summary>Categorías de los gastos</summary><p>Confirma los rótulos del archivo. Solo se admiten Publicidad, Operación u Otros gastos; sueldos y comisiones conservan su módulo.</p>{names.map(name=><label key={name} className="field">{name}<select value={config.expenseCategoryMap?.[name]||''} onChange={event=>onChange(event.target.value?{...config.expenseCategoryMap,[name]:event.target.value}:Object.fromEntries(Object.entries(config.expenseCategoryMap||{}).filter(([key])=>key!==name)))}><option value="">Por confirmar</option><option value="advertising">Publicidad</option><option value="operating">Operación</option><option value="other">Otros gastos</option></select></label>)}</details>;
}

function GroupIssueActions({group,disabled,onResolve,onKeepDate,onConfigureSheet,onInspectRows,onEditProduct}){
 const issues=group.errors||[];
 return <div className="admin-actions">{issues.map((issue,index)=>{
  const refs=issue.rowRefs?.length?issue.rowRefs:(group.rowRefs||[]).filter(ref=>(!issue.sheet||ref.sheet===issue.sheet)&&(!issue.rowNumber||ref.rowNumber===issue.rowNumber)),single=refs.length===1?refs[0]:{},sheet=issue.sheet||single.sheet,number=issue.rowNumber||single.rowNumber,context={entityKey:groupKey(group),sheet,rowNumber:number,externalKey:issue.externalKey||'',columnIndex:issue.columnIndex,original:issue.originalValue,rowRefs:refs};
  const action=(label,run)=><button key={index} type="button" className="button subtle" disabled={disabled} onClick={run}>{label}</button>;
  if(['IMPORT_PRODUCT_LINK','IMPORT_GIFT_LINK'].includes(issue.code))return context.externalKey?action(`${issue.code==='IMPORT_GIFT_LINK'?'Vincular obsequio real':'Vincular producto'} ${context.externalKey}`,()=>onResolve('link_product',{...context,giftOnly:issue.code==='IMPORT_GIFT_LINK'})):action('Ver filas para identificar la referencia',()=>onInspectRows(sheet&&number?{sheet,rowNumber:number}:null));
  if(issue.code==='IMPORT_YEAR_CONFIRMATION')return <div key={index}><strong>{issue.normalizedDate} · {sheet} · fila {number}</strong><button type="button" className="button subtle" disabled={disabled||!sheet||!number} onClick={()=>onKeepDate({...issue,sheet,rowNumber:number})}>Conservar fecha del archivo</button><button type="button" className="button subtle" disabled={disabled} onClick={()=>onResolve('cell_value',context)}>Corregir esta fecha</button></div>;
  if(issue.code==='IMPORT_OPENING_CLASSIFICATION')return action('Clasificar hecho frente al conteo',()=>onResolve('opening_observation',context));
  if(['IMPORT_ORDER_INCOMPLETE','IMPORT_COMMERCIAL_AUTHORITY'].includes(issue.code))return action('Completar o revisar datos de este pedido',()=>onResolve('commercial_update',context));
  if(issue.code==='IMPORT_POLICY_REQUIRED')return action('Revisar regla histórica de esta operación',()=>onResolve('review_policy',context));
  if(issue.code==='IMPORT_FORMULA_ACCEPTANCE')return sheet&&issue.field?action('Revisar valor guardado de esta fórmula',()=>onResolve('accept_formulas',{...context,externalKey:issue.field})):action('Ver origen de la fórmula',()=>onInspectRows(sheet&&number?{sheet,rowNumber:number}:null));
  if(issue.code==='IMPORT_COMPONENT_COSTS')return group.lines?.length?action('Completar costos históricos de componentes',()=>onResolve('line_costs',context)):action('Ver datos pendientes de las líneas',event=>{const details=event.currentTarget.closest('[data-import-operation]')?.querySelector('[data-import-operation-effects]');if(details){details.open=true;details.querySelector('summary')?.focus();}});
  if(issue.code==='IMPORT_EXPENSE_AUTHORITY')return action('Revisar autoridad de este gasto',()=>onResolve('review_authority',context));
  if(['IMPORT_CUTOFF_REQUIRED','IMPORT_GIFT_QUANTITY','IMPORT_GIFT_REQUIRED'].includes(issue.code))return action(issue.code==='IMPORT_CUTOFF_REQUIRED'?'Confirmar corte de esta hoja':'Revisar columnas y valores de obsequios',()=>onConfigureSheet(sheet,issue.code==='IMPORT_CUTOFF_REQUIRED'?'cutoff':issue.code==='IMPORT_GIFT_QUANTITY'?'defaults':'columns'));
  if(issue.code==='IMPORT_INVENTORY'&&issue.productId)return action('Revisar conteo físico del producto',()=>onEditProduct(issue.productId));
  if(['IMPORT_DUPLICATE_IDENTITY','IMPORT_DUPLICATE_EXPENSE','IMPORT_DUPLICATE_ROW'].includes(issue.code)){
   const locations=refs.length?refs:sheet&&number?[{sheet,rowNumber:number}]:[];
   return <details key={index}><summary>Ubicaciones de las posibles repeticiones</summary>{locations.length?locations.map(ref=><div key={json([ref.sheet,ref.rowNumber])}><p>{ref.sheet} · fila {ref.rowNumber}</p><button type="button" className="button subtle" disabled={disabled} onClick={()=>onInspectRows(ref)}>Ver fila original</button><button type="button" className="button subtle" disabled={disabled} onClick={()=>onResolve('duplicate',{...context,...ref,reason:''})}>Omitir esta repetición</button><button type="button" className="button subtle" disabled={disabled} onClick={()=>onResolve(issue.code==='IMPORT_DUPLICATE_ROW'?'additional_quantity':'independent_record',{...context,...ref,reason:''})}>{issue.code==='IMPORT_DUPLICATE_ROW'?'Contar como cantidad adicional':'Es una operación independiente'}</button></div>):<button type="button" className="button subtle" onClick={()=>onInspectRows(null)}>Ver filas originales</button>}</details>;
  }
  return action('Otras opciones de corrección',event=>{const details=event.currentTarget.closest('[data-import-operation]')?.querySelector('[data-import-other-options]');if(details){details.open=true;details.querySelector('summary')?.focus();}});
 })}</div>;
}
