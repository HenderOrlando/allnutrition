import { fail, integer, text } from '../validation-core.mjs';
import { adminHref, readAdminView } from '../admin-view.mjs';
import { assistantFormDescriptor, assistantSubmissionFields, filterAssistantPatch, serializeAssistantForm, validateAssistantSubmission } from './forms.mjs';
import { validateAssistantSelection } from './context.mjs';
import { validateAssistantReadRequest } from './read-contracts.mjs';
import { ASSISTANT_LIMITS } from './limits.mjs';
import { businessDate } from '../business/dates.mjs';

const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: objeto inválido.`);
  return value;
};
const exact = (value, keys, label) => {
  object(value, label);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label}: campo no permitido (${key}).`);
  return value;
};
const nullableText = (value, label, max = 200) => value == null ? null : text(value, label, max, true);
const bool = (value, label) => {
  if (typeof value !== 'boolean') fail(`${label}: valor inválido.`);
  return value;
};
const list = (value, label, max, parse) => {
  if (!Array.isArray(value) || value.length > max) fail(`${label}: lista inválida.`);
  return value.map(parse);
};
const safeHref = (value, label, required = false) => {
  if (value == null && !required) return null;
  const href = text(value, label, 2048, required);
  if (!href.startsWith('/admin') || href.startsWith('//') || href.includes('\\')) fail(`${label}: destino no permitido.`);
  const path = href.split(/[?#]/, 1)[0];
  if (path !== '/admin') fail(`${label}: destino no permitido.`);
  const normalized = adminHref(readAdminView(new URLSearchParams(href.split('?', 2)[1] || '')));
  if (normalized !== href) fail(`${label}: destino no normalizado.`);
  return normalized;
};

const assertFiniteNumbers = (value, label, depth = 0) => {
  if (depth > 6) fail(`${label}: estructura demasiado profunda.`);
  if (typeof value === 'number' && !Number.isFinite(value)) fail(`${label}: número no finito.`);
  if (Array.isArray(value)) for (const item of value) assertFiniteNumbers(item, label, depth + 1);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail(`${label}: clave de objeto no permitida.`);
    assertFiniteNumbers(item, label, depth + 1);
  }
};
export const ASSISTANT_PROVIDERS = Object.freeze(['openai', 'openai-compatible', 'gemini']);
export const ASSISTANT_CONNECTION_STATUSES = Object.freeze(['unconfigured', 'unverified', 'ready', 'invalid', 'unavailable']);
export const ASSISTANT_ERROR_CODES = Object.freeze([
  'ASSISTANT_DISABLED', 'ASSISTANT_AUTH_REQUIRED', 'ASSISTANT_CREDENTIAL_INVALID', 'ASSISTANT_CONFIG_CHANGED',
  'ASSISTANT_CONFLICT', 'ASSISTANT_MODEL_UNSUPPORTED', 'ASSISTANT_UNAVAILABLE', 'ASSISTANT_SCOPE_DENIED',
]);
export const ASSISTANT_DOMAINS = Object.freeze(['catalog','orders','shipments','cash','reports','recommendations','business','alerts','imports','advertising','access','application']);
export const ASSISTANT_ERROR_STATUS = Object.freeze({
  ASSISTANT_DISABLED: 409, ASSISTANT_AUTH_REQUIRED: 401, ASSISTANT_CREDENTIAL_INVALID: 503,
  ASSISTANT_CONFIG_CHANGED: 409, ASSISTANT_CONFLICT: 409, ASSISTANT_MODEL_UNSUPPORTED: 422,
  ASSISTANT_UNAVAILABLE: 503, ASSISTANT_SCOPE_DENIED: 403,
});

export function validateAssistantSettings(value) {
  exact(value, ['version','enabled','provider','baseUrl','model','allowPrivateNetwork','hasApiKey','connectionStatus','verifiedAt','authMethod','hasOAuthConnection','projectId'], 'Configuración');
  if (value.provider != null && !ASSISTANT_PROVIDERS.includes(value.provider)) fail('Proveedor inválido.');
  if (!ASSISTANT_CONNECTION_STATUSES.includes(value.connectionStatus)) fail('Estado de conexión inválido.');
  if (!['api-key', 'oauth'].includes(value.authMethod)) fail('Método de autenticación inválido.');
  const dto = {
    version: integer(value.version, 'Versión', 0), enabled: bool(value.enabled, 'Habilitado'),
    provider: value.provider == null ? null : value.provider,
    baseUrl: nullableText(value.baseUrl, 'URL', 2048), model: nullableText(value.model, 'Modelo', 200),
    allowPrivateNetwork: bool(value.allowPrivateNetwork, 'Red privada'), hasApiKey: bool(value.hasApiKey, 'Clave guardada'),
    authMethod: value.authMethod, hasOAuthConnection: bool(value.hasOAuthConnection, 'Cuenta OAuth'),
    projectId: nullableText(value.projectId, 'Proyecto de Google Cloud', 128),
    connectionStatus: value.connectionStatus, verifiedAt: nullableText(value.verifiedAt, 'Verificación', 80),
  };
  if (dto.authMethod === 'oauth' && dto.provider !== 'gemini') fail('OAuth solo está disponible para Google/Gemini.');
  if (dto.projectId && !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,30})$/.test(dto.projectId)) fail('Proyecto de Google Cloud inválido.');
  if (dto.enabled && (!dto.provider || (dto.provider==='openai-compatible' && !dto.baseUrl)
    || !dto.model || (dto.authMethod === 'oauth' ? !dto.hasOAuthConnection || !dto.projectId : !dto.hasApiKey) || dto.connectionStatus !== 'ready')) {
    fail('La configuración activa requiere proveedor, modelo, autenticación y conexión verificada.');
  }
  return dto;
}

export function validateAssistantContext(value) {
  exact(value, ['view','form','selection'], 'Contexto');
  object(value.view, 'Vista');
  const view = readAdminView(value.view);
  const selection = validateAssistantSelection(view, value.selection ?? null);
  if (value.form == null) return { view, form: null, selection };
  const form = exact(value.form, ['formId','target','entityId','recordVersion','generation','values','dirty','busy'], 'Formulario');
  const formId = text(form.formId, 'Identificador del formulario', 100, true);
  const target = text(form.target, 'Destino del formulario', 100, true);
  const entityId = nullableText(form.entityId, 'Entidad', 200);
  const recordVersion = form.recordVersion == null ? null : integer(form.recordVersion, 'Versión del registro', 0);
  const generation = integer(form.generation, 'Generación', 0);
  const supplied = object(form.values, 'Valores del formulario');
  const descriptor = assistantFormDescriptor(target);
  if (!descriptor) fail('Destino de formulario no asistible.');
  const values = serializeAssistantForm(target, supplied);
  for (const key of Object.keys(supplied)) {
    if (!descriptor?.fields.includes(key) || !Object.hasOwn(values, key)) fail(`Campo no permitido en el formulario: ${key}.`);
  }
  for (const [key, item] of Object.entries(supplied)) assertFiniteNumbers(item, key);
  return { view, selection, form: { formId, target, entityId, recordVersion, generation, values, dirty: bool(form.dirty, 'Formulario modificado'), busy: bool(form.busy, 'Formulario ocupado') } };
}

export function validateTurnInput(value) {
  if (value && Object.hasOwn(value, 'continueFromTurnId')) {
    exact(value, ['requestId','threadId','threadVersion','continueFromTurnId'], 'Ampliación');
    return {
      requestId: text(value.requestId, 'Solicitud', 100, true),
      threadId: text(value.threadId, 'Conversación', 100, true),
      threadVersion: integer(value.threadVersion, 'Versión de conversación', 0),
      continueFromTurnId: text(value.continueFromTurnId, 'Turno de origen', 100, true),
    };
  }
  exact(value, ['requestId','threadId','threadVersion','message','context','answer'], 'Turno');
  const requestId = text(value.requestId, 'Solicitud', 100, true);
  const threadId = nullableText(value.threadId, 'Conversación', 100);
  const threadVersion = value.threadVersion == null ? null : integer(value.threadVersion, 'Versión de conversación', 0);
  const message = text(value.message, 'Mensaje', 8000, true);
  if (value.answer == null) return { requestId, threadId, threadVersion, message, context: validateAssistantContext(value.context), answer: null };
  exact(value.answer, ['questionId','optionId','text'], 'Respuesta');
  const answer = {
    questionId: text(value.answer.questionId, 'Pregunta', 100, true),
    optionId: nullableText(value.answer.optionId, 'Opción', 100),
    text: nullableText(value.answer.text, 'Respuesta', 8000),
  };
  if (answer.optionId == null && answer.text == null) fail('La respuesta necesita texto u opción.');
  if(answer.optionId!==null&&answer.text!==null)fail('Elige una opción o escribe una respuesta, no ambas.');
  return { requestId, threadId, threadVersion, message, context: validateAssistantContext(value.context), answer };
}

export function validateEvidence(value) {
  exact(value, ['id','domain','entityId','recordVersion','field','label','value','unit','formattedValue','asOf','asOfPrecision','coverage','href'], 'Evidencia');
  if (!ASSISTANT_DOMAINS.includes(value.domain)) fail('Dominio de evidencia inválido.');
  if (!['date','instant','unknown'].includes(value.asOfPrecision)) fail('Precisión temporal inválida.');
  if (!['string','number','boolean'].includes(typeof value.value) && value.value !== null) fail('Valor de evidencia inválido.');
  if (typeof value.value === 'string' && value.value.length > 2000) fail('Valor de evidencia demasiado largo.');
  if (typeof value.value === 'number' && !Number.isFinite(value.value)) fail('Valor de evidencia no finito.');
  exact(value.coverage, ['state','knownCount','eligibleCount','excludedCount','reasons'], 'Cobertura');
  if (!['complete','partial','unknown'].includes(value.coverage.state)) fail('Cobertura inválida.');
  const count = (v, label) => v == null ? null : integer(v, label, 0);
  return { id:text(value.id,'Evidencia',120,true), domain:text(value.domain,'Dominio',60,true), entityId:nullableText(value.entityId,'Entidad',200),
    recordVersion:value.recordVersion==null?null:integer(value.recordVersion,'Versión',0), field:text(value.field,'Campo',100,true), label:text(value.label,'Etiqueta',300,true),
    value:value.value, unit:nullableText(value.unit,'Unidad',40), formattedValue:nullableText(value.formattedValue,'Valor formateado',1000),
    asOf:nullableText(value.asOf,'Fecha de corte',80), asOfPrecision:value.asOfPrecision,
    coverage:{state:value.coverage.state,knownCount:count(value.coverage.knownCount,'Conteo'),eligibleCount:count(value.coverage.eligibleCount,'Elegibles'),excludedCount:count(value.coverage.excludedCount,'Excluidos'),reasons:list(value.coverage.reasons,'Motivos de cobertura',30,x=>text(x,'Motivo',300,true))},
    href:safeHref(value.href,'Enlace') };
}

function plainAnalysisText(value, max = 2000) {
  text(value, 'Explicación', max, true);
  if (value.length > max) fail('Explicación demasiado larga.');
  const prose = value;
  // Syntax guard only: citations still require reader-owned evidence. This
  // cannot establish semantic truth or causality.
  if (/\p{N}|[$€£¥%]|(?:https?:|www\.|<[^>]*>|\]\()/iu.test(prose)) fail('Usa segmentos de evidencia para cifras, fechas e identificadores; no incluyas HTML ni enlaces.');
  return prose;
}

function validateAnalysisBlock(value) {
  exact(value, ['type','kind','segments','evidenceIds'], 'Análisis');
  if (!['explanation','interpretation','recommendation'].includes(value.kind)) fail('Clase de análisis inválida.');
  let proseLength = 0;
  const references = new Set(list(value.evidenceIds, 'Fuentes', 50, id => text(id, 'Evidencia', 120, true)));
  const segments = list(value.segments, 'Segmentos', 20, segment => {
    object(segment, 'Segmento');
    if (segment.type === 'text') {
      exact(segment, ['type','text'], 'Prosa');
      const prose = plainAnalysisText(segment.text);
      proseLength += prose.length;
      return { type:'text', text:prose };
    }
    exact(segment, ['type','evidenceId','display'], 'Referencia');
    if (segment.type !== 'evidence' || !['label','value'].includes(segment.display)) fail('Referencia inválida.');
    const evidenceId = text(segment.evidenceId, 'Evidencia', 120, true);
    references.add(evidenceId);
    return { type:'evidence', evidenceId, display:segment.display };
  });
  if (!segments.length || proseLength > 2000 || !references.size) fail('El análisis requiere fuentes y prosa acotada.');
  return { type:'analysis', kind:value.kind, segments, evidenceIds:[...references] };
}

export function validatePublicBlock(value) {
  object(value, 'Bloque');
  if (value.type === 'analysis') return validateAnalysisBlock(value);
  if (value.type === 'text') { exact(value,['type','text'],'Texto'); return {type:'text',text:text(value.text,'Texto',5000,true)}; }
  if (value.type === 'fact') { exact(value,['type','title','evidenceIds'],'Dato'); return {type:'fact',title:text(value.title,'Título',300,true),evidenceIds:list(value.evidenceIds,'Evidencias',50,x=>text(x,'Evidencia',120,true))}; }
  if (value.type === 'recommendation') { exact(value,['type','id','title','reason','actionLabel','href','evidenceIds'],'Recomendación'); return {type:'recommendation',id:text(value.id,'Recomendación',120,true),title:text(value.title,'Título',300,true),reason:text(value.reason,'Motivo',2000,true),actionLabel:text(value.actionLabel,'Acción',100,true),href:safeHref(value.href,'Enlace',true),evidenceIds:list(value.evidenceIds,'Evidencias',50,x=>text(x,'Evidencia',120,true))}; }
  if (value.type === 'guide') { exact(value,['type','taskId','title','steps','href'],'Guía'); return {type:'guide',taskId:text(value.taskId,'Tarea',100,true),title:text(value.title,'Título',300,true),steps:list(value.steps,'Pasos',30,x=>{exact(x,['id','text'],'Paso');return{id:text(x.id,'Paso',100,true),text:text(x.text,'Paso',500,true)};}),href:safeHref(value.href,'Enlace',true)}; }
  fail('Tipo de bloque inválido.');
}

export function validateAssistantQuestion(value) {
  if (value == null) return null;
  exact(value,['id','prompt','input','options','allowText'],'Pregunta');
  if (!['text','number','date'].includes(value.input)) fail('Tipo de pregunta inválido.');
  const options = list(value.options,'Opciones',4,x=>{exact(x,['id','label'],'Opción');return{id:text(x.id,'Opción',100,true),label:text(x.label,'Opción',300,true)};});
  if (options.length === 1) fail('Una pregunta debe tener dos o más opciones reales, o ninguna.');
  const optionIds = new Set();
  for (const option of options) {
    if (optionIds.has(option.id)) fail('La pregunta tiene opciones duplicadas.');
    optionIds.add(option.id);
  }
  const allowText = bool(value.allowText,'Texto libre');
  if (!options.length && !allowText) fail('La pregunta necesita opciones o entrada de texto.');
  return {id:text(value.id,'Pregunta',100,true),prompt:text(value.prompt,'Pregunta',1000,true),input:value.input,options,allowText};
}

function validateOpenDescriptor(value) {
  exact(value, ['owner','view','target','entityId','refs'], 'Apertura');
  const owners = ['admin','order-editor','cash','business','shipments','advertising','imports','onboarding'];
  if (!owners.includes(value.owner)) fail('Propietario de apertura inválido.');
  object(value.refs, 'Referencias');
  const roles = ['order','shipment','expense','settlement','payroll','account','closing','entry','person','platform','source','document'];
  const refs = {};
  for (const [role, ref] of Object.entries(value.refs)) {
    if (!roles.includes(role)) fail('Tipo de referencia inválido.');
    exact(ref, ['kind','id','version','documentType'], 'Referencia');
    refs[role] = { kind:text(ref.kind,'Tipo',60,true), id:text(ref.id,'Identificador',200,true), version:ref.version==null?null:integer(ref.version,'Versión',0) };
    if (role === 'document') refs[role].documentType = text(ref.documentType,'Tipo de documento',60,true);
    else if (Object.hasOwn(ref, 'documentType')) fail('Tipo de documento inesperado.');
  }
  return { owner:value.owner, view:readAdminView(object(value.view,'Vista')), target:text(value.target,'Destino',100,true), entityId:nullableText(value.entityId,'Entidad',200), refs };
}

function safePatchValue(value, depth = 0, target = null) {
  if (depth > 8) fail('Parche demasiado profundo.');
  if (value == null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > 5000) fail('Valor de parche demasiado largo.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Número no finito en el parche.');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) fail('Lista de parche demasiado grande.');
    return value.map(item => safePatchValue(item, depth + 1, target));
  }
  object(value, 'Valor de parche');
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('Campo de objeto no permitido en el parche.');
    output[key] = safePatchValue(item, depth + 1, target);
  }
  return output;
}

function validateProposalPatch(target, input, formContext = null) {
  object(input, 'Parche');
  const descriptor = assistantFormDescriptor(target);
  if (!descriptor) fail('Destino sin campos asistibles.');
  const output = filterAssistantPatch(target, input, {
    ...(target==='import-draft' ? {baseline:formContext?.form?.values || formContext?.values || null} : {}),
    allowUnresolvedReferences:true,allowResolvedReferences:true,
  });
  if (Object.keys(output).length !== Object.keys(input).length) fail('El parche contiene campos no permitidos.');
  for (const [key,value] of Object.entries(output)) output[key] = safePatchValue(value,0,target);
  return output;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function validateDiff(value,target) {
  exact(value, ['field','label','before','after'], 'Cambio');
  return {
    field:text(value.field,'Campo',100,true),
    label:text(value.label,'Etiqueta',200,true),
    before:safePatchValue(value.before,0,target),
    after:safePatchValue(value.after,0,target),
  };
}

function validateHumanDiff(value,target) {
  exact(value,['field','label','before','after'],'Cambio humano');
  const field=text(value.field,'Campo',100,true);
  if(field==='operation'&&target.startsWith('record:'))return {field,label:text(value.label,'Etiqueta',200,true),before:nullableText(value.before,'Antes',300),after:text(value.after,'Efecto',300,true)};
  if(!assistantSubmissionFields(target).includes(field))fail('Campo de revisión humana no permitido.');
  const normalize=item=>item==null?null:validateAssistantSubmission(target,{[field]:item})[field];
  return {field,label:text(value.label,'Etiqueta',200,true),before:normalize(value.before),after:normalize(value.after)};
}


const AUTOMATIC_PATCH_FIELDS = Object.freeze({
  'record:products': new Set(['title','description','presentation','flavor','productInfo']),
  'record:combos': new Set(['title','description','conditions']),
  'record:catalogs': new Set(['title','description']),
  'record:faqs': new Set(['title','answer']),
  'record:messages': new Set(['title','body','buttonText']),
  'record:shipping': new Set(['title','zone','costText','estimatedTime','cashOnDelivery','details']),
  'campaign-draft': new Set(['name','caption','headline']),
});

export function validateProposalDTO(value, { formContext = null, hasReceipt = false } = {}) {
  exact(value,['id','version','configurationVersion','payloadHash','target','entityId','recordVersion','formId','generation','open','patch','missingFields','diff','humanDiff','moneyCurrency','execution','state'],'Propuesta');
  const target=text(value.target,'Destino',100,true);
  const descriptor=assistantFormDescriptor(target);
  if (!descriptor) fail('Destino de propuesta no asistible.');
  if (!['prefill','automatic','confirm','human-only'].includes(value.execution)) fail('Ejecución de propuesta inválida.');
  const state=text(value.state,'Estado',40,true);
  if (!['prepared','applied','executed','cancelled','stale'].includes(state)) fail('Estado de propuesta inválido.');
  if (state==='executed'&&!hasReceipt) fail('Una propuesta ejecutada requiere un recibo.');
  const payloadHash=text(value.payloadHash,'Hash',64,true);
  if (!/^[a-f0-9]{64}$/.test(payloadHash)) fail('Hash de propuesta no canónico.');
  exact(value.moneyCurrency,['before','after'],'Moneda de revisión');
  const moneyCurrency={};
  for(const side of ['before','after']){
    const currency=value.moneyCurrency[side];
    if(currency!==null&&(typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency)))fail('Moneda de revisión no válida.');
    moneyCurrency[side]=currency;
  }
  const entityId=nullableText(value.entityId,'Entidad',200);
  const recordVersion=value.recordVersion==null?null:integer(value.recordVersion,'Versión de registro',0);
  const formId=nullableText(value.formId,'Formulario',100);
  const generation=value.generation==null?null:integer(value.generation,'Generación',0);
  const normalizedContext=formContext==null?null:validateAssistantContext(formContext);
  const form=normalizedContext?.form;
  if (formId!==null && formContext && form) {
    if (target!==form.target || entityId!==form.entityId || recordVersion!==form.recordVersion
      || formId!==form.formId || generation!==form.generation) fail('La propuesta corresponde a otra versión del formulario.');
  } else if (formContext && !form && (formId!==null || generation!==null)) {
    fail('La propuesta no puede vincularse a un formulario inexistente.');
  }
  const patch=validateProposalPatch(target,value.patch,normalizedContext);
  if (value.execution==='automatic') {
    const safe=AUTOMATIC_PATCH_FIELDS[target];
    if (!safe || !Object.keys(patch).length || Object.keys(patch).some(key=>!safe.has(key))) fail('La propuesta requiere confirmación humana.');
  }
  const missingFields=list(value.missingFields,'Campos faltantes',100,x=>text(x,'Campo',100,true));
  const missingSet=new Set();
  for (const field of missingFields) {
    if (!assistantSubmissionFields(target).includes(field)) fail('Campo faltante no permitido.');
    if (missingSet.has(field)) fail('Campo faltante duplicado.');
    missingSet.add(field);
  }
  const diff=list(value.diff,'Cambios',100,item=>validateDiff(item,target));
  if (form && formId!==null) {
    for (const change of diff) {
      if (!Object.hasOwn(form.values,change.field)
        || canonical(change.before)!==canonical(form.values[change.field])) {
        fail('El estado anterior del diff no coincide con el formulario actual.');
      }
    }
  }
  const diffFields=new Set();
  for (const change of diff) {
    if (!Object.hasOwn(patch,change.field) || diffFields.has(change.field)) fail('El diff no corresponde al parche.');
    if (canonical(change.after)!==canonical(patch[change.field])) fail('El valor mostrado no corresponde al parche.');
    diffFields.add(change.field);
  }
  if (diffFields.size!==Object.keys(patch).length) fail('El diff debe cubrir exactamente los campos del parche.');
  const humanDiff=list(value.humanDiff??[],'Cambios humanos',100,item=>validateHumanDiff(item,target));
  const humanFields=new Set();
  for(const change of humanDiff){if(diffFields.has(change.field)||humanFields.has(change.field))fail('Campo de revisión duplicado.');humanFields.add(change.field);}
  const open=validateOpenDescriptor(value.open);
  if (open.target!==target || open.entityId!==entityId) fail('La apertura no corresponde a la propuesta.');
  return {id:text(value.id,'Propuesta',120,true),version:integer(value.version,'Versión',1),configurationVersion:integer(value.configurationVersion,'Configuración',0),payloadHash,target,entityId,recordVersion,formId,generation,open,patch,missingFields,diff,humanDiff,moneyCurrency,execution:value.execution,state};
}

export function validateAssistantReceipt(value) {
  if (value == null) return null;
  exact(value,['id','proposalId','operation','target','entityId','recordVersion','committedAt','summary','href'],'Recibo');
  const receipt = {id:text(value.id,'Recibo',120,true),proposalId:text(value.proposalId,'Propuesta',120,true),operation:text(value.operation,'Operación',100,true),target:text(value.target,'Destino',100,true),entityId:nullableText(value.entityId,'Entidad',200),recordVersion:value.recordVersion==null?null:integer(value.recordVersion,'Versión',0),committedAt:text(value.committedAt,'Fecha',80,true),summary:text(value.summary,'Resumen',1000,true),href:safeHref(value.href,'Enlace')};
  if (receipt.id !== receipt.proposalId) fail('Identificador de recibo inválido.');
  return receipt;
}

export function validateAssistantFollowUp(value) {
  exact(value,['id','kind','title','description','href','turnId','state'],'Seguimiento');
  const kind=text(value.kind,'Tipo de seguimiento',40,true);
  if (!['question','proposal','action','task','receipt'].includes(kind)) fail('Tipo de seguimiento inválido.');
  const state=text(value.state,'Estado de seguimiento',20,true);
  if (!['pending','suggested'].includes(state)) fail('Estado de seguimiento inválido.');
  const href=safeHref(value.href,'Enlace',['proposal','action','task'].includes(kind));
  if (href?.length>512) fail('El enlace del seguimiento excede el límite permitido.');
  return {
    id:text(value.id,'Seguimiento',150,true), kind,
    title:text(value.title,'Título',150,true),
    description:text(value.description,'Descripción',200,true),
    href, turnId:text(value.turnId,'Turno',80,true), state,
  };
}

export function validateTurnResult(value, { formContext = null } = {}) {
  if (!Object.hasOwn(value, 'followUps')) value = { ...value, followUps: [] };
  exact(value,['threadId','threadVersion','turnId','configurationVersion','topic','blocks','evidence','question','proposal','receipt','followUps','analysis'],'Resultado');
  const evidence=list(value.evidence,'Evidencias',500,validateEvidence), ids=new Set();
  for (const item of evidence) {
    if (ids.has(item.id)) fail('Evidencia duplicada.');
    ids.add(item.id);
  }
  const blocks=list(value.blocks,'Bloques',100,validatePublicBlock);
  for(const block of blocks) if('evidenceIds' in block && block.evidenceIds.some(id=>!ids.has(id))) fail('El bloque cita evidencia inexistente.');
  if (blocks.filter(block => block.type === 'analysis').length > 12) fail('Demasiados bloques de análisis.');
  const topic = text(value.topic,'Tema',120,true);
  if (!ASSISTANT_DOMAINS.includes(topic)) fail('Tema de conversación inválido.');
  const receipt = validateAssistantReceipt(value.receipt);
  const proposal = value.proposal == null ? null : validateProposalDTO(value.proposal,{formContext,hasReceipt:Boolean(receipt)});
  if (receipt && (!proposal || receipt.proposalId !== proposal.id || proposal.state !== 'executed'
    || receipt.target !== proposal.target || receipt.entityId !== proposal.entityId
    || receipt.recordVersion !== proposal.recordVersion)) fail('Recibo sin propuesta ejecutada correspondiente.');
  if (proposal?.state === 'executed' && !receipt) fail('Una propuesta ejecutada requiere un recibo.');
  const result = {threadId:text(value.threadId,'Conversación',120,true),threadVersion:integer(value.threadVersion,'Versión',0),turnId:text(value.turnId,'Turno',120,true),configurationVersion:integer(value.configurationVersion,'Configuración',0),topic,blocks,evidence,question:validateAssistantQuestion(value.question),proposal,receipt,followUps:list(value.followUps??[],'Seguimientos',8,validateAssistantFollowUp),analysis:validateAnalysisStatus(value.analysis ?? null)};
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > ASSISTANT_LIMITS.publicResultBytes) fail('Respuesta pública demasiado grande.');
  return result;
}

export const ASSISTANT_TEXT_TEMPLATES=Object.freeze(['welcome','acknowledged','topic_changed','missing_data','choose_record','next_step','scope_limit']);

export function validateAssistantModelFinish(value) {
  exact(value,['topic','blocks','question','proposalId','remainingReads'],'Respuesta del modelo');
  if(!ASSISTANT_DOMAINS.includes(value.topic))fail('Tema del modelo no permitido.');
  const blocks=list(value.blocks,'Bloques del modelo',30,block=>{
    object(block,'Bloque del modelo');
    if(block.type==='analysis') return validateAnalysisBlock(block);
    if(block.type==='fact'){
      exact(block,['type','evidenceIds'],'Dato del modelo');
      return{type:'fact',evidenceIds:list(block.evidenceIds,'Evidencias',50,id=>text(id,'Evidencia',120,true))};
    }
    if(block.type==='recommendation'){
      exact(block,['type','recommendationId'],'Recomendación del modelo');
      return{type:'recommendation',recommendationId:text(block.recommendationId,'Recomendación',120,true)};
    }
    if(block.type==='guide'){
      exact(block,['type','taskId','stepIds'],'Guía del modelo');
      return{type:'guide',taskId:text(block.taskId,'Tarea',100,true),stepIds:list(block.stepIds,'Pasos',30,id=>text(id,'Paso',100,true))};
    }
    if(block.type==='text'){
      exact(block,['type','templateId','slots'],'Texto del modelo');
      if(!ASSISTANT_TEXT_TEMPLATES.includes(block.templateId))fail('Plantilla del modelo no permitida.');
      const slots=exact(block.slots,['taskId','evidenceId','quote'],'Referencias de plantilla'),normalized={};
      if(slots.taskId!=null)normalized.taskId=text(slots.taskId,'Tarea',100,true);
      if(slots.evidenceId!=null)normalized.evidenceId=text(slots.evidenceId,'Evidencia',120,true);
      if(slots.quote!=null){
        exact(slots.quote,['start','end'],'Fragmento del mensaje');
        normalized.quote={start:integer(slots.quote.start,'Inicio',0,8000),end:integer(slots.quote.end,'Fin',0,8000)};
        if(normalized.quote.end<=normalized.quote.start||normalized.quote.end-normalized.quote.start>300)fail('Fragmento del mensaje inválido.');
      }
      if(['topic_changed','next_step'].includes(block.templateId)&&!normalized.taskId)fail('La plantilla necesita una tarea consultada.');
      return{type:'text',templateId:block.templateId,slots:normalized};
    }
    fail('Tipo de bloque del modelo no permitido.');
  });
  let question=null;
  if (blocks.filter(block => block.type === 'analysis').length > 12) fail('Demasiados bloques de análisis.');
  if(value.question!=null){
    const item=object(value.question,'Pregunta del modelo');
    if(item.kind==='missing_field'){
      exact(item,['kind','target','field'],'Dato faltante');
      const target=text(item.target,'Formulario',100,true),field=text(item.field,'Campo',100,true);
      if(!assistantSubmissionFields(target).includes(field)||/(?:password|secret|token|csrf|credential|confirmation|consent|acknowledge|approved|confirmed|allowCredit|inventoryOpeningIncluded|userId|version|generation)/i.test(field))fail('Pregunta de campo no permitida.');
      question={kind:item.kind,target,field};
    } else if(item.kind==='choose_entity'){
      exact(item,['kind','candidateEvidenceIds'],'Elegir registro');
      const ids=list(item.candidateEvidenceIds,'Candidatos',4,id=>text(id,'Evidencia',120,true));
      if(ids.length<2||new Set(ids).size!==ids.length)fail('La selección necesita registros distintos.');
      question={kind:item.kind,candidateEvidenceIds:ids};
    } else if(item.kind==='choose_goal'){
      exact(item,['kind','taskIds'],'Elegir objetivo');
      const ids=list(item.taskIds,'Tareas',4,id=>text(id,'Tarea',100,true));
      if(ids.length<2||new Set(ids).size!==ids.length)fail('La selección necesita tareas distintas.');
      question={kind:item.kind,taskIds:ids};
    } else if(item.kind==='clarify_scope'){
      exact(item,['kind','subject','prompt'],'Aclaración');
      if(!['period','metric','goal'].includes(item.subject))fail('Tema de aclaración inválido.');
      const prompt=text(item.prompt,'Pregunta',500,true);
      if(/(?:https?:|www\.|<[^>]*>|contraseñ|password|token|secret|credencial|aprueb|autoriz|confirm.*(?:guard|operaci|ejecut))/iu.test(prompt))fail('Pregunta de aclaración no permitida.');
      question={kind:item.kind,subject:item.subject,prompt};
    } else fail('Tipo de pregunta del modelo no permitido.');
  }
  return{topic:value.topic,blocks,question,proposalId:nullableText(value.proposalId,'Propuesta',120),remainingReads:list(value.remainingReads??[],'Lecturas pendientes',30,validateAssistantReadRequest)};
}

const ANALYSIS_REASONS = ['quick_budget','work_budget','user_stopped','context_capacity','provider_unavailable','invalid_answer','no_progress','source_changed','interrupted'];
const RETRIEVAL_REASONS = ['unread_pages','unread_fields','unknown_data','stale_source','source_changed','source_unavailable'];
const DATASET_FILTERS = Object.freeze({
  catalog:['kind','q','status','productType'],
  orders:['q','status','paymentStatus','seller','product','platform','source','carrier','issue','lookup'],
  shipments:['q','status','carrier','orderId','sourceId','platformId','issue','eventStatus'],
  cash:['kind','resource','account','person','source','status','category','q'],
  reports:['seller','product','platform','source','carrier','status','account','metric','issue','period','anchor','mode'],
  recommendations:['seller','product','platform','source','carrier','status','account','period','anchor'],
  business:['kind','resource','q','status','active','source','platform'],
  alerts:['kind','state','severity','type','q','resource','person'],
  imports:['source','sourceId','state','sheet','rowNumber','q','status'],
  advertising:['kind','resource','q','state','status','campaignId','deliveryId','connectionId','mode','network','objective','integrationMethod','origin','scope','dimension','from','to','capturedFrom','capturedTo','captureId','mediaKind'],
  access:[], application:['taskId','q'],
});

function validateDataset(value) {
  exact(value, ['domain','resource','recordId','filters','startDate','endDateExclusive','asOf','sourceStamp'], 'Fuente consultada');
  if (!ASSISTANT_DOMAINS.includes(value.domain)) fail('Dominio de fuente inválido.');
  const filters = object(value.filters, 'Filtros efectivos'), normalized = {};
  for (const [key, item] of Object.entries(filters)) {
    if (!DATASET_FILTERS[value.domain].includes(key)) fail('Filtro efectivo no permitido.');
    if (item !== null && !['string','number','boolean'].includes(typeof item)) fail('Valor de filtro inválido.');
    if (typeof item === 'string' && item.length > 200) fail('Filtro demasiado largo.');
    if (typeof item === 'number' && !Number.isFinite(item)) fail('Filtro no finito.');
    normalized[key] = item;
  }
  const date = (item, label) => item == null ? null : businessDate(item, label);
  return {
    domain:value.domain, resource:nullableText(value.resource, 'Recurso', 100),
    recordId:nullableText(value.recordId, 'Registro', 200), filters:normalized,
    startDate:date(value.startDate, 'Inicio'), endDateExclusive:date(value.endDateExclusive, 'Fin exclusivo'),
    asOf:nullableText(value.asOf, 'Corte', 80), sourceStamp:nullableText(value.sourceStamp, 'Versión de fuente', 512),
  };
}

function validateAnalysisStatus(value) {
  if (value == null) return null;
  exact(value, ['status','scope','reason','remaining','canContinue','sourceTurnId'], 'Estado del análisis');
  if (!['complete','partial','empty'].includes(value.status) || value.reason != null && !ANALYSIS_REASONS.includes(value.reason)) fail('Estado del análisis inválido.');
  const scope = exact(value.scope, ['view','selection','datasets','startedAt','consultedThrough'], 'Alcance efectivo');
  const view = readAdminView(object(scope.view, 'Vista de origen'));
  const remaining = list(value.remaining, 'Pendientes', 100, item => {
    exact(item, ['id','label','kind'], 'Pendiente');
    if (!['unread','missing_data','unavailable','stale'].includes(item.kind)) fail('Tipo de pendiente inválido.');
    return { id:text(item.id, 'Pendiente', 200, true), label:text(item.label, 'Etiqueta', 300, true), kind:item.kind };
  });
  const canContinue = bool(value.canContinue, 'Análisis retomable');
  if (canContinue && !remaining.some(item => item.kind !== 'missing_data')) fail('No hay trabajo recuperable.');
  if (value.status === 'complete' && remaining.some(item => item.kind === 'unread')) fail('El análisis conserva lecturas pendientes.');
  return { status:value.status, scope:{
    view, selection:validateAssistantSelection(view, scope.selection ?? null),
    datasets:list(scope.datasets, 'Fuentes', 100, validateDataset),
    startedAt:text(scope.startedAt, 'Inicio de consulta', 80, true),
    consultedThrough:nullableText(scope.consultedThrough, 'Última consulta', 80),
  }, reason:value.reason ?? null, remaining, canContinue, sourceTurnId:nullableText(value.sourceTurnId, 'Turno de origen', 120) };
}

export function validateAssistantRetrieval(value) {
  exact(value, ['complete','selection','recordsRead','recordsTotal','sourceStamp','consultedAt','reasons'], 'Recuperación');
  if (!['summary','all','sample','detail'].includes(value.selection)) fail('Selección inválida.');
  return {
    complete:bool(value.complete, 'Recuperación completa'), selection:value.selection,
    recordsRead:integer(value.recordsRead, 'Registros leídos', 0),
    recordsTotal:value.recordsTotal == null ? null : integer(value.recordsTotal, 'Total de registros', 0),
    sourceStamp:nullableText(value.sourceStamp, 'Versión de fuente', 512),
    consultedAt:text(value.consultedAt, 'Fecha de consulta', 80, true),
    reasons:list(value.reasons, 'Motivos', 6, reason => { if (!RETRIEVAL_REASONS.includes(reason)) fail('Motivo de recuperación inválido.'); return reason; }),
  };
}

export function validateAssistantTurnStatus(value) {
  exact(value, ['turnId','threadId','threadVersion','state','revision','mode','phase','progress','preview','result'], 'Avance de Ali');
  if (!['running','completed','failed','cancelled'].includes(value.state) || !['quick','extended'].includes(value.mode)
    || !['planning','reading','analyzing','answering','done'].includes(value.phase)) fail('Avance inválido.');
  const progress = exact(value.progress, ['readsCompleted','recordsRead','recordsTotal','currentLabel'], 'Progreso');
  const preview = value.preview == null ? null : validateTurnResult(value.preview);
  const result = value.result == null ? null : validateTurnResult(value.result);
  if (preview?.proposal || preview?.receipt || value.state === 'running' && result || value.state !== 'running' && preview) fail('El avance no puede autorizar operaciones.');
  for (const item of [preview, result]) if (item && (item.turnId !== value.turnId || item.threadId !== value.threadId)) fail('Resultado de otro turno.');
  return {
    turnId:text(value.turnId, 'Turno', 120, true), threadId:text(value.threadId, 'Conversación', 120, true),
    threadVersion:integer(value.threadVersion, 'Versión de conversación', 0), state:value.state,
    revision:integer(value.revision, 'Revisión', 0), mode:value.mode, phase:value.phase,
    progress:{readsCompleted:integer(progress.readsCompleted, 'Lecturas', 0), recordsRead:integer(progress.recordsRead, 'Registros', 0),
      recordsTotal:progress.recordsTotal == null ? null : integer(progress.recordsTotal, 'Total', 0), currentLabel:nullableText(progress.currentLabel, 'Fuente actual', 300)},
    preview, result,
  };
}

export function validateAssistantReadPage(value) {
  exact(value, ['readId','records','evidence','pagination','retrieval'], 'Página consultada');
  const pagination = exact(value.pagination, ['cursor','nextCursor','total'], 'Paginación de consulta');
  const records = list(value.records, 'Registros consultados', 20, record => {
    object(record, 'Registro consultado');
    assertFiniteNumbers(record, 'Registro consultado');
    return record;
  });
  const page = {
    readId:text(value.readId, 'Lectura', 120, true), records,
    evidence:list(value.evidence, 'Evidencias', 500, validateEvidence),
    pagination:{cursor:nullableText(pagination.cursor, 'Página', 200), nextCursor:nullableText(pagination.nextCursor, 'Página siguiente', 200), total:pagination.total == null ? null : integer(pagination.total, 'Total', 0)},
    retrieval:validateAssistantRetrieval(value.retrieval),
  };
  if (new TextEncoder().encode(JSON.stringify(page)).byteLength > ASSISTANT_LIMITS.readPageBytes) fail('Página pública demasiado grande.');
  return page;
}
