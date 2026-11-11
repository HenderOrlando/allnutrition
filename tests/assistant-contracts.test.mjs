import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAssistantContext,
  validateAssistantFollowUp,
  validateAssistantQuestion,
  validateAssistantSettings,
  validateProposalDTO,
  validatePublicBlock,
  validateTurnInput,
} from '../lib/assistant/contracts.mjs';
import { serializeAssistantForm, validateAssistantFormValues, validateAssistantSubmission } from '../lib/assistant/forms.mjs';

test('una configuración solo queda habilitada con proveedor, clave y conexión verificada', () => {
  const base = {
    version: 1, enabled: false, provider: null, baseUrl: null, model: null,
    allowPrivateNetwork: false, hasApiKey: false, connectionStatus: 'unconfigured', verifiedAt: null,
  };
  assert.equal(validateAssistantSettings(base).enabled, false);
  const ready = { ...base, enabled: true, provider: 'openai', model: 'gpt-4.1-mini', hasApiKey: true, connectionStatus: 'ready' };
  assert.equal(validateAssistantSettings(ready).enabled, true);
  assert.throws(() => validateAssistantSettings({ ...ready, hasApiKey: false }));
  assert.throws(() => validateAssistantSettings({ ...ready, connectionStatus: 'unverified' }));
});

const context = values => ({
  view: { section: 'products' },
  form: {
    formId: 'form-product-1', target: 'record:products', entityId: null,
    recordVersion: null, generation: 0, values, dirty: true, busy: false,
  },
});

const proposal = overrides => ({
  id: 'proposal-1', version: 1, configurationVersion: 2,
  payloadHash: 'a'.repeat(64), target: 'record:products', entityId: null,
  moneyCurrency:{before:'COP',after:'COP'},
  recordVersion: null, formId: 'form-product-1', generation: 0,
  open: { owner: 'admin', view: { section: 'products' }, target: 'record:products', entityId: null, refs: {} },
  patch: { title: 'Vitamina C' }, missingFields: [],
  diff: [{ field: 'title', label: 'Nombre', before: '', after: 'Vitamina C' }],
  execution: 'prefill', state: 'prepared', ...overrides,
});

test('el contexto de formulario conserva valores asistibles y rechaza credenciales no declaradas', () => {
  const parsed = validateAssistantContext(context({ title: 'Vitamina C', description: 'Suplemento' }));
  assert.equal(parsed.form.values.title, 'Vitamina C');
  assert.throws(() => validateAssistantContext(context({ title: 'Vitamina C', apiKey: 'secret-canary' })));
  const poisoned = JSON.parse('{"title":"Seguro","__proto__":{"assistantPolluted":true}}');
  assert.throws(() => validateAssistantContext(context(poisoned)));
  assert.equal({}.assistantPolluted, undefined);
});

test('las propuestas vinculan formulario y diff al estado que el usuario revisa', () => {
  const form = context({ title: '', description: '' });
  assert.equal(validateProposalDTO(proposal(), { formContext: form }).patch.title, 'Vitamina C');
  assert.throws(() => validateProposalDTO(proposal({ generation: 1 }), { formContext: form }));
  assert.throws(() => validateProposalDTO(proposal({ diff: [
    { field: 'title', label: 'Nombre', before: 'Otro valor', after: 'Vitamina C' },
  ] }), { formContext: form }));
  assert.throws(() => validateProposalDTO(proposal({ patch: { title: 'Vitamina C', apiKey: 'secret-canary' } })));
  assert.throws(() => validateProposalDTO(proposal({ missingFields: ['apiKey'] })));
  assert.throws(() => validateProposalDTO(proposal({ state: 'executed' })));
  assert.throws(() => validateProposalDTO(proposal({ open: { ...proposal().open, view: { section: 'products' }, href: 'https://evil.example' } })));
});

test('las preguntas requieren opciones no ambiguas o texto y aceptan el caso válido', () => {
  const question = validateAssistantQuestion({
    id: 'q-2', prompt: '¿Qué producto?', input: 'text', allowText: false,
    options: [{ id: 'product-a', label: 'Producto A' }, { id: 'product-b', label: 'Producto B' }],
  });
  assert.equal(question.options.length, 2);
  assert.throws(() => validateAssistantQuestion({ id: 'q-1', prompt: '¿Qué falta?', input: 'text', options: [], allowText: false }));
  assert.throws(() => validateAssistantQuestion({
    id: 'q-1', prompt: '¿Qué producto?', input: 'text', allowText: false,
    options: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }],
  }));
});

test('los enlaces de bloques públicos solo apuntan a vistas administrativas normalizadas', () => {
  const safe = validatePublicBlock({
    type: 'recommendation', id: 'r-1', title: 'Abrir', reason: 'Revisa el catálogo',
    actionLabel: 'Ver catálogo', href: '/admin?section=products', evidenceIds: [],
  });
  assert.equal(safe.href, '/admin?section=products');
  assert.throws(() => validatePublicBlock({
    type: 'recommendation', id: 'r-1', title: 'Abrir', reason: 'Revisa el catálogo',
    actionLabel: 'Ver catálogo', href: 'https://evil.example', evidenceIds: [],
  }));
});
test('los siguientes pasos son persistentes pero solo navegan a secciones administrativas normalizadas', () => {
  const question=validateAssistantFollowUp({id:'question:q-1',kind:'question',title:'Responder pregunta pendiente',description:'¿Cuál producto?',href:null,turnId:'turn-1',state:'pending'});
  const task=validateAssistantFollowUp({id:'task:products',kind:'task',title:'Gestionar productos',description:'Revisar fichas.',href:'/admin?section=products',turnId:'turn-2',state:'suggested'});
  assert.equal(question.href,null);
  assert.equal(task.href,'/admin?section=products');
  assert.throws(()=>validateAssistantFollowUp({...task,href:'https://outside.example'}));
  assert.throws(()=>validateAssistantFollowUp({...task,kind:'unknown'}));
});

test('los tipos y objetos anidados coinciden con los campos editables del formulario', () => {
  assert.throws(() => validateAssistantFormValues('storefront-settings', {
    brandName: 'ALL NUTRITION', showNextStage: 'false',
  }));
  assert.throws(() => validateAssistantFormValues('settings:person', {
    name: 'Ana', commissionOverrides: [{
      id: 'override-1', effectiveOn: '2026-01-01', enabled: true,
      mode: 'percent', rateBps: 100, basis: 'net_products',
      earnWhen: 'business_received', apiKey: 'secret-canary',
    }],
  }));
  assert.equal(validateAssistantFormValues('order', {
    documentType: 'RUT persona jurídica',
  }).documentType, 'RUT persona jurídica');
});

test('los formularios publicitarios solo admiten campos asistibles y respetan el límite del motivo', () => {
  const campaign = validateAssistantFormValues('campaign-draft', {
    name: 'Prueba', caption: 'Texto', headline: 'Titular',
  }, { patch: true });
  assert.deepEqual(campaign, { name: 'Prueba', caption: 'Texto', headline: 'Titular' });
  assert.throws(() => validateAssistantFormValues('campaign-draft', { title: 'Campo incorrecto' }, { patch: true }), /Campo no permitido/);

  const reason = 'R'.repeat(500);
  assert.equal(validateAssistantFormValues('advertising-result-action', { reason }, { patch: true }).reason.length, 500);
  assert.throws(() => validateAssistantFormValues('advertising-result-action', { reason: `${reason}R` }, { patch: true }), /máximo 500/);
  assert.throws(() => validateAssistantFormValues('advertising-result-action', {
    reason: 'Vínculo declarado', campaignId: 'otro-registro',
  }, { patch: true }), /Campo no permitido/);
});
test('los nombres de importación y el resolutor solo admiten datos informativos', () => {
  for (const target of ['import-platform-name', 'import-source-name', 'import-profile-name']) {
    assert.equal(validateAssistantFormValues(target, { name: 'N'.repeat(150) }, { patch: true }).name.length, 150);
    assert.throws(() => validateAssistantFormValues(target, { name: 'N'.repeat(151) }, { patch: true }), /máximo 150/);
    assert.throws(() => validateAssistantFormValues(target, { name: 'Nombre', apiKey: 'secret-canary' }, { patch: true }), /Campo no permitido/);
  }
  assert.deepEqual(validateAssistantFormValues('import-resolver', {}, { patch: true }), {});
  assert.equal(validateAssistantFormValues('import-resolver', { reason:'Corrección informativa',value:'Etiqueta verificada' }, { patch:true }).value,'Etiqueta verificada');
  assert.throws(() => validateAssistantFormValues('import-resolver', { acknowledged:true }, { patch:true }));
  assert.throws(() => validateAssistantFormValues('import-resolver', { action:'accept' }, { patch:true }));
});

test('las referencias nuevas necesitan una opción autorizada del servidor', () => {
  const values = validateAssistantFormValues('record:products', {
    items: [{ productId: 'product-1', quantity: 2 }],
  }, { patch: true, referenceChoices: { productId: ['product-1'] } });
  assert.equal(values.items[0].productId, 'product-1');
  assert.throws(() => validateAssistantFormValues('record:products', {
    items: [{ productId: 'product-outside-form', quantity: 2 }],
  }, { patch: true, referenceChoices: { productId: ['product-1'] } }));
});

test('la distribución de envíos usa cantidades numéricas y líneas del pedido autorizado', () => {
  const options = { patch: true, referenceChoices: { assignments: { 'line-1': { quantity: 5 } } } };
  const valid = validateAssistantFormValues('shipment-metadata', {
    assignments: { 'line-1': 2 },
  }, options);
  assert.equal(valid.assignments['line-1'], 2);
  assert.throws(() => validateAssistantFormValues('shipment-metadata', {
    assignments: { 'line-outside-order': 2 },
  }, options));
  assert.throws(() => validateAssistantFormValues('shipment-metadata', {
    assignments: { 'line-1': '2' },
  }, options));
  const action = validateAssistantFormValues('business-action:link-shipment', {
    assignments: [{ lineId: 'line-1', quantity: 2 }],
  }, options);
  assert.equal(action.assignments[0].lineId, 'line-1');
  assert.throws(() => validateAssistantFormValues('business-action:link-shipment', {
    assignments: [{ lineId: 'line-outside-order', quantity: 2 }],
  }, options));
});

test('el contexto de importación acepta la forma real del borrador sin perder opciones', () => {
  const values = validateAssistantFormValues('import-draft', { config: {
    formatVersion: 2,
    sheets: [{
      sheetName: 'VENTAS', enabled: true, headerRow: 1, dateFormat: 'ISO',
      decimalSeparator: ',', groupSeparator: '.', layout: 'item_rows', purpose: 'orders',
      columns: [{ index: 0, header: 'ID pedido', destination: 'externalOrderId', group: 0 }],
      statusMap: {}, oneOrderPerGuide: false, reportAsOf: null, defaults: {},
      identityMode: 'provided', expenseGroupNames: {}, expenseCategoryMap: {},
    }],
  } });
  assert.equal(values.config.sheets[0].dateFormat, 'ISO');
  assert.equal(values.config.sheets[0].identityMode, 'provided');
  assert.equal(values.config.sheets[0].oneOrderPerGuide, false);

  const expenses = validateAssistantFormValues('import-draft', { config: {
    formatVersion: 2,
    sheets: [{
      sheetName: 'GASTOS', enabled: true, headerRow: 1, dateFormat: 'ISO',
      decimalSeparator: ',', groupSeparator: '.', layout: 'expense_columns', purpose: 'expenses',
      columns: [], statusMap: {}, oneOrderPerGuide: false, reportAsOf: null, defaults: {},
      identityMode: 'provided', expenseGroupNames: { '49': 'Campaña A' },
      expenseCategoryMap: { 'Publicidad externa': 'advertising' },
    }],
  } });
  assert.equal(expenses.config.sheets[0].expenseGroupNames['49'], 'Campaña A');
  assert.equal(expenses.config.sheets[0].expenseCategoryMap['Publicidad externa'], 'advertising');
});

test('el parche de mapeo conserva identidad de hoja y columna del archivo', () => {
  const baseline = { config: { formatVersion: 2, sheets: [{
    sheetName: 'VENTAS', columns: [{ index: 0, header: 'ID pedido', destination: '' }],
  }] } };
  const patch = { config: { formatVersion: 2, sheets: [{
    sheetName: 'VENTAS', columns: [{ index: 0, header: 'ID pedido', destination: 'externalOrderId', group: 0 }],
  }] } };
  const result = validateAssistantFormValues('import-draft', patch, { patch: true, baseline });
  assert.equal(result.config.sheets[0].columns[0].destination, 'externalOrderId');
  assert.throws(() => validateAssistantFormValues('import-draft', {
    config: { formatVersion: 2, sheets: [{
      sheetName: 'OTRA', columns: [{ index: 0, header: 'ID pedido', destination: 'externalOrderId' }],
    }] },
  }, { patch: true, baseline }));
});

test('versiones financieras son metadatos, no valores editables del modelo',()=>{
  const original={version:3,amountMinor:0,accountId:'account-current',occurredOn:'2026-09-03',allowCredit:false};
  const values=serializeAssistantForm('business-action:collection',original);
  const parsed=validateAssistantContext({view:{section:'cash'},form:{formId:'collection-form',target:'business-action:collection',entityId:'order-current',recordVersion:3,generation:0,values,dirty:false,busy:false}});
  assert.equal(parsed.form.recordVersion,3);
  assert.equal(parsed.form.values.amountMinor,0);
  assert.equal(Object.hasOwn(parsed.form.values,'version'),false);
  assert.equal(validateAssistantSubmission('business-action:collection',original).version,3);
  assert.equal(Object.hasOwn(parsed.form.values,'allowCredit'),false);
  assert.equal(validateAssistantSubmission('business-action:collection',original).allowCredit,false);
  assert.throws(()=>validateAssistantFormValues('business-action:collection',{version:4},{patch:true}));
});

test('un cambio de convenio conserva sus fechas y los convenios hermanos',()=>{
  const baseline={salaryAgreements:[
    {id:'salary-first',enabled:true,frequency:'monthly',amountPerPeriodMinor:100000,effectiveFrom:'2026-01-01',effectiveTo:'2026-06-30',payDayOffset:0},
    {id:'salary-second',enabled:true,frequency:'halfmonthly',amountPerPeriodMinor:50000,effectiveFrom:'2026-07-01',effectiveTo:null,payDayOffset:1},
  ]};
  const next=validateAssistantFormValues('settings:person',{salaryAgreements:[{id:'salary-first',amountPerPeriodMinor:120000}]},{patch:true,baseline});
  assert.equal(next.salaryAgreements[0].amountPerPeriodMinor,120000);
  assert.equal(next.salaryAgreements[0].effectiveTo,'2026-06-30');
  assert.deepEqual(next.salaryAgreements[1],baseline.salaryAgreements[1]);
  assert.throws(()=>validateAssistantFormValues('settings:person',{salaryAgreements:[{id:'not-this-person',amountPerPeriodMinor:1}]},{patch:true,baseline}));
  assert.throws(()=>validateAssistantFormValues('settings:person',{salaryAgreements:[]},{patch:true,baseline}));
});

test('la propuesta pública preserva UUID de línea y no admite claves de prototipo',()=>{
  const lineId='3d4e6500-890f-4ab2-b1fa-8dc5bcf73212';
  const dto=proposal({target:'shipment-metadata',entityId:'shipment-current',recordVersion:3,formId:null,generation:null,
    open:{owner:'shipments',view:{section:'orders',tab:'shipments'},target:'shipment-metadata',entityId:'shipment-current',refs:{shipment:{kind:'shipments',id:'shipment-current',version:3}}},
    patch:{assignments:{[lineId]:2}},diff:[{field:'assignments',label:'Distribución',before:{[lineId]:1},after:{[lineId]:2}}],execution:'confirm'});
  assert.equal(validateProposalDTO(dto).patch.assignments[lineId],2);
  const poisoned=JSON.parse('{"constructor":2}');
  assert.throws(()=>validateProposalDTO({...dto,patch:{assignments:poisoned}}));
});

test('una respuesta pendiente no puede mezclar texto y opción contradictorios',()=>{
  const input={requestId:'answer-request',threadId:'thread-current',threadVersion:2,message:'Mi respuesta',context:{view:{section:'cash'},form:null},answer:{questionId:'question-current',optionId:'account-first',text:'Otra cuenta'}};
  assert.throws(()=>validateTurnInput(input));
  assert.equal(validateTurnInput({...input,answer:{...input.answer,text:null}}).answer.optionId,'account-first');
  assert.equal(validateTurnInput({...input,answer:{...input.answer,optionId:null}}).answer.text,'Otra cuenta');
});

test('el esquema distingue horario textual de umbral horario numérico',()=>{
  const values=serializeAssistantForm('storefront-settings',{hours:'Lunes a viernes de 8 a 18'});
  assert.equal(values.hours,'Lunes a viernes de 8 a 18');
  assert.throws(()=>validateAssistantFormValues('storefront-settings',{hours:24}));
  assert.equal(validateAssistantFormValues('settings:alert-rule',{thresholds:{hours:24}}).thresholds.hours,24);
  assert.throws(()=>validateAssistantFormValues('settings:alert-rule',{thresholds:{hours:'24'}}));
});
