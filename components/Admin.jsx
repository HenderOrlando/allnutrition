'use client';
import { useState,useEffect,useCallback,useRef,useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { schemas,settingsFields,emptyRecord,contentStates,slugify } from '@/lib/schema.mjs';
import { adminSections,readAdminView,adminHref,adminReturnTo } from '@/lib/admin-view.mjs';
import { bogotaDate } from '@/lib/business/dates.mjs';
import { Field } from './Fields';
import RecordEditor from './RecordEditor';
import OrderEditor from './OrderEditor';
import Icon from './Icons';
import UserManagement from './UserManagement';
import AdminNavigation,{ AreaNavigation } from './AdminNavigation';
import AdminOverview from './AdminOverview';
import AssistantConsole from './AssistantConsole';
import AdvisorInbox from './AdvisorInbox';
import AdvisorTasks from './AdvisorTasks';
import AdvisorActionFocus from './AdvisorActionFocus';
import AdvisorDirectory from './AdvisorDirectory';
import AdvisorPreferences from './AdvisorPreferences';
import AdvisorRecommendations from './AdvisorRecommendations';
import useAdvisorInbox from './useAdvisorInbox';
import { ContentList } from './AdminLists';
import OrdersWorkspace from './OrdersWorkspace';
import ReportsWorkspace from './ReportsWorkspace';
import BusinessActionDialog from './BusinessActionDialog';
import CashWorkspace from './CashWorkspace';
import AdvertisingWorkspace from './AdvertisingWorkspace';
import BusinessSettings from './BusinessSettings';
import AssistantSettings from './AssistantSettings';
import ConfigurationNavigation from './ConfigurationNavigation';
import { adminTasks,adminLocationLabel,isCurrentAdminTask } from './admin-tasks.mjs';
import { AssistantBridgeProvider,useAssistantForm,useAssistantBridge,validateAdvisorTarget,isShipmentCatalogTarget } from './AssistantBridge';
import configurationStyles from './ConfigurationExperience.module.css';
const contentKeys=Object.keys(schemas);
const initialResources=()=>Object.fromEntries(contentKeys.map(key=>[key,{records:null,loading:false,error:''}]));
const blankResource=()=>({data:null,loading:false,error:''});
const editorDependencies={products:['products','catalogs'],combos:['products','catalogs'],orders:['products','combos']};
const orderCatalogTabs=new Map([
 ['orders.open-order','agreement'],
 ['orders.read-agreement','agreement'],
 ['orders.update-order','agreement'],
 ['orders.mark-preparing','agreement'],
 ['orders.cancel-order','agreement'],
 ['orders.read-collections','collections'],
 ['orders.record-collection','collections'],
 ['orders.record-platform-collection','collections'],
 ['orders.record-refund','collections'],
 ['orders.record-platform-refund','collections'],
 ['cash.reverse-collection','collections'],
 ['cash.reverse-refund','collections'],
 ['orders.read-profitability','profit'],
 ['orders.record-return','profit'],
 ['orders.complete-costs','profit'],
 ['orders.record-freight-cost','agreement'],
 ['orders.correct-freight-cost','agreement'],
 ['shipments.prepare-shipment','shipments'],
 ['shipments.create-shipment','shipments'],
 ['shipments.split-shipment','shipments'],
 ['shipments.replace-shipment','shipments']
]);
const contentCatalogKinds=new Map([
 ['products.open-product','products'],['products.open-combo','combos'],['products.open-catalog','catalogs'],['products.read-stock','products'],
 ['products.preview-image-url','products'],['products.remove-image','products'],['products.upload-image','products']
]);
const contentCreateKinds=new Map([['products.create-product','products'],['products.create-gift','products'],['products.create-combo','combos'],['products.create-catalog','catalogs']]);
const contentUpdateKinds=new Map([
 ['products.update-product','products'],['products.record-stock-count','products'],['products.record-unit-cost','products'],
 ['products.set-orderability','products'],['products.assign-catalogs','products'],
 ['products.update-gift','products'],['products.update-combo','combos'],['products.set-combo-orderability','combos'],
 ['products.assign-combo-catalogs','combos'],['products.update-catalog','catalogs'],
 ['products.delete-product','products'],['products.delete-combo','combos'],['products.delete-catalog','catalogs'],
]);
const normalProductActions=new Set(['products.create-product','products.update-product','products.record-stock-count','products.record-unit-cost']);
const giftProductActions=new Set(['products.create-gift','products.update-gift']);
const savedContentRead=new Set(['products.open-product','products.open-combo','products.open-catalog','products.read-stock']);
const reportContextFocus=new Set(['report-coverage-reasons','report-live-metric-records','report-live-missing-records','report-snapshot-metric-records','report-snapshot-missing-records','report-comparison-elapsed-records']);
const homeReportActions=new Set(['home.sales-records','home.sales-gaps','home.result-records','home.result-gaps','home.delivery-records','home.delivery-gaps','home.cash-records']);
const reportObservationActions=new Set(['reports.view-negative-contribution','reports.view-positive-contribution','reports.view-positive-products','reports.view-positive-sellers','reports.view-absorbed-shipping','reports.view-costly-returns','reports.view-late-deliveries','reports.view-shipment-returns']);
const homeObservationActions=new Set(['home.observation-contribution','home.observation-return-credits','home.observation-shipping-cost','home.observation-result','home.observation-deliveries','home.observation-logistic-returns']);
const campaignEvidenceActions=new Set(['advertising.read-approved-revision','advertising.read-delivery-status','advertising.read-operation-history','advertising.inspect-result-capture']);
const hekaLookupFallback=new Map([
 ['heka.use-origin-city','heka-city-search'],['heka.use-destination-city','heka-city-search'],
 ['heka.use-warehouse','heka-warehouse-search'],['heka.apply-template','heka-template-search'],
]);
const localCampaignCatalogFocus=new Map([
 ['advertising.open-campaign','ad-campaign-ficha'],
 ['advertising.choose-publication-mode','ad-campaign-mode'],
 ['advertising.define-message','ad-campaign-message'],
 ['advertising.declare-ai-origin','ad-campaign-ai-disclosure'],
 ['advertising.assist-draft','ad-campaign-assist-draft'],
 ['advertising.review-connection-prerequisite','ad-campaign-connection'],
 ['advertising.choose-networks','ad-campaign-networks'],
 ['advertising.choose-markets','ad-campaign-markets'],
 ['advertising.choose-placements','ad-campaign-placements'],
 ['advertising.search-offers','ad-offer-search'],
 ['advertising.choose-offer','ad-offer-choice'],
 ['advertising.define-offer-gift','ad-offer-gift'],
 ['advertising.reread-offer','ad-offer-reread'],
 ['advertising.accept-current-offer','ad-offer-accept'],
 ['advertising.choose-connection','ad-campaign-choose-connection'],
 ['advertising.plan-paid-budget','ad-campaign-paid-budget'],
 ['advertising.choose-audience-mode','ad-campaign-audience-mode'],
 ['advertising.define-manual-audience','ad-campaign-manual-audience'],
 ['advertising.review-audience-sharing','ad-campaign-audience-sharing'],
 ['advertising.plan-organic-schedule','ad-campaign-schedule'],
 ['advertising.review-draft','ad-campaign-review'],
 ['advertising.create-draft','ad-campaign-save'],
 ['advertising.update-draft','ad-campaign-save'],
 ['advertising.prepare-forecast-scenario','ad-campaign-forecast-scenario'],
 ['advertising.request-forecast','ad-campaign-local-forecast'],
 ['advertising.request-api-paid-forecast','ad-campaign-api-forecast'],
 ['advertising.approve-organic','ad-campaign-approve-organic'],
 ['advertising.prepare-paid','ad-campaign-prepare-paid'],
 ['advertising.prepare-browser-draft','ad-campaign-prepare-browser'],
 ['advertising.validate-browser-draft','ad-campaign-validate-browser'],
 ['advertising.read-browser-preflight','ad-campaign-preflight-record'],
 ['advertising.search-api-targeting','ad-campaign-search-api-targeting'],
 ['advertising.search-browser-targeting','ad-campaign-search-browser-targeting'],
 ['advertising.choose-targeting-references','ad-campaign-choose-targeting-references'],
 ['advertising.propose-ai-audience','ad-campaign-propose-ai-audience'],
 ['advertising.propose-manual-audience-improvements','ad-campaign-propose-manual-audience-improvements'],
 ['advertising.read-audience-request','ad-campaign-read-audience-request'],
 ['advertising.apply-audience-differences','ad-campaign-apply-audience-differences'],
 ['advertising.apply-broad-audience','ad-campaign-apply-broad-audience'],
 ['advertising.read-offer-learning','ad-offer-learning'],
 ['advertising.reuse-learning-idea','ad-offer-reuse-learning'],
 ['advertising.open-meta-publication','ad-campaign-meta-publication'],
 ['advertising.cancel-local-work','ad-campaign-cancel'],
]);
const campaignNativeHandoffs=new Map([
 ['advertising.publish-organic-now','ad-campaign-publish-now'],['advertising.schedule-organic-publication','ad-campaign-publish-schedule'],
 ['advertising.activate-paid','ad-campaign-activate'],['advertising.pause-paid','ad-campaign-pause'],
 ['advertising.resume-paid','ad-campaign-resume'],['advertising.cancel-issued-ads','ad-campaign-cancel-issued'],
 ['advertising.reconcile-campaign','ad-campaign-reconcile'],['advertising.reconcile-delivery','ad-campaign-reconcile-delivery'],
 ['advertising.link-remote-object','ad-campaign-link-remote'],['advertising.confirm-remote-absence','ad-campaign-confirm-absent'],
 ['advertising.resume-restored','ad-campaign-restore'],
]);
const inPlaceCampaignControls=new Map([
 ['advertising.review-in-place-draft','ad-same-review'],['advertising.save-in-place-caption','ad-same-text'],
 ['advertising.save-in-place-image','ad-same-image'],['advertising.confirm-in-place-change','ad-same-confirm'],
 ['advertising.cancel-in-place-draft','ad-same-cancel'],
]);
const creativeStudioControls=new Map([
 ['advertising.upload-studio-attachment','ad-studio-upload'],['advertising.attach-library-asset','ad-studio-choose-library'],
 ['advertising.inspect-creative-variant','ad-studio-review-assets'],['advertising.use-reviewed-asset','ad-studio-use-asset'],
 ['advertising.prepare-creative-instructions','ad-studio-prepare-creative'],['advertising.search-creative-references','ad-studio-search-references'],
 ['advertising.choose-creative-references','ad-studio-choose-references'],['advertising.review-generation-inputs','ad-studio-review-inputs'],
 ['advertising.read-generation-progress','ad-studio-progress'],['advertising.generate-image','ad-studio-consent-new'],['advertising.adjust-image','ad-studio-consent-adjust'],
]);
const metaInventoryControls=new Map([
 ['advertising.open-meta-inventory-campaign','ad-meta-inventory-campaign'],['advertising.select-meta-inventory-snapshot','ad-meta-inventory-snapshot'],
 ['advertising.read-meta-inventory-adsets','ad-meta-inventory-adsets'],['advertising.open-meta-inventory-counterpart','ad-meta-inventory-counterpart'],
]);
const resultRecommendationControls=new Map([
 ['advertising.analyze-local-results','ad-results-analyze'],['advertising.open-cited-capture','ad-results-cited-capture'],
 ['advertising.open-comparable-campaign','ad-results-comparable-campaign'],['advertising.create-recommended-variant','ad-results-variant'],
 ['advertising.prepare-in-place-change','ad-results-in-place'],['advertising.dismiss-recommendation','ad-results-dismiss'],
 ['advertising.assist-result-action-reason','ad-results-action-reason'],
]);
const accountAnalysisControls=new Map([['advertising.refresh-account-analysis','ad-account-analysis-refresh'],['advertising.cancel-account-analysis','ad-account-analysis-cancel'],['advertising.open-meta-rules-source','ad-account-analysis-rule-source']]);
const newMetaConnectionControls=new Set(['meta-oauth-connect-control','meta-manual-token-form','meta-browser-connection-create']);
const selectedMetaConnectionControls=new Set(['meta-oauth-reauthorize-control','meta-existing-browser-connection-open','meta-connection-permissions-detail','meta-connection-resource-picker','meta-connection-validate-control','meta-account-live-metrics-form']);
const metaConnectionDialogs=new Map([
 ['business.meta-browser-login',['browser-login','meta-existing-browser-connection-open']],
 ['business.meta-disconnect-pause',['disconnect','meta-disconnect-review']],['business.meta-disconnect-local',['disconnect','meta-disconnect-review']],
 ['business.meta-delete-preview',['delete-platform-data','meta-delete-review']],['business.meta-delete-pause',['delete-platform-data','meta-delete-review']],
 ['business.meta-delete-local',['delete-platform-data','meta-delete-review']],
]);
const cashAccountHandoffs=new Set(['cash.archive-account','cash.reactivate-account','cash.enable-closing-rule','cash.disable-closing-rule']);
const selectedExpenseActions=new Set(['cash.correct-expense','cash.pay-expense','cash.part-pay-expense','cash.recover-expense-credit','cash.reverse-expense-payment']);
const shipmentEventActions=new Set(['shipments.record-dispatch','shipments.record-delivery','shipments.record-incident','shipments.record-return','shipments.record-cancellation','shipments.record-tracking-event','shipments.record-unknown-status','shipments.rectify-event','shipments.classify-event-opening']);
const alertSources=new Map([
 ['alerts.open-order',{section:'orders',tab:'list',focus:'order-agreement-detail'}],
 ['alerts.open-stock',{section:'products',type:'product',focus:'product-inventory-summary'}],
 ['alerts.open-shipment',{section:'orders',tab:'shipments',type:'shipment',focus:'shipment-detail'}],
 ['alerts.open-account',{section:'cash',tab:'overview',type:'cash_account',focus:'cash-open-account'}],
 ['alerts.open-source',{section:'orders',tab:'imports',type:'source',key:'source',focus:'import-new-with-source'}],
 ['alerts.open-closing',{section:'cash',tab:'overview',type:'cash_closing',focus:'cash-closing-open-detail'}],
 ['alerts.open-settlement',{section:'cash',tab:'settlements',type:'settlement',focus:'cash-settlement-open-detail'}],
 ['alerts.open-expense',{section:'cash',tab:'expenses',type:'expense',focus:'cash-expense-open-detail'}],
]);
const importDraftFocus=new Set(['import-file-step','import-origin-choice','import-create-platform','import-create-source','import-file-picker','import-file-upload','import-discard-local-file','import-template-download','import-new-with-source','import-new-with-profile','import-profile-choice']);
const savedImportReviewFocus=new Set(['import-issue-filters','import-review-effects','import-source-rows']);
const savedImportMappingFocus=new Set(['import-sheet-selection','import-sheet-proposal','import-similar-sheet-proposal','import-workbook-proposal','import-status-mapping','import-sheet-structure','import-column-search','import-column-destination','import-draft-save','import-file-cutoff','import-sheet-identity','import-fixed-values','import-sheet-samples']);
const savedImportControls=new Set(['import-applied-results','import-preview-request','import-profile-save','import-batch-cancellation','import-reinspect-file','import-inventory-opening','import-original-date-consent','import-heka-package-choice']);
const exactImportResolutionControls=new Set(['import-cell-correction','import-group-exclusion','import-product-identity','import-create-linked-item','import-seller-identity','import-order-identity','import-shipment-identity','import-expense-identity','import-duplicate-resolution','import-independent-row','import-additional-quantity','import-observed-status','import-historical-policy','import-source-authority','import-cached-formula-consent','import-order-correction','import-historical-line-cost','import-opening-fact']);
const paidCampaignControls=new Set([
 'advertising.plan-paid-budget','advertising.choose-audience-mode','advertising.define-manual-audience','advertising.review-audience-sharing',
 'advertising.search-api-targeting','advertising.search-browser-targeting','advertising.choose-targeting-references',
 'advertising.propose-ai-audience','advertising.propose-manual-audience-improvements','advertising.read-audience-request',
 'advertising.apply-audience-differences','advertising.apply-broad-audience','advertising.prepare-browser-draft',
 'advertising.validate-browser-draft','advertising.read-browser-preflight','advertising.request-api-paid-forecast','advertising.prepare-paid',
]);
const personObligationActions=new Set(['business.salary-add','business.salary-end','business.commission-add']);
const settingsGroups=[
 {key:'identity',title:'Identidad de la marca',action:'Editar identidad',description:'Nombre, eslogan y logo que se muestran en la vitrina.',fields:['brandName','tagline','logo']},
 {key:'contact',title:'Contacto y redes',action:'Editar contacto',description:'Canales públicos para conversar con tus clientes. No compartas contraseñas de tus redes.',fields:['whatsapp','whatsappTemplate','facebook','instagram','email','hours']},
 {key:'payment',title:'Información de pago',action:'Editar pagos',description:'Explica cómo pueden pagar tus clientes. Este texto no conecta pasarelas ni registra cobros.',fields:['paymentInfo']},
 {key:'publication',title:'Publicación de la vitrina',action:'Revisar publicación',description:'Decide si la web muestra los contenidos publicados o la página de preparación. Los cambios se aplican al guardar.',fields:['launchApproved','showNextStage']},
 {key:'verification',title:'Dominio y verificación',action:'Configurar Meta',description:'Configura la verificación del dominio de la vitrina en Meta.',fields:['metaDomainVerification']}
];
const settingsHelp={whatsapp:'Por ejemplo, 573001234567. Incluye el código de país, sin + ni espacios.',whatsappTemplate:'Escribe {producto} donde deba aparecer la referencia que consulta el cliente.',showNextStage:'Esta orientación solo aparece dentro del panel, no en la página pública.',metaDomainVerification:'Pega solo el valor del atributo content que entrega Meta. Se publica en la cabecera de la página de inicio; no es un token de acceso a la API.'};
const storefrontFieldControls={ logo:'storefront-logo-preview', launchApproved:'storefront-launch-approval', showNextStage:'storefront-next-stage-setting', metaDomainVerification:'storefront-meta-verification-field', paymentInfo:'storefront-payment-description' };
const settingsFieldByName=new Map(settingsFields.map(field=>[field.name,{...field,description:settingsHelp[field.name],advisorControl:storefrontFieldControls[field.name]}]));
function StorefrontSettingsForm({settings,all,api,onSettingsChange,onSave,onCommitted,onError,dirty,busy,savedPublication}) {
 const assistant=useAssistantForm({target:'storefront-settings',recordVersion:settings.version,values:settings,dirty,busy,applyPatch:patch=>onSettingsChange(previous=>({...previous,...patch}))});
 async function submit(event) {
  event.preventDefault();
  try { await assistant.submitAssisted({payload:settings,saveUnassisted:onSave,onCommitted}); }
  catch(cause) { onError(cause.message); }
 }
 const saving=busy||assistant.assistantBusy;
 const publicationChange=Boolean(settings.launchApproved)!==savedPublication;
 const publicationChoice=settings.launchApproved?'publicar la vitrina':'volver a modo preparación';
 return <form className={`settings-form ${configurationStyles.vitrinaForm}`} onSubmit={submit} aria-busy={saving} aria-describedby="vitrina-form-help">
  <div className={configurationStyles.formIntro}><div><strong tabIndex={-1} data-advisor-control="storefront-settings-intro">{savedPublication?'Estado guardado: vitrina publicada':'Estado guardado: modo preparación'}</strong><p id="vitrina-form-help">Confirma con «Guardar configuración». No hay guardado automático.</p></div></div>
  <nav className={configurationStyles.formIndex} aria-label="Secciones de datos de la vitrina">{settingsGroups.map((group,index)=><button type="button" className="button subtle" key={group.key} onClick={()=>{const heading=document.getElementById(`settings-${group.key}`);heading?.focus({preventScroll:true});heading?.scrollIntoView({block:'start'});}}><span aria-hidden="true">{index+1}</span>{group.action}</button>)}</nav>
  <fieldset className="auth-fieldset" disabled={saving}>
   {settingsGroups.map(group=><section className="settings-group" key={group.key} aria-labelledby={`settings-${group.key}`}>
    <h2 id={`settings-${group.key}`} tabIndex={-1} data-advisor-control={group.key==='identity'||group.key==='contact'?`storefront-${group.key}-form`:undefined}>{group.title}</h2><p className={configurationStyles.groupDescription}>{group.description}</p>
    <div className="settings-fields">{group.fields.map(name=><div className={`settings-field settings-field--${name}`} key={name}><Field field={settingsFieldByName.get(name)} value={settings[name]} onChange={value=>onSettingsChange(previous=>({...previous,[name]:value}))} all={all} api={api}/></div>)}</div>
    {group.key==='contact'&&<div className="whatsapp-preview" aria-labelledby="whatsapp-preview-title"><h3 id="whatsapp-preview-title" tabIndex={-1} data-advisor-control="storefront-whatsapp-sample">Mensaje de ejemplo</h3><p>{String(settings.whatsappTemplate||'').replaceAll('{producto}','producto de ejemplo')}</p><small>Solo es texto de ejemplo: no se envía ni responde automáticamente. {'{producto}'} se sustituye por la referencia al abrir la consulta en la vitrina.</small></div>}
    {group.key==='publication'&&<p className="small muted">Al guardar con «Publicar la vitrina» activado, la página pública mostrará los contenidos publicados y guardados. Desactivarlo vuelve a mostrar la preparación. No publica borradores, compra un dominio ni conecta pagos.</p>}
   </section>)}
   <div className="settings-save-bar"><span className="small" role="status">{busy?'Guardando configuración…':publicationChange?`Selección pendiente: ${publicationChoice} al guardar.`:dirty?'Cambios sin guardar':'Configuración al día'}</span><button type="button" className="button subtle" disabled={saving} onClick={assistant.openAssistant}>Ayúdame con este formulario</button><button type="submit" className="button primary">{busy?'Guardando…':'Guardar configuración'}<Icon name="check" size={16}/></button></div>
  </fieldset>
 </form>;
}

function AssistantTargetAcknowledger({request,onHandled}) {
 const bridge=useAssistantBridge();
 useEffect(()=>{
  if(!request||request.open.owner!=='admin'||(!request.open.target.startsWith('record:')&&request.open.target!=='storefront-settings'))return;
  const form=bridge.snapshot().find(item=>item.target===request.open.target&&(item.entityId??null)===(request.open.entityId??null)&&item.recordVersion===request.expectedVersion);
  if(form)onHandled(request.requestId,{stayHere:true});
 },[request,bridge.revision,bridge.snapshot,onHandled]);
 return null;
}
export default function Admin({csrf,user}) {
 const params=useSearchParams();
 const [view,setView]=useState(()=>readAdminView(params));
 const [resources,setResources]=useState(initialResources),[settingsResource,setSettingsResource]=useState(blankResource),[ordersResource,setOrdersResource]=useState(blankResource),[cashAction,setCashAction]=useState(null);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[query,setQueryInput]=useState(view.q),[editing,setEditing]=useState(null),[opening,setOpening]=useState(null),[busy,setBusy]=useState(false),[interaction,setInteraction]=useState({dirty:false,busy:false}),[userRevision,setUserRevision]=useState(0);
 const [workspaceInteraction,setWorkspaceInteraction]=useState({dirty:false,busy:false}),[businessRevision,setBusinessRevision]=useState(0),[workspaceEpoch,setWorkspaceEpoch]=useState(0),[assistantOpen,setAssistantOpen]=useState(false),[assistantOpenRequest,setAssistantOpenRequest]=useState(null),[assistantMutation,setAssistantMutation]=useState(false);
 const [advisorRequest,setAdvisorRequest]=useState(null);
 const [advisorTaskRequest,setAdvisorTaskRequest]=useState(null),[advisorTaskId,setAdvisorTaskId]=useState(null),[advisorTargetRequest,setAdvisorTargetRequest]=useState(null);
 const advisorTarget=useRef(null),advisorHandoff=useRef(null),advisorOrderSearch=useRef(null);
 const [advisorOverlay,setAdvisorOverlay]=useState(null),[catalogFocus,setCatalogFocus]=useState(null);
 const [assistantConsoleRequest,setAssistantConsoleRequest]=useState(null);
 const [preferenceRevision,setPreferenceRevision]=useState(0);
 const workspaceRoot=useRef(null),catalogFocusRef=useRef(null),catalogOpeningSequence=useRef(0);
 const accepted=useRef(view),settingsSnapshot=useRef(''),searchTimer=useRef(null),searchGeneration=useRef(0),navigationHandler=useRef(null),guardState=useRef(null),reads=useRef({}),inFlight=useRef({}),openingSequence=useRef(0),resourcesRef=useRef(resources);
 const auxiliaryProduct=useRef(null);
 const historyPosition=useRef(null),historyRestoring=useRef(false);
 const writeHistory=useCallback((href,{replace=false}={})=>{
  const previousState=window.history.state,stored=previousState?.allNutritionAdminIndex;
  const current=historyPosition.current??(Number.isSafeInteger(stored)?stored:0),next=replace?current:current+1;
  historyPosition.current=next;
  // Let Next synchronize the URL, then retain framework state even before its history patch mounts.
  window.history[replace?'replaceState':'pushState'](null,'',href);
  window.history.replaceState({...previousState,...window.history.state,allNutritionAdminIndex:next},'',href);
 },[]);
 const editorInteractionRef=useRef(interaction),workspaceInteractionRef=useRef(workspaceInteraction);
 const [advisorInteraction,setAdvisorInteraction]=useState({dirty:false,busy:false});
 const advisorInteractionRef=useRef(advisorInteraction);
 const personalInteractionRef=useRef({preferences:null,recommendations:null});
 const [,refreshPersonalInteraction]=useState(0);
 const editingRef=useRef(editing),assistantMutationRef=useRef(false),assistantOpeningSequence=useRef(0),assistantOpenRequestRef=useRef(assistantOpenRequest);
 editingRef.current=editing;assistantOpenRequestRef.current=assistantOpenRequest;
 const settings=settingsResource.data;
 const all=useMemo(()=>Object.fromEntries(contentKeys.filter(key=>resources[key].records!==null).map(key=>[key,resources[key].records])),[resources]);
 const setSettings=value=>setSettingsResource(previous=>({...previous,data:typeof value==='function'?value(previous.data):value}));
 const updateContent=useCallback((kind,patch)=>{const next={...resourcesRef.current,[kind]:{...resourcesRef.current[kind],...patch}};resourcesRef.current=next;setResources(next);},[]);
 const section=view.section;
 const assistantView=useMemo(()=>{
  const orderList=view.section==='orders'&&(!view.tab||view.tab==='list');
  if(editing?.kind==='orders')return readAdminView({...(orderList?view:{section:'orders',tab:'list'}),record:editing.record?.id??'new'});
  return orderList&&view.record?readAdminView({...view,record:null}):view;
 },[view,editing]);
 const sectionInfo=adminSections.find(item=>item.id===section),sectionLabel=sectionInfo?.label;
 const isConfiguration=sectionInfo?.area==='business';
 const configurationTask=isConfiguration?adminTasks.find(task=>isCurrentAdminTask(task,view)):null;
 const configurationHome=isConfiguration&&section==='business'&&(!view.tab||view.tab==='setup');
 const settingsDirty=Boolean(settings&&JSON.stringify(settings)!==settingsSnapshot.current);
 const savedPublication=useMemo(()=>settingsSnapshot.current?Boolean(JSON.parse(settingsSnapshot.current).launchApproved):false,[settingsSnapshot.current]);
 const giftView=section==='products'&&view.productType==='gift';
 const personalBusy=Boolean(personalInteractionRef.current.preferences?.busy||personalInteractionRef.current.recommendations?.busy);
 const preferenceDirty=Boolean(personalInteractionRef.current.preferences?.dirty);
 guardState.current={rootBusy:busy,settingsDirty:section==='settings'&&settingsDirty,busy:busy||editorInteractionRef.current.busy||workspaceInteractionRef.current.busy||advisorInteractionRef.current.busy||personalBusy||assistantMutationRef.current,dirty:editorInteractionRef.current.dirty||workspaceInteractionRef.current.dirty||advisorInteractionRef.current.dirty||preferenceDirty||(section==='settings'&&settingsDirty)};
 const syncGuard=useCallback(()=>{
  const state=guardState.current;
  const personal=personalInteractionRef.current;
  state.busy=Boolean(state.rootBusy||editorInteractionRef.current.busy||workspaceInteractionRef.current.busy||advisorInteractionRef.current.busy||personal.preferences?.busy||personal.recommendations?.busy||assistantMutationRef.current);
  state.dirty=Boolean(state.settingsDirty||editorInteractionRef.current.dirty||workspaceInteractionRef.current.dirty||advisorInteractionRef.current.dirty||personal.preferences?.dirty);
 },[]);
 const reportInteraction=useCallback(state=>{editorInteractionRef.current=state;setInteraction(state);syncGuard();},[syncGuard]);
 const reportWorkspaceInteraction=useCallback(state=>{workspaceInteractionRef.current=state;setWorkspaceInteraction(state);syncGuard();},[syncGuard]);
 const reportAdvisorInteraction=useCallback(state=>{advisorInteractionRef.current=state;setAdvisorInteraction(state);syncGuard();},[syncGuard]);
 const reportPersonalInteraction=useCallback((kind,state)=>{
  const previous=personalInteractionRef.current[kind];
  if(previous?.dirty===state.dirty&&previous?.busy===state.busy)return;
  personalInteractionRef.current[kind]=state;syncGuard();refreshPersonalInteraction(value=>value+1);
 },[syncGuard]);
 const reportPreferences=useCallback(state=>reportPersonalInteraction('preferences',state),[reportPersonalInteraction]);
 const reportRecommendations=useCallback(state=>reportPersonalInteraction('recommendations',state),[reportPersonalInteraction]);
 const businessChanged=useCallback(()=>setBusinessRevision(value=>value+1),[]);
 const api=useCallback(async(path,options={})=>{
  const {responseType='json',...init}=options,headers=new Headers(init.headers);
  headers.set('x-csrf-token',csrf);
  if(typeof init.body==='string'&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  const response=await fetch(path,{...init,cache:'no-store',headers});
  if(response.status===401){window.location.assign('/admin/login?next='+encodeURIComponent(adminReturnTo(window.location.pathname+window.location.search)));const cause=new Error('Sesión vencida.');cause.status=401;throw cause;}
  const isJSON=(response.headers.get('content-type')||'').includes('application/json');
  if(!response.ok){
   const data=isJSON?await response.json():null,cause=new Error(data?.error||'No se pudo completar la operación.');
   cause.status=response.status;cause.code=data?.code;
   if((path==='/api/admin/assistant/inbox'||path==='/api/admin/assistant/preferences')&&data?.current)cause.current=data.current;
   throw cause;
  }
  if(responseType==='blob'){
   if(isJSON){const data=await response.json();throw new Error(data.error||'El servidor no devolvió el archivo esperado.');}
   return response.blob();
  }
  if(!isJSON)throw new Error('El servidor no devolvió una respuesta JSON válida.');
  return response.json();
 },[csrf]);
 const advisor=useAdvisorInbox(api,{sessionKey:csrf,showList:section==='home'&&view.issue!=='attention',revision:businessRevision});
 const advisorRequestHandled=useCallback(id=>setAdvisorRequest(current=>current?.id===id?null:current),[]);
 const advisorTaskRequestHandled=useCallback(id=>setAdvisorTaskRequest(current=>current?.id===id?null:current),[]);
 const advisorTargetHandled=useCallback((id,errorMessage)=>{
  const pending=advisorTarget.current;
  if(pending?.id!==id)return;
  advisorTarget.current=null;clearTimeout(pending.timer);setAdvisorTargetRequest(null);
  if(errorMessage)setError(errorMessage);
  else if(pending.taskId){
   if(pending.capabilityId==='orders.ship-order')setAdvisorTaskId(pending.taskId);
   const {capabilityId,taskId,view,focus,selection}=pending;
   advisorHandoff.current={capabilityId,taskId,view,focus,selection};
  }
  pending.resolve(!errorMessage);
 },[]);
 const catalogFocusSettled=useCallback((id,found)=>{
  const pending=catalogFocusRef.current;
  if(pending?.id!==id)return;
  catalogFocusRef.current=null;setCatalogFocus(null);
  if(!found){
   setError(`Abrí ${adminLocationLabel(pending.view)}, pero no encontré un control disponible para «${pending.label}». ${pending.prerequisite}`);
   if(pending.fromDirectory&&accepted.current===pending.origin)setAdvisorOverlay('directory');
  }
  pending.resolve(found);
 },[]);
 useEffect(()=>{
  if(catalogFocus?.editor&&catalogFocus.editor!==editing)catalogFocusSettled(catalogFocus.id,false);
 },[catalogFocus,editing,catalogFocusSettled]);
 useEffect(()=>()=>{const pending=advisorTarget.current;if(pending){clearTimeout(pending.timer);pending.resolve(false);advisorTarget.current=null;}},[]);
 useEffect(()=>{
  if(advisorTargetRequest?.focus!=='order-search'||section!=='orders'||(view.tab||'list')!=='list')return;
  const control=advisorOrderSearch.current;
  if(!control)return;
  control.focus();
  advisorTargetHandled(advisorTargetRequest.id,document.activeElement!==control?'No se pudo enfocar la búsqueda de pedidos.':undefined);
 },[advisorTargetRequest,section,view.tab,advisorTargetHandled]);
 const loadContent=useCallback((kind,afterSave=false)=>{
  const sequence=reads.current[kind]=(reads.current[kind]||0)+1;
  updateContent(kind,{loading:true,error:''});
  const pending=(async()=>{try{
   const data=await api('/api/admin/'+kind);
   if(sequence===reads.current[kind])updateContent(kind,{records:data.records,loading:false,error:''});
   return data.records;
  }catch(cause){
   if(sequence===reads.current[kind])updateContent(kind,{loading:false,error:afterSave?'El cambio se guardó, pero no pudimos actualizar esta vista. '+cause.message:cause.message});
   throw cause;
  }finally{if(inFlight.current[kind]===pending)delete inFlight.current[kind];}})();
  inFlight.current[kind]=pending;
  return pending;
 },[api,updateContent]);
 const loadSettings=useCallback(async()=>{
  const sequence=reads.current.settings=(reads.current.settings||0)+1;
  setSettingsResource(previous=>({...previous,loading:true,error:''}));
  try{const data=await api('/api/admin/settings');if(sequence===reads.current.settings){setSettingsResource({data,loading:false,error:''});settingsSnapshot.current=JSON.stringify(data);}}
  catch(cause){if(sequence===reads.current.settings)setSettingsResource(previous=>({...previous,loading:false,error:cause.message}));}
 },[api]);
 const loadOrders=useCallback(async(target,{afterSave=false,corrected=false}={})=>{
  const key='orders:list';
  const sequence=reads.current[key]=(reads.current[key]||0)+1;
  const update=patch=>setOrdersResource(previous=>({...previous,...patch}));
  update({loading:true,error:''});
  try{
   const q=new URLSearchParams({page:String(target.page||1),q:target.q||'',status:target.status||'',paymentStatus:target.paymentStatus||''});
   for(const key of ['seller','platform','source','carrier','account','product','issue'])if(target[key])q.set(key,target[key]);
   const data=await api('/api/admin/orders?'+q);
   if(sequence!==reads.current[key])return;
   const maximum=Math.max(1,Math.ceil(data.total/data.pageSize));
   if((target.page||1)>maximum&&!corrected){
    const next=readAdminView({...target,section:'orders',page:maximum});
    if(accepted.current.section==='orders'&&adminHref(accepted.current)===adminHref(target)){
     accepted.current=next;setView(next);setQueryInput(next.q);writeHistory(adminHref(next),{replace:true});
    }else void loadOrders(next,{afterSave,corrected:true});
    return;
   }
   if(sequence===reads.current[key])update({data,loading:false,error:''});
  }catch(cause){if(sequence===reads.current[key])update({loading:false,error:afterSave?'El cambio se guardó, pero no pudimos actualizar esta vista. '+cause.message:cause.message});}
 },[api,writeHistory]);
 useEffect(()=>{
  if(schemas[section])void loadContent(section).catch(()=>{});
 },[section,loadContent]);
 useEffect(()=>{void loadSettings();},[loadSettings]);
 useEffect(()=>{
  if(section==='orders'&&(!view.tab||view.tab==='list'))void loadOrders(view);
  return()=>{reads.current['orders:list']=(reads.current['orders:list']||0)+1;};
 },[section,view.tab,view.q,view.status,view.paymentStatus,view.page,view.seller,view.platform,view.source,view.carrier,view.account,view.product,view.issue,businessRevision,loadOrders]);
 function cancelSearch(){clearTimeout(searchTimer.current);searchGeneration.current++;}
 function allowExit(){
  if(guardState.current.busy){setError('Espera a que termine el guardado o la subida.');return false;}
  if(guardState.current.dirty&&!window.confirm('Hay cambios sin guardar. ¿Descartarlos y continuar?'))return false;
  if(guardState.current.dirty){if(settingsSnapshot.current)setSettings(JSON.parse(settingsSnapshot.current));setUserRevision(n=>n+1);if(workspaceInteractionRef.current.dirty||advisorInteractionRef.current.dirty)setWorkspaceEpoch(n=>n+1);}
  setEditing(null);setCashAction(null);reportInteraction({dirty:false,busy:false});reportWorkspaceInteraction({dirty:false,busy:false});reportAdvisorInteraction({dirty:false,busy:false});guardState.current={rootBusy:false,settingsDirty:false,dirty:false,busy:false};
  return true;
 }
 function acceptView(candidate,{replace=false,fromHistory=false,check=true}={}) {
  cancelSearch();
  const next=readAdminView(candidate),href=adminHref(next);
  if(check&&!allowExit())return false;
  setAdvisorOverlay(null);
  if(catalogFocusRef.current){const pending=catalogFocusRef.current;catalogFocusRef.current=null;setCatalogFocus(null);pending.resolve(false);}
  if(advisorTarget.current&&adminHref(advisorTarget.current.view)!==href)advisorTargetHandled(advisorTarget.current.id,'Se cambió de vista antes de abrir el control.');
  if(advisorHandoff.current&&adminHref(advisorHandoff.current.view)!==href)advisorHandoff.current=null;
  openingSequence.current++;setOpening(null);
  accepted.current=next;setView(next);setQueryInput(next.q);setError('');setNotice('');
  if(!fromHistory)writeHistory(href,{replace});
  return true;
 }
 navigationHandler.current=()=>acceptView(new URLSearchParams(window.location.search),{fromHistory:true});
 useEffect(()=>{
  if(historyPosition.current===null)writeHistory(adminHref(accepted.current),{replace:true});
  const pop=event=>{
   if(historyRestoring.current){historyRestoring.current=false;event.stopImmediatePropagation();return;}
   const previous=historyPosition.current,target=event.state?.allNutritionAdminIndex;
   if(navigationHandler.current()){
    historyPosition.current=Number.isSafeInteger(target)?target:0;
    if(!Number.isSafeInteger(target)&&window.location.pathname==='/admin')writeHistory(adminHref(accepted.current),{replace:true});
   }else{
    event.stopImmediatePropagation();
    // Restore the traversed entry; replacing its URL would erase the previous destination.
    historyRestoring.current=true;
    window.history.go(Number.isSafeInteger(target)&&target!==previous?previous-target:1);
   }
  };
  window.addEventListener('popstate',pop,true);
  return()=>{window.removeEventListener('popstate',pop,true);clearTimeout(searchTimer.current);};
 },[writeHistory]);
 const paramString=params.toString();
 useEffect(()=>{
  if(historyRestoring.current)return;
  if(paramString!==new URLSearchParams(window.location.search).toString())return;
  const next=readAdminView(params),href=adminHref(next);
  if(href!==adminHref(accepted.current)){if(!navigationHandler.current())writeHistory(adminHref(accepted.current),{replace:true});}
  else if(window.location.pathname+window.location.search!==href)writeHistory(href,{replace:true});
 },[paramString,writeHistory]);
 useEffect(()=>{document.querySelector('[data-admin-section-heading]')?.focus();},[section,view.tab,giftView]);
 useEffect(()=>{
  const label=adminLocationLabel(view)+(isConfiguration?' · Configuración':'');
  document.title=label+' | All Nutrition';
 },[view.section,view.tab,giftView,isConfiguration]);
 useEffect(()=>{const unload=event=>{if(guardState.current.dirty||guardState.current.busy){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[]);
 const proposalRequestId=()=>globalThis.crypto?.randomUUID?.()||`assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`;
 const reviseProposal=useCallback(({proposal,payload,formBinding,humanAcknowledgements,requestId})=>api(`/api/admin/assistant/proposals/${encodeURIComponent(proposal.id)}`,{method:'POST',body:JSON.stringify({decision:'revise',version:proposal.version,requestId:requestId||proposalRequestId(),formBinding,payload,humanAcknowledgements})}),[api]);
 const cancelProposal=useCallback(({proposal})=>api(`/api/admin/assistant/proposals/${encodeURIComponent(proposal.id)}`,{method:'POST',body:JSON.stringify({decision:'cancel',version:proposal.version,requestId:proposalRequestId()})}),[api]);
 const executeProposal=useCallback(async(proposal,confirmation)=>{
  assistantMutationRef.current=true;setAssistantMutation(true);syncGuard();
  try{return await api(`/api/admin/assistant/proposals/${encodeURIComponent(proposal.id)}`,{method:'POST',body:JSON.stringify({decision:'execute',version:proposal.version,requestId:proposal.id,confirmation})});}
  finally{assistantMutationRef.current=false;setAssistantMutation(false);syncGuard();}
 },[api,syncGuard]);
 const receiveAssistantReceipt=useCallback(async({receipt})=>{
  businessChanged();
  if(receipt.target.startsWith('record:')){
   const kind=receipt.target.slice('record:'.length);
   if(accepted.current.section===kind)await loadContent(kind,true).catch(cause=>setError(cause.message));
   else updateContent(kind,{records:null,loading:false,error:''});
  }
 },[businessChanged,loadContent,updateContent]);
 const assistantOpenHandled=useCallback((requestId,{stayHere=false}={})=>{
  if(assistantOpenRequestRef.current?.requestId!==requestId)return;
  assistantOpenRequestRef.current=null;
  setAssistantOpenRequest(current=>current?.requestId===requestId?null:current);
  if(!stayHere)setAssistantOpen(true);
 },[]);
 const handleProposalOpen=useCallback(async request=>{
  const descriptor=request?.open;
  if(!descriptor?.view||!request.proposalId)return;
  const sequence=++assistantOpeningSequence.current;
  try{
   const response=await api(`/api/admin/assistant/proposals/${encodeURIComponent(request.proposalId)}`),proposal=response.proposal;
   if(sequence!==assistantOpeningSequence.current)return;
   if(response.receipt){setNotice('Este cambio ya está guardado. Consulta su comprobante en Ali.');return;}
   if(!proposal||proposal.open.target!==descriptor.target||proposal.open.entityId!==descriptor.entityId)throw new Error('La propuesta cambió. Vuelve a consultar su estado.');
   const destination=readAdminView(proposal.open.view),current=editingRef.current;
   const sameEditor=current&&((proposal.target===`record:${current.kind}`&&(current.record?.id??null)===(proposal.entityId??null))||(current.kind==='orders'&&(proposal.open.refs?.order?.id??proposal.entityId)===(current.record?.id??null)));
   if(!sameEditor&&!acceptView(destination))return;
   const opening={requestId:request.requestId,proposalId:proposal.id,open:proposal.open,expectedVersion:proposal.recordVersion};
   setAssistantOpen(false);setAssistantOpenRequest(opening);
  }catch(cause){if(sequence===assistantOpeningSequence.current)setError(cause.message);}
 },[api]);
 const navigate=key=>acceptView(typeof key==='string'?{section:key}:key);
 function openAdvisorOverlay(next,{keepConsole=false}={}){
  if(guardState.current.busy)return false;
  if(!keepConsole)setAssistantOpen(false);
  setAdvisorOverlay(next);return true;
 }
 function followAdvisorRecommendation(task){
  if(accepted.current.section!=='home'||!task?.id)return;
  setAdvisorTaskRequest({id:crypto.randomUUID(),kind:'tasks',taskId:task.id});
 }
 function requestAdvisor(kind,taskId=null){
  if(!acceptView({section:'home'}))return false;
  setAdvisorRequest({id:crypto.randomUUID(),kind,taskId});
  setAssistantOpen(false);
  return true;
 }
 function requestAdvisorTask(kind,sourceRef,taskId,decision){
  if(!acceptView({section:'home'}))return false;
  setAdvisorTaskRequest({id:crypto.randomUUID(),kind,sourceRef,taskId,decision});setAssistantOpen(false);return true;
 }
 function followAdvisorImport({batchId,taskId}){
  return requestAdvisorTask('resolve-import',batchId?{kind:'import',id:batchId}:undefined,taskId);
 }
 const nativeAdvisorMutation=useCallback(async event=>{
  businessChanged();
  const handoff=advisorHandoff.current, selection=handoff?.selection;
  const matching=event?.type==='import'&&handoff?.capabilityId==='imports.resolve-issues'&&selection?.batchId===event.batchId
    ||event?.type==='cash'&&handoff?.capabilityId==='cash.close-day'&&(handoff.focus==='cash-close-account'||selection?.id===event.accountId)
    ||event?.type==='shipment'&&handoff?.capabilityId==='orders.ship-order'&&selection?.id===event.shipmentId;
  if(!matching)return;
  const path='/api/admin/assistant/tasks/'+encodeURIComponent(handoff.taskId);
  try{
   const {version}=await api(path);
   await api(path,{method:'PATCH',body:JSON.stringify({version,action:'resume'})});
  }catch(cause){
   if(cause.status!==404&&cause.status!==409&&cause.code!=='ASSISTANT_DISABLED')setNotice('El registro se consultó en su control. Vuelve a Mis tareas para comprobar el avance de Ali.');
  }
 },[api,businessChanged]);
 async function openAdvisorTarget({taskId,...candidate}){
  const resolved=validateAdvisorTarget(candidate);
  if(!resolved||advisorTarget.current||!acceptView(resolved.view))return false;
  setAssistantOpen(false);
  if(resolved.focus===null)return true;
  const destination=accepted.current;
  const request={...resolved,id:crypto.randomUUID()};
  const opened=await new Promise(resolve=>{
   advisorTarget.current={...request,taskId,resolve,timer:setTimeout(()=>advisorTargetHandled(request.id,taskId?'No pudimos comprobar la apertura del control. Tu tarea sigue guardada.':'No pudimos comprobar la apertura del control. No se ejecutó ninguna acción.'),20000)};
   setAdvisorTargetRequest(request);
  });
  if(!opened&&advisorOverlay==='directory'&&accepted.current===destination)setAdvisorOverlay('directory');
  return opened;
 }
 function focusCatalogControl(capability,focus,view,editor,context={}){
  if(catalogFocusRef.current)return false;
  setAssistantOpen(false);
  return new Promise(resolve=>{
   const request={id:crypto.randomUUID(),view,focus,label:capability.label,prerequisite:capability.prerequisite,origin:accepted.current,fromDirectory:advisorOverlay==='directory',editor,...context,resolve};
   catalogFocusRef.current=request;setCatalogFocus(request);
  });
 }
 async function openCatalogAction({id}={}){
  const origin=accepted.current,editor=editingRef.current,sequence=++catalogOpeningSequence.current;
  try{
   const {getAssistantCapability}=await import('../lib/assistant/capabilities.mjs');
   if(sequence!==catalogOpeningSequence.current||origin!==accepted.current)return false;
   const capability=getAssistantCapability(id);
   if(!capability)return false;
   if(id==='advisor.directory')return openAdvisorOverlay('directory');
   if(id==='assistant.proposal-confirm-form'){
    const scope=workspaceRoot.current;
    const drawer=scope?.closest('.admin-shell')?.querySelector('dialog[open].editor-drawer');
    const controls=(drawer||scope)?.querySelectorAll('[data-assistant-bound-save]:not(:disabled)');
    if(guardState.current.busy||controls?.length!==1){
     setError('Aplica primero los valores a su formulario exacto. Ali no guarda ni confirma al abrir el control.');
     return false;
    }
    setError('');setAdvisorOverlay(null);
    return focusCatalogControl(capability,capability.destination.focus,origin,editor);
   }
   if(['assistant.thread-list','assistant.thread-new','assistant.thread-open','assistant.thread-delete','assistant.open-console','assistant.suggested-message','assistant.ask','assistant.literal-draft','assistant.answer-question','assistant.continue-running','assistant.extend-analysis','assistant.stop-analysis','assistant.context-destination','assistant.read-records','assistant.sources','assistant.proposal-review','assistant.proposal-form','assistant.proposal-apply','assistant.proposal-rebase','assistant.proposal-confirm','assistant.proposal-cancel','assistant.receipt','assistant.thread-follow-up'].includes(id)){
    if(guardState.current.busy)return false;
    setAdvisorOverlay(null);
    setAssistantConsoleRequest({id,token:sequence});
    setAssistantOpen(true);
    return true;
   }
   if(id==='advisor.preferences'||id==='advisor.preferences-save'||id==='advisor.preferences-reset')return openAdvisorOverlay('preferences');
   if(id==='advisor.reminder')return requestAdvisor('reminder');
   if(id.startsWith('advisor.reminder-'))return requestAdvisor('reminders');
   if(id==='advisor.task-start')return requestAdvisorTask('choose');
   if(id==='advisor.task-cancel'||id==='advisor.task-delete')return requestAdvisorTask('tasks',undefined,advisorTaskId,id==='advisor.task-cancel'?'cancel':'delete');
   if(id.startsWith('advisor.task-')||id==='advisor.review-follow-up')return requestAdvisorTask('tasks');
   if(id==='orders.ship-order'&&advisor.availability==='ready'){
    const source=origin.section==='orders'&&(origin.tab||'list')==='list'&&origin.record&&origin.record!=='new'?{kind:'order',id:origin.record}:undefined;
    return requestAdvisorTask('ship-order',source);
   }
   if(id==='cash.close-day'&&advisor.availability==='ready')return requestAdvisorTask('close-cash');
   if(id==='imports.resolve-issues'&&advisor.availability==='ready'&&origin.section==='orders'&&origin.tab==='imports'&&origin.batch&&origin.batch!=='new')
    return requestAdvisorTask('resolve-import',{kind:'import',id:origin.batch});
   const destination=capability.destination;
   const same=origin.section===destination.view.section&&(!origin.tab||!destination.view.tab||origin.tab===destination.view.tab);
   if(isShipmentCatalogTarget(id)){
    const drawer=workspaceRoot.current?.querySelector('dialog[open][data-shipment-id][data-shipment-version]');
    if(origin.section!=='orders'||origin.tab!=='shipments'||!origin.record||drawer?.dataset.shipmentId!==origin.record){
     setError('Abre primero la guía exacta en Seguimiento de envíos.');
     return false;
    }
    if(guardState.current.busy||guardState.current.dirty){
     setError('Guarda o cancela los cambios de la guía antes de consultar otra acción.');
     return false;
    }
    return openAdvisorTarget({capabilityId:id,view:origin,focus:destination.focus,selection:{kind:'shipment',id:origin.record,version:Number(drawer.dataset.shipmentVersion)}});
   }
   let next=readAdminView(same?{...origin,...destination.view}:destination.view);
   if(id==='home.sign-out')next=origin;
   let focus=destination.focus;
   const measurementAction=['advertising.read-account-measurement','advertising.define-account-measurement','advertising.save-account-measurement','advertising.verify-account-measurement-source','advertising.open-meta-events-manager','advertising.read-account-analysis'].includes(id);
   const reuseAccountMeasurement=measurementAction&&origin.section==='advertising'&&origin.tab==='results'&&!origin.record&&origin.source!=='meta';
   if(measurementAction)next=reuseAccountMeasurement?origin:readAdminView({...destination.view,record:null});
   const exactClassic=['heka.classic-pair','heka.classic-revoke','heka.classic-confirm-identity','heka.classic-query','heka.classic-query-status','heka.classic-read-capture','heka.classic-prepare-import'].includes(id);
   const reuseClassic=exactClassic&&origin.section==='business'&&origin.tab==='shipping'&&Boolean(origin.record);
   if(exactClassic){
    if(reuseClassic)next=origin;
    else focus='heka-classic-connection-list';
   }
   const officialSettings=['heka.settings-status','heka.settings-docs','heka.settings-test','heka.settings-production','heka.settings-check','heka.settings-disconnect'].includes(id);
   const reuseOfficialSettings=officialSettings&&origin.section==='business'&&origin.tab==='shipping';
   if(id==='heka.settings-test'||id==='heka.settings-production'){
    if(!reuseOfficialSettings||!workspaceRoot.current?.querySelector(`[data-advisor-control="${focus}"]`))focus='heka-official-environment';
   }
   let reusePersonObligation=false;
   if(personObligationActions.has(id)){
    const drawer=origin.section==='business'&&origin.tab==='people'&&workspaceRoot.current?.querySelector('dialog[open].editor-drawer');
    if(drawer){
     if(!drawer.matches('[data-person-id]')||!drawer.querySelector(`[data-advisor-control="${focus}"]`)){
      setError('Conserva la ficha abierta y abre la persona exacta antes de cambiar un convenio.');
      return false;
     }
     reusePersonObligation=true;
     next=origin;
    }else focus+='-person';
   }
   const importOriginAction=id==='imports.create-origin'||id==='imports.create-source';
   if(id==='imports.create-source'&&(origin.section!=='orders'||origin.tab!=='imports'||origin.batch!=='new'||!workspaceRoot.current?.querySelector('[data-advisor-control="import-origin-choice"]')?.value)){
    focus='import-origin-choice';
   }
   const savedImportReview=savedImportReviewFocus.has(focus);
   const importCommit=id==='imports.apply-review';
   if(importCommit)focus=workspaceRoot.current?.querySelector('[data-import-commit-control]')?'import-native-commit':'import-acceptance-review';
   const importAcceptance=id==='imports.review-confirmation'||importCommit;
   const reuseSavedImportControl=savedImportControls.has(focus);
   const savedImportMapping=savedImportMappingFocus.has(focus);
   if(savedImportReview||savedImportMapping||importAcceptance||reuseSavedImportControl){
    if(origin.section!=='orders'||origin.tab!=='imports'||!origin.batch||origin.batch==='new'){
     setError('Elige primero el lote exacto en Importaciones. Ali no escoge un archivo por ti.');
     return false;
    }
    if(guardState.current.busy||savedImportReview&&guardState.current.dirty){
     setError('Termina o descarta los cambios de esta importación antes de volver a la revisión guardada.');
     return false;
    }
    if(focus==='import-original-date-consent'||focus==='import-heka-package-choice'){
     const controls=workspaceRoot.current?.querySelectorAll(`[data-advisor-control="${focus}"]:not(:disabled)`);
     if(controls?.length!==1){
      setError(focus==='import-original-date-consent'?'Filtra por la operación que tiene la fecha exacta o usa «Conservar fecha del archivo» junto a esa celda. Ali no elige entre varias fechas.':'Abre los importes originales del paquete Heka exacto. Ali no incluye ni excluye paquetes.');
      return false;
     }
    }
    next=origin;
   }
   const reuseImportInventory=id==='imports.edit-product-count';
   if(reuseImportInventory){
    const auxiliary=auxiliaryProduct.current;
    if(origin.section!=='orders'||origin.tab!=='imports'||!origin.batch||auxiliary?.batchId!==origin.batch||!auxiliary.productId||editor?.kind!=='products'||editor.record?.id!==auxiliary.productId){
     setError('Abre «Revisar conteo» para el producto exacto en la revisión del lote. Ali no elige una referencia ni propone existencias.');
     return false;
    }
    next=origin;
    focus='product-stock-count';
   }
   const reuseImportResolution=exactImportResolutionControls.has(focus);
   if(reuseImportResolution){
    if(origin.section!=='orders'||origin.tab!=='imports'||!origin.batch
      ||!workspaceRoot.current?.querySelector(`dialog[open] [data-advisor-control="${focus}"]`)){
     setError('Abre primero la resolución de la fila, referencia u operación exacta en la revisión Excel. Ali no elige la ubicación ni el registro por ti.');
     return false;
    }
    next=origin;
   }
   if(id==='heka.open-linked-shipment'&&origin.section==='orders'&&origin.tab==='heka'){
    next=origin;
    focus='heka-linked-shipment';
   }
   const hekaCatalog=next.section==='orders'&&next.tab==='heka';
   const inHeka=hekaCatalog&&origin.section==='orders'&&origin.tab==='heka';
   const hekaDrawer=inHeka&&workspaceRoot.current?.querySelector('dialog[open].editor-drawer');
   const reuseHeka=inHeka&&(!hekaDrawer||hekaDrawer.querySelector(`[data-advisor-control="${focus}"]`));
   if(!hekaDrawer&&id==='heka.issue-guide')focus='heka-guide-review';
   if(!hekaDrawer&&id==='heka.submit-novelty-solution')focus='heka-novelty-review';
   if(!hekaDrawer&&(id==='heka.find-local-order'||id==='heka.link-guide'))focus='heka-link-guide-start';
   const lookupFallback=focus==='heka-novelty-review'?'heka-novelty-search':['heka-link-guide-start','heka-linked-shipment'].includes(focus)?'heka-guide-search':hekaLookupFallback.get(id);
   if(lookupFallback&&(!reuseHeka||!workspaceRoot.current?.querySelector(`[data-advisor-control="${focus}"]`)))focus=lookupFallback;
   const nativeCampaignHandoff=campaignNativeHandoffs.get(id);
   const inPlaceCampaignControl=inPlaceCampaignControls.get(id);
   const campaignControl=localCampaignCatalogFocus.get(id)||nativeCampaignHandoff||inPlaceCampaignControl;
   let campaignVersion,reuseCampaign=false,reviewUnapprovedPublication=false;
   if(campaignControl){
    const campaignView=origin.section==='advertising'&&origin.tab==='campaigns'&&origin.source!=='meta';
    const localResults=origin.section==='advertising'&&origin.tab==='results'&&origin.source!=='meta';
    const selection=(campaignView||localResults)&&origin.record!=='new'?origin.record:null;
    const newStudio=campaignView&&origin.record==='new',localList={section:'advertising',tab:'campaigns'};
    const opening=id==='advertising.open-campaign',openingMeta=id==='advertising.open-meta-publication',creating=id==='advertising.create-draft',choosingMode=id==='advertising.choose-publication-mode';
    const draftEditor=newStudio&&workspaceRoot.current?.querySelector('[data-campaign-draft-editor="new"]');
    focus=campaignControl;
    if(creating||choosingMode&&!selection){
     next=newStudio?origin:readAdminView({...localList,record:'new'});
     if(!draftEditor)focus=newStudio&&workspaceRoot.current?.querySelector('[data-advisor-control="ad-campaign-choose-mode"]')?'ad-campaign-choose-mode':'ad-campaign-skip';
    }else if(selection){
     next=campaignView?origin:readAdminView({...localList,record:selection});
     const saved=await api(`/api/admin/social/campaigns/${encodeURIComponent(selection)}`);
     if(sequence!==catalogOpeningSequence.current||origin!==accepted.current)return false;
     if(saved.id!==selection||!Number.isSafeInteger(saved.version))throw new Error('No se pudo comprobar la versión de la publicación.');
     if(paidCampaignControls.has(id)&&saved.mode!=='paid'){
      setError('Abre un borrador pagado en Publicaciones y campañas. No se ha cambiado la modalidad de este borrador.');
      return false;
     }
     if(inPlaceCampaignControl&&saved.applicationMode!=='same'){
      setError('Abre el borrador exacto de «Cambiar esta publicación o campaña», no la publicación de origen.');
      return false;
     }
     if(nativeCampaignHandoff&&(saved.applicationMode==='same'||guardState.current.dirty)){
      setError('Abre la publicación de origen sin cambios pendientes. Ali no envía ni autoriza acciones en Meta.');
      return false;
     }
     if(!opening&&!openingMeta&&!nativeCampaignHandoff&&!inPlaceCampaignControl&&(saved.state!=='draft'||saved.applicationMode==='same'||saved.revisions?.length)){
      setError('Abre un borrador ordinario editable. No se cambiará una revisión aprobada ni una entrega existente.');
      return false;
     }
     if(id==='advertising.cancel-local-work'&&(saved.mode!=='organic'||saved.deliveries?.length||saved.operations?.length||saved.preflight||guardState.current.dirty)){
      setError('Solo se puede abrir la cancelación de un borrador orgánico local y sin cambios pendientes. No se ha solicitado ninguna pausa.');
      return false;
     }
     if(id==='advertising.plan-organic-schedule'&&saved.mode!=='organic'){
      setError('El borrador abierto es pagado. La agenda orgánica no cambia su modalidad.');
      return false;
     }
     campaignVersion=saved.version;
     reviewUnapprovedPublication=id==='advertising.publish-organic-now'&&saved.state==='draft';
    }else if(opening||id==='advertising.publish-organic-now'){
     next=campaignView?readAdminView({...origin,record:null,studio:null}):readAdminView(localList);
     focus='Buscar y filtrar publicaciones';
    }else if(draftEditor&&!openingMeta&&!nativeCampaignHandoff&&!inPlaceCampaignControl&&!paidCampaignControls.has(id)&&id!=='advertising.update-draft'&&id!=='advertising.cancel-local-work')next=origin;
    else{
     setError('Abre primero el borrador exacto en Publicaciones y campañas. Ali no elige la publicación ni guarda cambios por ti.');
     return false;
    }
    reuseCampaign=campaignView&&adminHref(next)===adminHref(origin);
   }
   if(id==='advisor.open-notice-source'||id==='advisor.notice-unsnooze'){
    const home=origin.section==='home'?origin:destination.view;
    next=readAdminView({...home,issue:null,status:null,...(home.issue==='attention'?{page:1}:{})});
   }
   if(id==='advertising.read-asset')focus=same&&origin.record?'advertising-asset-details':'Buscar y filtrar imágenes y videos';
   if(id==='cash.reopen-closing'&&(!same||!origin.account||!origin.record)){
    setError('Abre primero el cierre exacto en Cierres históricos. Ali no elige ni reabre un cierre por ti.');
    return false;
   }
   const settlementDraft=/^cash\.(?:search|add|remove)-settlement-(?:collections?|expenses?)$/.test(id);
   const settleCreate=id==='cash.declare-settlement',settleCorrect=id==='cash.correct-settlement';
   const settleSaved=settleCorrect||id.startsWith('cash.confirm-settlement-')||id==='cash.reverse-settlement'||id==='cash.reverse-settlement-receipt';
   const settlementDialog=(settlementDraft||settleCreate||settleSaved)&&same&&workspaceRoot.current?.querySelector('dialog[open].editor-drawer');
   const declaration=settlementDialog?.dataset?.cashSettlementForm==='declaration'?settlementDialog:null;
   const reuseSettlement=Boolean(declaration&&(settlementDraft||settleCreate&&!declaration.dataset.cashSettlementId||settleCorrect&&declaration.dataset.cashSettlementId===origin.record));
   if(settlementDraft&&!reuseSettlement||settleSaved&&(!same||!origin.record)||settlementDialog&&!reuseSettlement){
    setError('Abre la declaración exacta de Liquidaciones y conserva los cambios de cualquier otro formulario antes de continuar.');
    return false;
   }
   if((settlementDraft||settleCreate||settleSaved)&&same)next=origin;
   if(reuseSettlement){
    const has=control=>declaration.querySelector(`[data-advisor-control="${control}"]`);
    if(settleCreate)focus='cash-settlement-declaration-source';
    else if(settleCorrect)focus='cash-settlement-declaration-reason';
    else if(id==='cash.remove-settlement-expense'&&!has(focus)){
     if(has('cash-settlement-choose-deduction'))focus='cash-settlement-choose-deduction';
     else if(has('cash-settlement-choose-collection'))focus='cash-settlement-choose-collection';
    }else if(['cash.remove-settlement-collection','cash.search-settlement-expenses','cash.add-settlement-expense'].includes(id)&&has('cash-settlement-choose-collection'))focus='cash-settlement-choose-collection';
   }
   const payrollConfirm=id==='cash.confirm-payroll';
   const openPayrollReview=payrollConfirm&&same&&workspaceRoot.current?.querySelector('dialog[open] [data-advisor-control="cash-payroll-confirm-period"]');
   if(payrollConfirm&&!openPayrollReview&&(!same||!origin.record)){
    setError('Prepara un período de sueldo o abre uno guardado. Ali no confirma obligaciones ni realiza pagos.');
    return false;
   }
   if(['cash.pay-payroll','cash.part-pay-payroll','cash.reverse-payroll-payment','cash.reverse-payroll-applications'].includes(id)&&(!same||!origin.record)){
    setError('Abre primero el período exacto en Sueldos y anticipos. Ali no elige el sueldo ni cambia sus pagos.');
    return false;
   }
   if(id==='cash.reverse-advance'&&(!same||!origin.record)){
    setError('Abre el movimiento exacto del anticipo. Ali no elige ni revierte un desembolso.');
    return false;
   }
   if(id==='cash.preview-closing'&&!(same&&origin.account))focus='cash-close';
   if(id==='advertising.archive-asset'){
    if(!same||!origin.record){
     setError('Abre primero el archivo exacto de la biblioteca. Ali no selecciona ni archiva archivos por ti.');
     return false;
    }
    focus='advertising-asset-archive';
   }
   const exactLibraryAsset=id==='advertising.open-original-asset'||id==='advertising.retry-asset-processing';
   if(exactLibraryAsset){
    if(origin.section!=='advertising'||origin.tab!=='assets'||!origin.record
      ||!workspaceRoot.current?.querySelector(`[data-advisor-control="${focus}"]:not(:disabled)`)){
     setError('Abre el archivo exacto de la biblioteca y comprueba que esta acción está disponible. Ali no elige el archivo.');
     return false;
    }
    next=origin;
   }
   const assetUpload=id==='advertising.choose-upload-file'||id==='advertising.upload-private-asset';
   const assetName=id==='advertising.assist-asset-name';
   const openAssetUpload=(assetUpload||assetName)&&same&&workspaceRoot.current?.querySelector('dialog[open][aria-labelledby="advertising-library-upload"]');
   if(assetUpload){
    next=openAssetUpload?origin:readAdminView({...next,record:null});
    focus=!openAssetUpload?'advertising-asset-upload':id==='advertising.upload-private-asset'&&openAssetUpload.querySelector('[data-advisor-control="advertising-asset-submit"]:enabled')?'advertising-asset-submit':'advertising-asset-picker';
   }
   if(assetName)next=openAssetUpload?origin:readAdminView({...next,record:null});
   if(homeReportActions.has(id)){
    const cash=id==='home.cash-records', home=origin.section==='home'?origin:null;
    next=readAdminView({...destination.view,period:cash?'month':home?.period||'month',anchor:cash?bogotaDate():home?.anchor||bogotaDate()});
    focus=destination.view.issue==='missing'?'report-live-missing-records':'report-live-metric-records';
   }
   if(id==='home.coverage-task'){
    if(origin.section==='reports'&&origin.mode!=='saved'&&origin.record&&origin.issue==='missing'){
     next=origin;focus='report-live-missing-records';
    }else if(origin.section==='home'){
     next=readAdminView({...origin,issue:'attention'});
     focus='dashboard-attention-list';
    }else{
     setError('En Inicio, abre «Toda la atención pendiente» y elige «Completar registros» en el pendiente exacto.');
     return false;
    }
   }
   const accountIntent=cashAccountHandoffs.has(id)?id:null;
   if(accountIntent)focus='business-account-operation-choice';
   const reviewingPolicy=id==='business.accept-saved-policy';
   const openPolicyReview=reviewingPolicy&&same&&workspaceRoot.current?.querySelector('dialog[open] [data-advisor-control="settings-preferences-policy-acknowledgement"]');
   if(reviewingPolicy&&!openPolicyReview)focus='settings-business-preferences';
   const shipmentEvent=shipmentEventActions.has(id);
   if(shipmentEvent){
    if(!same||!origin.record){
     setError('Abre primero la guía exacta en Seguimiento de envíos. Ali no elige ni registra el estado.');
     return false;
    }
    focus=id==='shipments.rectify-event'?'shipment-event-correction':id==='shipments.classify-event-opening'?'shipment-event-opening':'shipment-event-state';
    if(id==='shipments.classify-event-opening'&&!workspaceRoot.current?.querySelector('dialog[open] [data-advisor-control="shipment-event-opening"]')){
     setError('Indica primero la fecha de este evento. La aclaración solo se pide si coincide con el conteo o si no conoces el día.');
     return false;
    }
   }
   const elapsedComparison=id==='reports.view-elapsed-comparison-detail';
   const homeObservation=homeObservationActions.has(id);
   if((reportObservationActions.has(id)||homeObservation||elapsedComparison)&&origin.section!=='reports'){
    if(origin.section!=='home'){
     setError('Elige el período en Inicio y revisa si contiene esta observación.');
     return false;
    }
    const query=new URLSearchParams({period:origin.period||'month',anchor:origin.anchor||bogotaDate()});
    const summary=await api(`/api/admin/dashboard?${query}`);
    if(sequence!==catalogOpeningSequence.current||origin!==accepted.current)return false;
    const {record,issue,tab}=destination.view;
    const exact=reportObservationActions.has(id)||Boolean(issue);
    const insights=summary.insights;
    const observations=[...insights.improvements.slice(0,3),...insights.successes.slice(0,3)];
    const visible=exact?observations:[...observations,...insights.notes];
    const matches=(candidate)=>candidate?.section==='reports'&&(elapsedComparison?candidate.issue==='comparison_elapsed':candidate.record===record&&candidate.tab===tab&&(!exact||candidate.issue===issue));
    const views=new Map(visible.map(item=>item.action?.view).filter(matches).map(candidate=>{
     const view=readAdminView({...candidate,...(origin.anchor?{anchor:origin.anchor}:{})});
     return [adminHref(view),view];
    }));
    if(views.size!==1){
     setError(views.size?'Hay varios criterios en este corte. Elige el criterio exacto con «Ver registros» en Inicio.':'El corte de Inicio no contiene esa observación con datos suficientes.');
     return false;
    }
    [next]=views.values();
    focus=next.issue==='comparison_elapsed'?'report-comparison-elapsed-records':next.issue==='missing'?'report-live-missing-records':'report-live-metric-records';
   }
   if(origin.section==='reports'&&(elapsedComparison||homeObservation)){
    const {record,issue,tab}=destination.view;
    const exact=Boolean(issue);
    if(origin.mode==='saved'||(elapsedComparison?origin.issue!=='comparison_elapsed'||!origin.record:origin.record!==record||origin.tab!==tab||exact&&origin.issue!==issue)){
     setError('Elige primero la observación exacta y abre sus registros en datos actuales.');
     return false;
    }
    next=origin;
    focus=origin.issue==='comparison_elapsed'?'report-comparison-elapsed-records':origin.issue==='missing'?'report-live-missing-records':'report-live-metric-records';
   }
   if(id==='shipments.open-shipment'&&(!same||!origin.record)){
    setError('Abre primero la guía exacta desde Seguimiento de envíos.');
    return false;
   }
   if(id==='alerts.episode'&&(!same||!origin.record)){
    setError('Elige primero el episodio exacto con «Ver episodio» en Configuración → Alertas.');
    return false;
   }
   const alertSource=alertSources.get(id),editingAttention=id==='alerts.acknowledge'||id==='alerts.assign';
   if(editingAttention||alertSource){
    if(origin.section!=='business'||origin.tab!=='alerts'||!origin.record){
     setError('Elige primero el episodio exacto con «Ver episodio» en Configuración → Alertas.');
     return false;
    }
    const episode=await api(`/api/admin/alerts/${encodeURIComponent(origin.record)}`);
    if(sequence!==catalogOpeningSequence.current||origin!==accepted.current)return false;
    if(episode.id!==origin.record)return false;
    if(alertSource){
     const view=episode.action?.view;
     const target=alertSource.type?view?.[alertSource.key||'record']:episode.action?.orderId;
     if(!target||alertSource.type&&(episode.entityType!==alertSource.type||view.section!==alertSource.section||view.tab!==alertSource.tab||target!==episode.entityId)){
      setError('El episodio elegido no identifica ese tipo de registro. Revisa la fuente que muestra la alerta.');
      return false;
     }
     next=readAdminView({...view,section:alertSource.section,tab:alertSource.tab,...(!alertSource.type?{record:target}:null)});
     focus=alertSource.focus;
    }else{
     if(episode.state==='resolved'||id==='alerts.acknowledge'&&episode.state!=='open'){
      setError(id==='alerts.acknowledge'?'Solo una alerta abierta puede ponerse en atención.':'Una alerta resuelta no se puede reasignar.');
      return false;
     }
     focus='alert-attention-editor';
    }
   }
   if(id.startsWith('alerts.rule-'))next=same?origin:readAdminView({...destination.view,issue:null});
   if(campaignEvidenceActions.has(id)){
    if(origin.section!=='advertising'||!['campaigns','results'].includes(origin.tab)||!origin.record||origin.record==='new'||origin.source==='meta'){
     setError('Abre primero la publicación exacta en Campañas o Resultados.');
     return false;
    }
    if(!same)next=readAdminView({...destination.view,record:origin.record});
   }
   if(id==='advertising.find-results'){
    next=origin.section==='advertising'&&origin.tab==='results'&&origin.source!=='meta'?readAdminView({...origin,record:null,resultsFocus:null,page:1}):destination.view;
    focus='ad-results-search';
   }
   if(['advertising.compare-result-forecast','advertising.review-measurement-gap','advertising.review-business-gap'].includes(id)){
    if(origin.section!=='advertising'||origin.tab!=='results'||origin.source==='meta'||!origin.record){
     setError('Abre la ficha exacta en Resultados antes de revisar su evidencia. Ali no elige ni consulta Meta por ti.');
     return false;
    }
    next=origin;
    if(id==='advertising.review-measurement-gap')focus='ad-results-refresh';
   }
   if(id==='advertising.list-private-pieces'||id==='advertising.resume-private-piece'){
    next=readAdminView({section:'advertising',tab:'campaigns',...(origin.section==='advertising'&&origin.tab==='campaigns'&&origin.source!=='meta'?origin:{}),record:null,studio:null,mode:null,objective:null});
    focus='ad-private-pieces';
   }
   if(id==='advertising.read-legacy-generation-history'){
    next=readAdminView({...next,record:null});
    focus='ad-legacy-generation-history';
   }
   const studioControl=creativeStudioControls.get(id);
   const reuseCreativeStudio=studioControl&&origin.section==='advertising'&&origin.tab==='campaigns'&&origin.record==='new'&&!origin.mode;
   if(studioControl){
    if((id==='advertising.read-generation-progress'||id==='advertising.adjust-image')&&(!reuseCreativeStudio||!origin.studio)){
     setError('Abre primero la pieza exacta en el estudio creativo. Ali no selecciona una imagen ni inicia una solicitud.');
     return false;
    }
    if(reuseCreativeStudio)next=origin;
    focus=studioControl;
   }
   const inventoryControl=metaInventoryControls.get(id);
   if(inventoryControl){
    if(origin.section!=='advertising'||origin.tab!=='campaigns'||origin.source!=='meta'||!origin.account||!origin.metaCampaign){
     setError('Abre primero la campaña exacta y su cuenta en Campañas consultadas en Meta.');
     return false;
    }
    const needsReading=id==='advertising.read-meta-inventory-adsets'||id==='advertising.open-meta-inventory-counterpart';
    if(needsReading&&(!origin.connection||!origin.snapshot)){
     setError('Elige primero la lectura guardada exacta. Ali no elige una lectura por ti.');
     return false;
    }
    if(id==='advertising.open-meta-inventory-counterpart'&&workspaceRoot.current?.querySelector('[data-advisor-control="ad-meta-inventory-campaign"]')&&!workspaceRoot.current.querySelector('[data-advisor-control="ad-meta-inventory-counterpart"]')){
     setError('La lectura guardada no acredita un vínculo único con una ficha de All Nutrition.');
     return false;
    }
    next=origin;
    focus=inventoryControl;
   }
   const accountAnalysisControl=accountAnalysisControls.get(id);
   if(accountAnalysisControl){
    if(origin.section!=='advertising'||origin.tab!=='results'||origin.record||origin.source==='meta'||!workspaceRoot.current?.querySelector('[data-account-analysis-connection]')){
     setError('Elige primero la conexión exacta en «Resultados de una cuenta Meta».');
     return false;
    }
    next=origin;focus=accountAnalysisControl;
   }
   const recommendationControl=resultRecommendationControls.get(id)||(id==='advertising.sync-results-from-meta'?'ad-results-sync-meta':null);
   if(recommendationControl){
    if(origin.section!=='advertising'||origin.tab!=='results'||origin.source==='meta'||!origin.record){
     setError('Abre la campaña exacta en Resultados antes de revisar su análisis o sus recomendaciones.');
     return false;
    }
    if(id==='advertising.assist-result-action-reason'&&!workspaceRoot.current?.querySelector('dialog[open][data-ad-results-action-dialog] [data-advisor-control="ad-results-action-reason"]:not(:disabled)')){
     setError('Abre primero la acción exacta que exige un motivo en Resultados.');
     return false;
    }
    next=origin;
    focus=recommendationControl;
   }
   const resultLinkVerb=/^advertising\.(find-(?:order|expense)-to-link|(?:link|unlink)-(?:order|expense)|(?:rectify|reassign)-(?:order|expense)-link)$/.exec(id)?.[1];
   const reuseResultLink=Boolean(resultLinkVerb);
   if(reuseResultLink){
    if(origin.section!=='advertising'||origin.tab!=='results'||origin.source==='meta'||!origin.record){
     setError('Abre la ficha exacta en Resultados para buscar registros que puedas vincular.');
     return false;
    }
    next=origin;
    const kind=resultLinkVerb.includes('order')?'order':'expense';
    const searchControl=`ad-results-link-search-${kind}`;
    const dialog=workspaceRoot.current?.querySelector('dialog[open][data-ad-results-link-dialog]');
    if(dialog&&dialog.dataset.adResultsLinkDialog!==kind){
     setError('Cierra el diálogo de vínculo que está abierto antes de elegir otro tipo de registro.');
     return false;
    }
    if(resultLinkVerb.startsWith('rectify-')||resultLinkVerb.startsWith('unlink-')){
     if(!dialog?.querySelector('[data-advisor-control="ad-results-link-remove"]')){
      setError('Elige el registro exacto en «Rectificar o retirar vínculo» antes de continuar.');
      return false;
     }
     focus=resultLinkVerb.startsWith('unlink-')?'ad-results-link-remove':'ad-results-link-reason';
    }else{
     const confirmation=resultLinkVerb.startsWith('reassign-')?'ad-results-link-reassign':resultLinkVerb.startsWith('link-')?'ad-results-link-confirm':null;
     focus=dialog?(confirmation&&dialog.querySelector(`[data-advisor-control="${confirmation}"]`)?confirmation:searchControl):`ad-results-link-${kind}`;
    }
   }
   const linkedResult=id==='advertising.open-linked-order'||id==='advertising.open-linked-expense';
   if(linkedResult){
    if(origin.section!=='advertising'||origin.tab!=='results'||origin.source==='meta'||!origin.record){
     setError('Abre primero la campaña exacta en Resultados para elegir el registro vinculado.');
     return false;
    }
    next=origin;
    focus=id.endsWith('order')?'ad-results-linked-order':'ad-results-linked-expense';
   }
   if(id==='advertising.open-advertising-expenses')focus='cash-expense-list';
   if(!destination.view.record&&(next.section==='home'||id.startsWith('products.list')||id==='orders.find'))next=readAdminView({...next,record:null});
   if(origin.section==='reports'&&id==='reports.view-snapshot'){
    next=readAdminView({...origin,...destination.view,record:null,issue:null,page:origin.mode==='saved'&&!origin.record?origin.page:1});
   }
   if(id==='reports.remove-filter'){
    if(origin.section!=='reports'||origin.record){
     setError('Abre una consulta editable con el filtro que quieres quitar.');
     return false;
    }
    next=origin;
   }
   if(origin.section==='reports'&&id==='reports.view-payroll'){
    const snapshot=origin.mode==='saved'&&origin.record;
    next=readAdminView({...origin,...destination.view,mode:snapshot?'saved':null,record:snapshot||null,issue:null,page:1});
   }
   if(id==='reports.view-live'||id==='reports.view-saved-list'){
    const queryView=origin.section==='reports'&&!origin.record?origin:destination.view;
    next=readAdminView({...queryView,...destination.view,mode:id==='reports.view-saved-list'?'saved':null,record:null,issue:null,page:1});
   }
   if(origin.section==='reports'&&reportContextFocus.has(destination.focus)){
    if(!destination.view.record)next=origin;
    else{
     if(origin.mode==='saved'){
      setError('Abre los datos actuales del período antes de consultar este desglose.');
      return false;
     }
     next=readAdminView({...origin,...destination.view,mode:null,page:1});
    }
   }
   if(['cash.filter-by-period','cash.search-records','cash.clear-filters','cash.remove-filter'].includes(id)&&origin.section==='cash'&&origin.tab&&origin.tab!=='overview')next=readAdminView({...origin,record:null,page:1});
   if(selectedExpenseActions.has(id)&&(!same||!origin.record)){
    setError('Abre primero el gasto exacto en Caja → Gastos. Ali no elige ni aplica pagos por ti.');
    return false;
   }
   const inlineResponsible=id==='cash.create-inline-responsible',importedExpenseReview=id==='cash.correct-imported-expense';
   const cashForm=(inlineResponsible||importedExpenseReview)&&workspaceRoot.current?.querySelector('dialog[open].editor-drawer');
   const expenseId=importedExpenseReview&&same&&origin.record?CSS.escape(origin.record):null;
   const reuseCashForm=Boolean(inlineResponsible&&cashForm?.querySelector('[data-advisor-control="finance-form-create-person"]')
     ||expenseId&&cashForm?.querySelector(`[data-cash-expense-review-id="${expenseId}"]`));
   if(inlineResponsible){
    if(!(origin.section==='cash'||origin.section==='business'&&origin.tab==='accounts')||!reuseCashForm){
     setError('Abre primero el formulario de Caja o de Cuentas en el que quieres seleccionar a la persona. Ali no crea ni guarda por ti.');
     return false;
    }
    next=origin;
   }
   if(importedExpenseReview){
    if(!expenseId||(cashForm&&!reuseCashForm)||!workspaceRoot.current?.querySelector(`[data-cash-imported-expense-review="${expenseId}"]`)){
     setError('Abre el gasto importado exacto en Caja → Gastos y revisa su soporte. Ali no marca la confirmación.');
     return false;
    }
    next=origin;
   }
   if(id==='cash.record-and-pay-expense')focus='cash-expense-save-pending';
   if(['cash.reverse-income','cash.reverse-transfer','cash.reverse-adjustment'].includes(id)){
    if(!same||!origin.record){
     setError('Abre primero el movimiento exacto en Caja. Ali no selecciona ni revierte un asiento por ti.');
     return false;
    }
    focus=`cash-movement-reverse-${id.slice('cash.reverse-'.length)}`;
   }
   if(id==='heka.read-journal')return openAdvisorTarget({capabilityId:id,view:next,focus:'heka-operation-journal',selection:null});
   if(['reports.request-copy','reports.check-copy-status','reports.export-live','reports.export-snapshot'].includes(id)){
    const saved=id==='reports.check-copy-status'||id==='reports.export-snapshot', record=id==='reports.export-snapshot'&&origin.mode==='saved'?origin.record:null;
    const queryView=origin.section==='reports'?origin:destination.view;
    next=readAdminView({...queryView,mode:saved?'saved':null,record,issue:null,page:1});
    if(id==='reports.export-snapshot'&&!record){
     if(!acceptView(next))return false;
     setAssistantOpen(false);setNotice('Elige la copia guardada exacta. Solo entonces se puede descargar su Excel.');return true;
    }
    return openAdvisorTarget({capabilityId:id,view:next,focus:destination.focus,selection:record?{kind:'report',snapshotId:record,metric:null,issue:null}:null});
   }
   if(id==='advertising.duplicate-campaign'||id==='advertising.publish-organic-now'&&(!campaignVersion||reviewUnapprovedPublication)){
    let selection=null;
    if(next.source==='meta'||next.record==='new')next=readAdminView(destination.view);
    if(next.record&&campaignVersion)selection={kind:'campaign',id:next.record,version:campaignVersion};
    else if(next.record){
     const record=await api(`/api/admin/social/campaigns/${encodeURIComponent(next.record)}`);
     if(sequence!==catalogOpeningSequence.current||origin!==accepted.current)return false;
     const campaign=record.campaign||record;
     if(campaign.id!==next.record||!Number.isSafeInteger(campaign.version))throw new Error('No se pudo comprobar la versión de la campaña.');
     selection={kind:'campaign',id:campaign.id,version:campaign.version};
    }
    return openAdvisorTarget({capabilityId:id,view:next,focus:id==='advertising.duplicate-campaign'?'campaign-duplicate':'campaign-publish',selection});
   }
   const orderLegacy=id==='orders.reconcile-legacy-opening'||id==='orders.reconcile-legacy-cash';
   const orderContext=orderLegacy||id==='orders.record-collection-credit'||id==='orders.classify-return-opening';
   const orderExpense=id==='orders.record-expense'||id==='orders.record-and-pay-expense';
   const exactOrderControl=(orderContext||orderExpense)&&same&&editor?.kind==='orders'&&editor.record?.id&&workspaceRoot.current?.closest('.admin-shell')?.querySelector(`dialog[open].editor-drawer [data-advisor-control="${focus}"]`);
   if(orderContext&&!exactOrderControl){
    setError(orderLegacy?'Abre «Conciliar pago histórico» en el pedido exacto. Ali no presupone que el dinero entró.':id==='orders.record-collection-credit'?'Abre el pedido exacto y su formulario de cobro. Ali no marca la autorización de saldo a favor.':'Abre la devolución del pedido y revisa la fecha del conteo. Ali no elige si la mercancía ya estaba incluida.');
    return false;
   }
   const newOrderAction=id==='orders.create-order'||id==='orders.prepare-order';
   if(id==='orders.cancel-order'&&editor?.kind==='orders'&&editor.record?.id&&!workspaceRoot.current?.closest('.admin-shell')?.querySelector('[data-advisor-control="order-cancellation"]'))focus='order-commercial-status';
   const exactAgreement=['orders.update-order','orders.mark-preparing','orders.cancel-order'].includes(id)&&same&&editor?.kind==='orders'&&editor.record?.id&&workspaceRoot.current?.closest('.admin-shell')?.querySelector(`dialog[open].editor-drawer [data-advisor-control="${focus}"]:not(:disabled)`);
   const orderTab=exactAgreement?undefined:orderExpense&&!exactOrderControl?'profit':orderCatalogTabs.get(id);
   if(orderExpense&&!exactOrderControl)focus='order-expense-launch';
   const storefrontVerb=/^storefront\.(?:faq|message|shipping)-(list|open|prepare|create|edit|publish|unpublish|archive|delete)$/.exec(id)?.[1];
   const storefrontKind=storefrontVerb?destination.view.section:null;
   const storefrontNew=storefrontVerb==='prepare'||storefrontVerb==='create';
   const storefrontSaved=Boolean(storefrontKind&&storefrontVerb!=='list'&&!storefrontNew);
   const contentKind=contentCatalogKinds.get(id);
   const createKind=contentCreateKinds.get(id), updateKind=contentUpdateKinds.get(id), prepareContent=id==='products.prepare-record';
   const setPublication=id==='products.set-publication', deleteContent=id.startsWith('products.delete-');
   if((orderTab||exactOrderControl||exactAgreement||newOrderAction||contentKind||createKind||updateKind||prepareContent||setPublication||storefrontKind)&&editor!==editingRef.current)return false;
   const currentOrder=editor?.kind==='orders'?editor:null;
   const reuseOrder=orderTab||exactOrderControl||exactAgreement?Boolean(currentOrder?.record?.id):newOrderAction&&Boolean(currentOrder&&!currentOrder.record);
   if(id==='orders.record-platform-collection'||id==='orders.record-platform-refund'){
    if(!currentOrder?.record?.shipments?.some(shipment=>shipment.sourceId)){
     setError('El pedido debe tener una guía vinculada a una cuenta de plataforma. No se registró dinero.');
     return false;
    }
    focus=id==='orders.record-platform-collection'?'order-business-collection':'order-business-refund';
   }
   const savedContent=savedContentRead.has(id);
   const editorKind=editor?.kind, savedRecord=Boolean(editor?.record?.id);
   if(storefrontSaved&&(!same||editorKind!==storefrontKind||!savedRecord||!Number.isSafeInteger(editor.record.version)||origin.record&&origin.record!==editor.record.id)){
    setError('Abre primero la ficha exacta en el panel y vuelve a Ali desde «Ayúdame con este formulario».');
    return false;
   }
   const reuseStorefront=storefrontSaved||storefrontNew&&same&&editorKind===storefrontKind&&!savedRecord;
   if(storefrontNew&&editor&&!reuseStorefront){
    setError('Guarda o cierra la ficha abierta antes de preparar otra.');
    return false;
   }
   if(storefrontVerb==='list')next=readAdminView({...next,record:null});
   const editorProductType=editorInteractionRef.current.productType??editor?.record?.productType;
   if(normalProductActions.has(id)&&editorKind==='products'&&editorProductType==='gift'){
    setError('Esta acción corresponde a un producto físico, no a un obsequio.');
    return false;
   }
   if(giftProductActions.has(id)&&editorKind==='products'&&(editorProductType!=='gift'||savedRecord&&editor.record?.productType!=='gift')){
    setError('Abre una ficha de obsequio. Ali no cambia el tipo del formulario abierto.');
    return false;
   }
   if(id==='products.create-product'&&!editor&&next.productType==='gift')next=readAdminView({...next,productType:null});
   const reuseContent=reuseStorefront||Boolean(editor&&(editorKind===contentKind&&(!savedContent||savedRecord)
    ||editorKind===createKind&&!savedRecord||editorKind===updateKind&&savedRecord
    ||(setPublication||prepareContent&&!savedRecord)&&['products','combos','catalogs'].includes(editorKind)));
   const reuseImportDraft=same&&origin.section==='orders'&&origin.tab==='imports'&&origin.batch==='new'&&next.batch==='new'&&importDraftFocus.has(destination.focus);
   if(orderTab&&!reuseOrder){setError('Abre primero el pedido exacto en el panel y vuelve a Ali desde «Ayúdame con este formulario».');return false;}
   if((contentKind||updateKind||setPublication)&&!reuseContent){setError('Abre primero la ficha exacta en el panel y vuelve a Ali desde «Ayúdame con este formulario».');return false;}
   const reuseOnboarding=origin.section==='business'&&origin.tab==='setup'&&next.section==='business'&&next.tab==='setup';
   const reuseAssistantSettings=origin.section==='business'&&origin.tab==='assistant'&&next.section==='business'&&next.tab==='assistant'&&id.startsWith('assistant.settings-');
   const reuseMetaSettings=origin.section==='business'&&origin.tab==='social'&&next.section==='business'&&next.tab==='social'
    &&['meta-settings-overview','meta-app-options-form','meta-publishing-enable-control','meta-browser-enable-control','meta-browser-health-detail'].includes(focus);
   if(reuseMetaSettings)next=origin;
   const inSocial=origin.section==='business'&&origin.tab==='social';
   const openingMetaConnection=newMetaConnectionControls.has(focus);
   const [socialAction,socialLaunch]=metaConnectionDialogs.get(id)||[];
   const selectedMetaConnection=selectedMetaConnectionControls.has(focus)||Boolean(socialAction);
   const metaStatus=id==='business.meta-disconnection-status';
   if(id==='business.meta-browser-finish'||id==='business.meta-browser-cancel'){
    const viewer=workspaceRoot.current?.querySelector('dialog[open][data-meta-browser-viewer]');
    if(!inSocial||!origin.record||viewer?.dataset.metaBrowserViewer!==origin.record||guardState.current.busy||!viewer.querySelector(`[data-advisor-control="${focus}"]:enabled`)){
     setError('Abre primero un visor privado activo para la conexión exacta. Solo tú puedes verificar, guardar o cancelar el acceso.');
     return false;
    }
    setError('');setAdvisorOverlay(null);
    return focusCatalogControl(capability,focus,origin,null);
   }
   const reuseSocialConnection=inSocial&&(selectedMetaConnection||metaStatus||openingMetaConnection&&origin.record==='new');
   if(openingMetaConnection)next=reuseSocialConnection?origin:readAdminView({...destination.view,record:'new'});
   if(id==='business.meta-open-results'){
    next=readAdminView({...destination.view,record:null});
    focus='Análisis histórico y contenido actual';
   }
   if(selectedMetaConnection){
    const root=workspaceRoot.current;
    const card=inSocial&&origin.record&&origin.record!=='new'&&root?.querySelector(`article[data-meta-connection-id="${CSS.escape(origin.record)}"]`);
    const dialog=root?.querySelector('dialog[open][data-meta-action]');
    const matchingDialog=socialAction&&dialog?.dataset.metaAction===socialAction&&dialog.dataset.metaConnectionId===origin.record;
    const available=matchingDialog||!dialog&&(card?.querySelector(`[data-advisor-control="${socialLaunch||focus}"]:not(:disabled):not([aria-disabled="true"])`)||(socialAction&&card?.querySelector(`[data-meta-confirm-action="${socialAction}"]:enabled`)));
    if(!available){
     setError('Abre la conexión Meta exacta y revisa que esa acción esté disponible. Ali no elige credenciales ni confirma cambios por ti.');
     return false;
    }
    next=origin;
    if(socialAction==='browser-login')focus='Abrir acceso privado';
   }
   if(metaStatus&&inSocial){
    next=origin;
    if(origin.record&&origin.record!=='new'){
     focus='meta-current-disconnection-status';
     if(!workspaceRoot.current?.querySelector('[data-advisor-control="meta-current-disconnection-status"]')){
      setError('La conexión elegida no muestra una desconexión pendiente. Consulta los recibos desde el listado de conexiones.');
      return false;
     }
    }
   }
   const reuseUserForm=origin.section==='users'&&next.section==='users'&&id==='business.user-create';
   const previewStorefront=id==='storefront.preview';
   if(previewStorefront)next=origin;
   const reuseStorefrontSettings=previewStorefront||origin.section==='settings'&&next.section==='settings'&&focus.startsWith('storefront-');
   if(reuseOrder||reuseContent||reuseImportDraft||savedImportReview||savedImportMapping||importAcceptance||reuseSavedImportControl||reuseImportResolution||reuseImportInventory||shipmentEvent||openPolicyReview||reuseOnboarding||openAssetUpload||exactLibraryAsset||openPayrollReview||reuseCampaign||reuseSettlement||reuseAssistantSettings||reuseMetaSettings||reuseSocialConnection||reuseUserForm||reuseStorefrontSettings||reuseResultLink||linkedResult||reuseCreativeStudio||reuseClassic||reuseOfficialSettings||reuseHeka||reuseCashForm||reusePersonObligation||reuseAccountMeasurement||inventoryControl||recommendationControl||accountAnalysisControl){
    if(guardState.current.busy){
     setError('Espera a que termine el guardado o la subida.');
     return false;
    }
    const deleting=deleteContent||storefrontVerb==='delete';
    if((orderTab||savedContent||deleting||storefrontVerb==='open')&&editorInteractionRef.current.dirty){
     setError(deleting?'Guarda o descarta los cambios de la ficha antes de eliminarla.':'Guarda o descarta los cambios del formulario antes de abrir esta consulta.');
     return false;
    }
    if(catalogFocusRef.current)return false;
    setError('');setAdvisorOverlay(null);
   }else if(!acceptView(next))return false;
   if(!reuseCashForm&&same&&capability.area==='cash'&&next.section==='business'&&next.tab==='accounts'&&workspaceRoot.current?.querySelector('dialog[open].editor-drawer'))setWorkspaceEpoch(value=>value+1);
   return focusCatalogControl(capability,focus,reuseContent?origin:next,reuseOrder||reuseContent||reuseImportInventory?editor:null,
    {orderTab,accountIntent,campaignVersion,socialAction,importStep:importOriginAction?1:savedImportMapping?2:savedImportReview||importAcceptance?3:null});
  }catch(cause){
   if(sequence===catalogOpeningSequence.current)setError(cause.message||'No pudimos abrir esa acción.');
   return false;
  }
 }
 function openAdvisorAction(action){
  if(action.taskId)return requestAdvisor('reminders',action.taskId);
  if(action.orderId)return openEditor('orders',{id:action.orderId});
  if(action.view?.section)return acceptView(action.view);
  return false;
 }
 function setQuery(value){setQueryInput(value);cancelSearch();const generation=searchGeneration.current;searchTimer.current=setTimeout(()=>{if(searchGeneration.current===generation)acceptView({...accepted.current,q:value,page:1},{replace:true,check:false});},200);}
 function changeView(patch){
  if(Object.keys(patch).length===1&&Object.hasOwn(patch,'q')){setQuery(patch.q);return;}
  const resetsPage=query!==accepted.current.q||['q','status','paymentStatus','period','anchor','issue','tab','seller','platform','source','carrier','account','product','productType','category','mode','network','objective','from','to','integrationMethod','scope','dimension'].some(key=>Object.hasOwn(patch,key));
  return acceptView({...accepted.current,q:query,...patch,...(resetsPage?{page:1}:{})});
 }
 function setStudioThread(id){
  const current=accepted.current;
  if(current.section==='advertising'&&(!current.tab||current.tab==='campaigns')&&current.record==='new')acceptView({...current,studio:id},{replace:true,check:false});
 }
 async function openEditor(kind,record){
  if(!allowExit())return false;
  if(query!==accepted.current.q)acceptView({...accepted.current,q:query,page:1},{replace:true,check:false});
  else cancelSearch();
  const sequence=++openingSequence.current,origin=accepted.current.section;
  setOpening({kind,record,loading:true,error:''});
  try{
   await Promise.all((editorDependencies[kind]||[]).map(async key=>{
    if(kind!=='orders'&&resourcesRef.current[key].records!==null&&!resourcesRef.current[key].error)return;
    try{await (inFlight.current[key]||loadContent(key));}catch(cause){throw new Error('No pudimos cargar '+schemas[key].label.toLowerCase()+'. '+cause.message);}
   }));
   const detail=record?.id?await api('/api/admin/'+kind+'/'+encodeURIComponent(record.id)):kind==='orders'?record:{...emptyRecord(kind),...record};
   if(sequence!==openingSequence.current||origin!==accepted.current.section)return false;
   if(!allowExit()){setOpening(null);return false;}
   setOpening(null);setEditing({kind,record:detail||(kind==='orders'?null:emptyRecord(kind)),revision:0});
   return true;
  }catch(cause){
   if(sequence!==openingSequence.current||origin!==accepted.current.section)return false;
   setOpening({kind,record,loading:false,error:cause.message});
   const target=advisorTarget.current;
   if(kind==='orders'&&target?.view.record===(record?.id||'new'))advisorTargetHandled(target.id,cause.message);
  }
 }
 async function configureCash(){
  if(!allowExit())return;setBusy(true);setError('');
  try{
   const {records}=await api('/api/admin/business/accounts'),active=records.filter(account=>account.active);
   if(active.length>1){
    acceptView({section:'business',tab:'accounts'},{check:false});
    setNotice('Elige la cuenta que quieres revisar. Su saldo de apertura no cambia.');
   }else setCashAction({action:'account-save',context:{account:active[0]||null}});
  }
  catch(cause){setError(cause.message);}finally{setBusy(false);}
 }
 useEffect(()=>{
  if(!view.record||!(schemas[section]||section==='orders'&&(!view.tab||view.tab==='list')))return;
  const id=view.record==='new'?null:view.record,current=editingRef.current;
  if(current?.kind===section&&(current.record?.id??null)===id)return;
  void openEditor(section,id?{id}:section==='products'&&view.productType==='gift'?{productType:'gift',orderable:true}:null);
 },[section,view.tab,view.record,view.productType,assistantOpenRequest?.requestId,advisorTargetRequest?.id]);
 async function createProductForImport({productId,batchId,kind='products',productType='product',externalKey=''}={}){
  const title=String(externalKey).trim(),prefill=productId?{id:productId}:{title,slug:slugify(title),status:'draft',orderable:true,...(kind==='products'?{productType}:{})};
  if(!await openEditor(kind,prefill))return null;
  return new Promise(resolve=>{auxiliaryProduct.current={kind,productId,batchId,resolve};});
 }
 async function followNativeOrder(handoff,record,operation){
  if(!handoff?.taskId)return;
  try{
   const path=`/api/admin/assistant/tasks/${encodeURIComponent(handoff.taskId)}`;
   const task=await api(path);
   if(handoff.focus==='order-create'&&operation==='create'&&task.step==='pick-order'){
    const question=task.data.progress?.question;
    if(question)await api(path,{method:'PATCH',body:JSON.stringify({version:task.version,action:'answer',step:task.step,questionId:question.id,field:question.field,value:String(record.number)})});
   }else if(operation==='action'&&handoff.selection?.id===record.id){
    await api(path,{method:'PATCH',body:JSON.stringify({version:task.version,action:'resume'})});
   }
  }catch(cause){setNotice('El pedido está guardado. Retoma la tarea para comprobar su avance: '+cause.message);}
 }
 async function saved({kind,record,operation,keepOpen=false}){
  const handoff=advisorHandoff.current;
  if(!keepOpen){setEditing(null);reportInteraction({dirty:false,busy:false});}
  if(!keepOpen&&accepted.current.section===kind&&accepted.current.record)acceptView({...accepted.current,record:''},{replace:true,check:false});
  if(kind===auxiliaryProduct.current?.kind){const {resolve}=auxiliaryProduct.current;auxiliaryProduct.current=null;resolve(operation==='delete'?null:{...record,kind});}
  businessChanged();
  if(kind==='orders'){
   if(handoff&&(handoff.focus==='order-create'||handoff.focus==='order-shipment-create'))void followNativeOrder(handoff,record,operation);
   setNotice('Pedido AN-'+String(record.number).padStart(6,'0')+' guardado');
   if(accepted.current.section==='orders')void loadOrders(accepted.current,{afterSave:true});
   await Promise.all(['products','combos'].map(key=>loadContent(key,true)));
  }else{
   setNotice(operation==='delete'?'Eliminado: '+record.title:'Guardado: '+record.title+' · '+contentStates.find(state=>state.value===record.status)?.label);
   if(accepted.current.section===kind)void loadContent(kind,true).catch(()=>{});
   else updateContent(kind,{records:null,loading:false,error:''});
  }
 }
 async function persistSettings(payload){setBusy(true);setError('');try{const current=await api('/api/admin/settings',{method:'PUT',body:JSON.stringify(payload)});setSettings(current);settingsSnapshot.current=JSON.stringify(current);setNotice('Configuración guardada.');return current;}finally{setBusy(false);}}
 function retry(key){if(key==='settings')void loadSettings();else void loadContent(key).catch(()=>{});}
 async function signOut(){if(!allowExit())return;setBusy(true);try{await api('/api/auth/logout',{method:'POST'});setBusy(false);guardState.current={dirty:false,busy:false};window.location.assign('/admin/login');}catch(cause){setError(cause.message);setBusy(false);}}
 const closeEditor=()=>{openingSequence.current++;setEditing(null);reportInteraction({dirty:false,busy:false});if(accepted.current.record&&(schemas[accepted.current.section]||accepted.current.section==='orders'&&(!accepted.current.tab||accepted.current.tab==='list')))acceptView({...accepted.current,record:''},{replace:true,check:false});if(auxiliaryProduct.current){const {resolve}=auxiliaryProduct.current;auxiliaryProduct.current=null;resolve(null);}};
 async function reloadEditor(){
  if(!editing?.record?.id||guardState.current.busy)return false;
  if(guardState.current.dirty&&!window.confirm('Hay cambios sin guardar. ¿Descartarlos y cargar la versión guardada?'))return false;
  const current=editing,sequence=++openingSequence.current;
  const record=await api('/api/admin/'+current.kind+'/'+encodeURIComponent(current.record.id));
  if(sequence!==openingSequence.current)return false;
  if(current.kind!=='orders'&&resourcesRef.current[current.kind].records!==null)updateContent(current.kind,{records:resourcesRef.current[current.kind].records.map(row=>row.id===record.id?record:row)});
  setEditing({...current,record,revision:current.revision+1});
  return true;
 }
 return <AssistantBridgeProvider onOpenAssistant={()=>setAssistantOpen(true)} onProposalOpen={handleProposalOpen}
  reviseProposal={reviseProposal} cancelProposal={cancelProposal} executeProposal={executeProposal} onReceipt={receiveAssistantReceipt}>
 <AssistantTargetAcknowledger request={assistantOpenRequest} onHandled={assistantOpenHandled}/>
 <div className="admin-shell">
  <AdminNavigation view={view} user={user} onNavigate={navigate} onCreate={kind=>openEditor(kind,null)} onSignOut={signOut} onOpenAssistant={()=>setAssistantOpen(true)} advisorUnread={advisor.availability==='ready'&&!advisor.offline?advisor.unreadCount:0} interactionLocked={Boolean(editing)||Boolean(cashAction)||guardState.current.busy} showSignOut={catalogFocus?.focus==='admin-sign-out'}/>
  <div className={`admin-main${isConfiguration?' '+configurationStyles.viewport:''}`}><main ref={workspaceRoot} className="admin-content" id="admin-workspace" tabIndex={-1}>
   <AdvisorActionFocus root={workspaceRoot} request={catalogFocus?.editor&&catalogFocus.editor!==editing?null:catalogFocus} onSettled={catalogFocusSettled}/>
   {!['home','reports','cash','advertising'].includes(section)&&<div className="admin-heading"><div><p className="eyebrow">{isConfiguration?(configurationHome?'Administración':'Configuración'):'Mesa de trabajo'}</p><h1 tabIndex="-1" data-admin-section-heading>{configurationHome?'Configuración':section==='settings'?'Datos y publicación de la vitrina':giftView?'Obsequios':configurationTask?.label||sectionLabel}</h1><p>{configurationHome?'Organiza la operación, la vitrina y el acceso al panel.':configurationTask?.description||schemas[section]?.help||(section==='orders'?'Pedidos, envíos y cobros acordados.':'Gestiona los datos de tu negocio.')}</p></div></div>}
   {error&&<div className="error alert" role="alert">{error}<button type="button" className="icon-button" aria-label="Cerrar error" onClick={()=>setError('')}><Icon name="close"/></button></div>}
   {notice&&<div className="success alert" role="status"><Icon name="check"/>{notice}<button type="button" className="icon-button" aria-label="Cerrar aviso" onClick={()=>setNotice('')}><Icon name="close"/></button></div>}
   {opening&&<div className="admin-action-feedback" aria-busy={opening.loading}>{opening.loading?<p role="status">Preparando {opening.record?.title||opening.record?.customerName||'el editor'}…</p>:<div className="error" role="alert">{opening.error}<button type="button" className="text-button" onClick={()=>openEditor(opening.kind,opening.record)}>Reintentar apertura</button></div>}</div>}
   {isConfiguration?<ConfigurationNavigation view={view} onNavigate={navigate} interactionLocked={guardState.current.busy}/>:<AreaNavigation view={view} onNavigate={navigate} interactionLocked={guardState.current.busy}/>}
   {section==='home'&&<AdminOverview api={api} view={view} onViewChange={changeView} onCreateOrder={()=>openEditor('orders',null)} onImport={()=>navigate({section:'orders',tab:'imports'})} onCreateProduct={()=>openEditor('products',null)} onConfigureCash={configureCash} onNavigate={navigate} onOpenOrder={id=>openEditor('orders',{id})} revision={businessRevision}
    advisorAvailable={advisor.availability==='ready'}
    advisor={<><AdvisorInbox key={'inbox:'+workspaceEpoch} resource={advisor} availability={advisor.availability} page={advisor.page} onPage={advisor.setPage} onRetry={advisor.reload} onOpenAction={openAdvisorAction} onFollowImport={followAdvisorImport} onMutation={advisor.reload} api={api} request={advisorRequest} onRequestHandled={advisorRequestHandled} onInteractionStateChange={reportWorkspaceInteraction}/>
      <AdvisorTasks key={'tasks:'+workspaceEpoch} api={api} ready={advisor.availability==='ready'} request={advisorTaskRequest} onRequestHandled={advisorTaskRequestHandled} onOpenTarget={openAdvisorTarget} onMutation={advisor.reload} onSelectTask={setAdvisorTaskId} activeTaskId={advisorTaskId} onInteractionStateChange={reportAdvisorInteraction}/>
      <div className="admin-actions"><button type="button" className="button subtle" onClick={()=>openAdvisorOverlay('directory')}>¿Qué quieres hacer?</button><button type="button" className="button subtle" onClick={()=>openAdvisorOverlay('preferences')}>Mis preferencias</button></div>
      <AdvisorRecommendations api={api} ready={advisor.availability==='ready'&&!advisor.offline} revision={`${businessRevision}:${preferenceRevision}`} onNavigate={openAdvisorTarget} onFollow={followAdvisorRecommendation} onInteractionStateChange={reportRecommendations}/></>}/>}
   {section==='settings'&&<div aria-busy={settingsResource.loading}>{settingsResource.loading&&<p role="status">{settings?'Actualizando…':'Cargando configuración…'}</p>}{!settings&&settingsResource.loading&&<div className="static-skeleton" aria-hidden="true"/>}{settingsResource.error&&<div className="error" role="alert">{settingsResource.error}<button type="button" className="text-button" onClick={()=>retry('settings')}>Reintentar</button></div>}</div>}
   {schemas[section]&&<ContentList kind={section} resource={resources[section]} view={{...view,q:query}} onViewChange={changeView} onCreate={(kind,prefill)=>openEditor(kind,prefill??null)} onEdit={openEditor} onRetry={()=>retry(section)}/>}
   {section==='orders'&&<OrdersWorkspace key={'orders:'+workspaceEpoch} api={api} resource={ordersResource} view={{...view,q:query}} onViewChange={changeView} onNavigate={navigate} onCreate={kind=>openEditor(kind,null)} onEdit={openEditor} onRetry={()=>loadOrders(accepted.current)} onInteractionStateChange={reportWorkspaceInteraction} onCreateProduct={createProductForImport} onMutation={nativeAdvisorMutation} assistantOpenRequest={assistantOpenRequest} onAssistantOpenHandled={assistantOpenHandled} advisorTargetRequest={advisorTargetRequest} onAdvisorTargetHandled={advisorTargetHandled} advisorSearchRef={advisorOrderSearch} catalogRequest={catalogFocus}/>}
   {section==='reports'&&<ReportsWorkspace key={'reports:'+workspaceEpoch} api={api} view={view} onViewChange={changeView} onOpenOrder={id=>openEditor('orders',{id})} onInteractionStateChange={reportWorkspaceInteraction} onMutation={businessChanged} revision={businessRevision} assistantOpenRequest={assistantOpenRequest} onAssistantOpenHandled={assistantOpenHandled} advisorTargetRequest={advisorTargetRequest} onAdvisorTargetHandled={advisorTargetHandled}/>}
   {section==='cash'&&<CashWorkspace key={'cash:'+workspaceEpoch} api={api} view={{...view,q:query}} onViewChange={changeView} onOpenOrder={id=>openEditor('orders',{id})} onNavigate={navigate} onInteractionStateChange={reportWorkspaceInteraction} onMutation={nativeAdvisorMutation} revision={businessRevision} assistantOpenRequest={assistantOpenRequest} onAssistantOpenHandled={assistantOpenHandled} advisorTargetRequest={advisorTargetRequest} onAdvisorTargetHandled={advisorTargetHandled} cashCatalogRequest={catalogFocus?.focus==='cash-expense-confirm-import-review'?catalogFocus:null}/>}
   {section==='advertising'&&<AdvertisingWorkspace key={'advertising:'+workspaceEpoch} api={api} view={{...view,q:query}} onViewChange={changeView} onStudioThread={setStudioThread} onNavigate={navigate} onInteractionStateChange={reportWorkspaceInteraction} onMutation={businessChanged} revision={businessRevision} assistantOpenRequest={assistantOpenRequest} onAssistantOpenHandled={assistantOpenHandled} advisorTargetRequest={advisorTargetRequest} onAdvisorTargetHandled={advisorTargetHandled} assetCatalogRequest={catalogFocus?.focus==='advertising-asset-assist-name'?catalogFocus:null} campaignCatalogRequest={catalogFocus?.view.section==='advertising'&&catalogFocus.view.tab==='campaigns'&&/^ad-(?:campaign|offer|studio|same)-/.test(catalogFocus.focus)?catalogFocus:null}/>}
   {section==='business'&&view.tab==='assistant'&&<AssistantSettings key={'assistant-settings:'+workspaceEpoch} api={api} assistantBusy={assistantMutation} onInteractionStateChange={reportWorkspaceInteraction} onMutation={advisor.reload} onAdvisorDirectory={()=>openAdvisorOverlay('directory')}/>}
   {section==='business'&&view.tab!=='assistant'&&<BusinessSettings key={'business:'+workspaceEpoch} api={api} view={{...view,q:query}} onViewChange={changeView} onOpenOrder={id=>openEditor('orders',{id})} onCreateOrder={()=>openEditor('orders',null)} onNavigate={navigate} onInteractionStateChange={reportWorkspaceInteraction} onMutation={businessChanged} revision={businessRevision} assistantOpenRequest={assistantOpenRequest} onAssistantOpenHandled={assistantOpenHandled} accountCatalogRequest={catalogFocus?.accountIntent?catalogFocus:null} onboardingCatalogRequest={catalogFocus?.view.section==='business'&&catalogFocus.view.tab==='setup'?catalogFocus:null} socialCatalogRequest={catalogFocus?.view.section==='business'&&catalogFocus.view.tab==='social'?catalogFocus:null}/>}
   {section==='settings'&&settings&&<StorefrontSettingsForm key="storefront-settings" settings={settings} all={all} api={api} onSettingsChange={setSettings} onSave={persistSettings} onCommitted={current=>{setSettings(current);settingsSnapshot.current=JSON.stringify(current);setNotice('Configuración guardada.');businessChanged();}} onError={message=>setError(message)} dirty={settingsDirty} busy={busy} savedPublication={savedPublication}/>}
 {section==='users'&&<UserManagement key={userRevision} api={api} onInteractionStateChange={reportInteraction} />}
 </main></div>
 {editing&&editing.kind!=='orders'&&<RecordEditor key={editing.kind+':'+(editing.record.id||'new')+':'+editing.revision} kind={editing.kind} record={editing.record} all={all} api={api} onClose={closeEditor} onSaved={saved} onReload={reloadEditor} onInteractionStateChange={reportInteraction}/>}
 {editing?.kind==='orders'&&<OrderEditor key={(editing.record?.id||'new-order')+':'+editing.revision} record={editing.record} all={all} api={api} onClose={closeEditor} onSaved={saved} onReload={reloadEditor} onInteractionStateChange={reportInteraction} assistantOpenRequest={assistantOpenRequest} onAssistantOpenHandled={assistantOpenHandled} advisorTargetRequest={advisorTargetRequest} onAdvisorTargetHandled={advisorTargetHandled} catalogTab={catalogFocus?.editor===editing?catalogFocus.orderTab:undefined}/>}
 {cashAction&&<BusinessActionDialog action={cashAction.action} context={cashAction.context} api={api} configuration onClose={()=>{setCashAction(null);reportInteraction({dirty:false,busy:false});}} onSaved={record=>{setCashAction(null);reportInteraction({dirty:false,busy:false});businessChanged();setNotice('Cuenta '+record.name+' guardada.'+(record.warnings?.length?' '+record.warnings.join(' '):''));}} onInteractionStateChange={reportInteraction}/>}
 </div>
 <AssistantConsole api={api} view={assistantView} onNavigate={navigate} onReminderRequest={requestAdvisor} advisorReady={advisor.availability==='ready'} onAdvisorTaskRequest={requestAdvisorTask} onAdvisorTasks={()=>requestAdvisorTask('tasks')} onAdvisorDirectory={options=>openAdvisorOverlay('directory',options)} onAdvisorPreferences={()=>openAdvisorOverlay('preferences')} onAdvisorAction={openCatalogAction} advisorTaskId={advisorTaskId} onClearAdvisorTask={()=>setAdvisorTaskId(null)} brandName={settings?.brandName} open={assistantOpen} catalogConsoleRequest={assistantConsoleRequest} onClose={()=>setAssistantOpen(false)}/>
 <AdvisorDirectory api={api} open={advisorOverlay==='directory'} onClose={()=>setAdvisorOverlay(null)} onAdvisorAction={openCatalogAction}/>
 <AdvisorPreferences api={api} open={advisorOverlay==='preferences'} onClose={()=>setAdvisorOverlay(null)} onSaved={()=>{advisor.reload();setPreferenceRevision(value=>value+1);}} onInteractionStateChange={reportPreferences}/>
 </AssistantBridgeProvider>;
}
