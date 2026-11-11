import { fail, integer } from '../validation-core.mjs';
import { MAX_MONEY_MINOR, formatMoneyMinor, pesosToMinor } from '../business/money.mjs';
import { businessDate, instant } from '../business/dates.mjs';
import { importFields, isImportFieldAllowed, normalizeImportFieldName, shipmentStates, schemas, settingsFields } from '../schema.mjs';

const formMetadataFields=new Set(['id','version','recordVersion','formId','generation','requestId','createdAt','updatedAt']);
const fieldLabels={
  customerName:'Nombre del destinatario',phone:'Teléfono',department:'Departamento',city:'Ciudad',address:'Dirección',addressNotes:'Referencias de dirección',documentNumber:'Número de documento',email:'Correo electrónico',sellerId:'Vendedor',deliveryMethod:'Modalidad de entrega',shippingChargeMinor:'Flete cobrado',unitPriceMinor:'Precio unitario',unitCostMinor:'Costo unitario',price:'Precio en pesos colombianos',stockQuantity:'Existencias físicas',
  amountMinor:'Importe',accountId:'Cuenta',fromAccountId:'Cuenta de salida',toAccountId:'Cuenta de destino',personId:'Persona responsable',responsibleId:'Responsable',sourceId:'Cuenta de origen',platformId:'Plataforma',orderId:'Pedido',shipmentId:'Envío',expenseId:'Gasto',settlementId:'Liquidación',payrollId:'Período de sueldo',closingId:'Cierre',cashEntryId:'Movimiento',documentId:'Documento',documentType:'Tipo de documento',effectiveOn:'Fecha de vigencia',occurredOn:'Fecha del hecho',placedOn:'Fecha del pedido',incurredOn:'Fecha del gasto',receivedOn:'Fecha de recepción',reportedOn:'Fecha de declaración',openingOn:'Fecha de apertura',closingOn:'Fecha del cierre',startOn:'Inicio del período',endOnExclusive:'Fin del período (exclusivo)',
  concept:'Concepto',reason:'Motivo',reference:'Referencia',supplier:'Proveedor',carrier:'Transportadora',tracking:'Guía',estimatedDeliveryOn:'Entrega estimada',notes:'Notas',detail:'Detalle',openingBalanceMinor:'Saldo de apertura',minimumMinor:'Saldo mínimo',countedMinor:'Efectivo contado',netMinor:'Neto',bonusMinor:'Bonificación',discountMinor:'Descuento',budgetMinor:'Presupuesto total',targetCostMinor:'Costo objetivo',items:'Referencias y cantidades',lines:'Líneas del documento',assignments:'Distribución de cantidades',salaryAgreements:'Convenios de sueldo',commissionOverrides:'Reglas de comisión',commission:'Comisión',rulesVersions:'Vigencias financieras',name:'Nombre',value:'Valor informativo',caption:'Texto de la publicación',headline:'Titular',audience:'Audiencia',placements:'Ubicaciones',aiDisclosure:'Declaración de uso de IA',status:'Estado',state:'Estado',active:'Activo',
};
// Stable slugs, publication state, derived totals, and file uploads remain human-controlled.
const descriptors = {
  'record:products': ['title','description','presentation','flavor','productInfo','price','stockQuantity','sku','unitCostMinor','costEffectiveOn','orderable','featured','productType','items','catalogIds','sort'],
  'record:combos': ['title','description','conditions','price','orderable','items','catalogIds','sort'],
  'record:catalogs': ['title','description','sort'],
  'record:faqs': ['title','answer','sort'],
  'record:messages': ['title','body','buttonText','sort'],
  'record:shipping': ['title','zone','costText','estimatedTime','cashOnDelivery','details','sort'],
  order: ['customerName','phone','city','department','address','addressNotes','placedOn','email','documentType','documentNumber','notes','sellerId','deliveryMethod','shippingChargeMinor','items','marketingCampaign'],
  'shipment-create': ['carrier','tracking','estimatedDeliveryOn','split','assignments','replacesShipmentId'],
  'shipment-metadata': ['carrier','tracking','estimatedDeliveryOn','notes','replacesShipmentId','assignments','reason'],
  'shipment-event': ['status','precision','occurredOn','occurredAt','sourceAsOf','reason','detail'],
  'campaign-draft': ['name','caption','headline','connectionId','assetId','mode','objective','platforms','destinationUrl','whatsappNumber','whatsappGreeting','audience','placements','budgetMinor','targetCostMinor','publishAt','startAt','endAt','observationDays'],
  'asset-metadata': ['name'],
  'advertising-result-action': ['reason'],
  'storefront-settings': ['brandName','tagline','whatsapp','whatsappTemplate','facebook','instagram','email','hours','paymentInfo','showNextStage'],
  'business-action:account-save': ['name','type','responsibleId','openingOn','openingBalanceMinor','minimumMinor','closingEnabled','closingTime','toleranceMinor','active','reason'],
  'settings:person': ['name','active','salaryAgreements','commissionOverrides','reason'],
  'settings:platform': ['name','active','platformId','reason'],
  'settings:source': ['name','active','platformId','reason'],
  'settings:policy': ['effectiveOn','saleRecognition','commission','shippingExpenseDate','returnExpenseDate','platformFeeExpenseDate','reason'],
  'settings:preferences': ['defaultReceiptAccountId','defaultPaymentAccountId','reportsStartOn','reportGenerationTime','reportPeriods','alertDefaults','reason'],
  'settings:alert-rule': ['enabled','thresholds','selectedStatuses','responsibleId','reminderHours','reason'],
  'settings:alert': ['responsibleId','state','reason'],
  'business-action:collection': ['orderId','version','amountMinor','occurredOn','holder','accountId','shipmentId','method','reference','allowCredit'],
  'business-action:refund': ['orderId','version','amountMinor','occurredOn','holder','accountId','shipmentId','method','reference','reason'],
  'business-action:expense': ['expenseId','version','category','amountMinor','incurredOn','concept','supplier','personId','orderId','shipmentId','sourceKey','accountId','effectiveOn','reference','reason','reviewConfirmed'],
  'business-action:expense-recovery': ['expenseId','version','amountMinor','accountId','effectiveOn','reason','reference'],
  'business-action:pay-expense': ['expenseId','version','amountMinor','accountId','effectiveOn','reference'],
  'business-action:settlement-save': ['settlementId','version','sourceId','externalKey','reportedOn','netMinor','lines','reason'],
  'business-action:settlement-confirm': ['settlementId','version','receivedOn','accountId','externalKey','lines','reason'],
  'business-action:transfer': ['fromAccountId','toAccountId','effectiveOn','amountMinor','concept','reference'],
  'business-action:cash-close': ['accountId','closingOn','countedMinor'],
  'business-action:cash-reopen': ['closingId','version','reason'],
  'business-action:cash-reverse': ['cashEntryId','effectiveOn','reason'],
  'business-action:document-reverse': ['documentType','documentId','version','effectiveOn','reason'],
  'business-action:resolve-legacy-payment': ['orderId','version','mode','accountId','occurredOn','method','reference','reason','receiptAmountMinor','refundAmountMinor','receiptOn','refundOn'],
  'business-action:return': ['orderId','version','occurredOn','reason','shippingCreditMinor','lines','inventoryOpeningIncluded'],
  'business-action:payroll-prepare': ['personId','startOn','endOnExclusive','bonusMinor','discountMinor','reason'],
  'business-action:payroll-confirm': ['payrollId','version','personId','startOn','endOnExclusive','bonusMinor','discountMinor','reason'],
  'business-action:payroll-pay': ['payrollId','version','amountMinor','accountId','effectiveOn','reference'],
  'business-action:advance': ['personId','accountId','effectiveOn','amountMinor','concept','reference'],
  'business-action:income': ['accountId','effectiveOn','amountMinor','concept','description','reference'],
  'business-action:complete-costs': ['orderId','version','reason','lineCosts'],
  'business-action:link-shipment': ['shipmentId','orderId','version','reason','assignments'],
  'import-draft': ['config'],
  'import-resolver': ['reason','value'],
  'import-source-name': ['name'],
  'import-platform-name': ['name'],
  'import-profile-name': ['name'],
  'onboarding:cash': ['accountId','responsibleId','accountName','responsibleName','openingOn','openingBalanceMinor'],
  'onboarding:product': ['title','price','stockQuantity','presentation','sku','unitCostMinor'],
};
export function assistantFieldLabel(target, key) {
  const kind = target.startsWith('record:') ? target.slice('record:'.length) : null;
  const recordLabel = kind && schemas[kind]?.fields.find(field => field.name === key)?.label;
  const settingLabel = target === 'storefront-settings' && settingsFields.find(field => field.name === key)?.label;
  const known = recordLabel || settingLabel;
  if (known) return known;
  if(fieldLabels[key])return fieldLabels[key];
  const readable = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ');
  return readable.charAt(0).toLocaleUpperCase('es') + readable.slice(1);
}

const nonPatchable = new Set([
  'id','version','recordVersion','formId','generation','requestId','status','state','statusReason','cancellationOn','correctionOf','replacesShipmentId',
  'allowCredit','reviewConfirmed','inventoryOpeningIncluded','setupPolicyConfirmed','launchApproved','aiDisclosure',
]);
const nonPatchableByTarget = {
  order: new Set(['sellerId']),
  'shipment-event': new Set(['status']),
  'shipment-metadata': new Set(['replacesShipmentId']),
  'storefront-settings': new Set(['showNextStage']),
  'settings:person': new Set(['active']),
  'settings:platform': new Set(['active','platformId']),
  'settings:source': new Set(['active','platformId']),
  'settings:alert': new Set(['state']),
  'business-action:account-save': new Set(['type','active','closingEnabled']),
  'business-action:return': new Set(['inventoryOpeningIncluded']),
};
const privateKey = /(?:token|secret|password|csrf|api.?key|credential|auth|private.?key|ciphertext|file|preview|consent)/i;
const blockedNestedKey = /(?:token|secret|password|csrf|api.?key|credential|auth|file|preview|consent|confirmation|acknowledge|review|approved|identitymode|statusmap|reportasof|openingconfirmed|oneorderperguide|includevalidonly|setupPolicyConfirmed|launchApproved|expenseGroupNames|expenseCategoryMap)/i;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isPlainObject = value => value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const dangerous = key => key === '__proto__' || key === 'constructor' || key === 'prototype';

const importReadOnlyConfigKeys = new Set(['statusMap','oneOrderPerGuide','reportAsOf','defaults','identityMode','expenseGroupNames','expenseCategoryMap']);

function safeValue(value, depth = 0, target = null) {
  if (depth > 10) fail('Formulario demasiado profundo.');
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (value.length > 200) fail('Formulario demasiado grande.');
    return value.map(item => safeValue(item, depth + 1, target));
  }
  if (!isPlainObject(value)) return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (dangerous(key)) fail('Clave de objeto no permitida.');
    const readOnlyImportValue = target === 'import-draft' && importReadOnlyConfigKeys.has(key);
    if (privateKey.test(key) || (blockedNestedKey.test(key) && !readOnlyImportValue)) continue;
    const safe = safeValue(item, depth + 1, target);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

const fieldMaxima = {
  'record:products': { title:160, description:3000, productInfo:4000, sku:200 },
  'record:combos': { title:160, description:4000, conditions:4000 },
  'record:catalogs': { title:160, description:4000 },
  'record:faqs': { title:160, answer:5000 },
  'record:messages': { title:160, body:3000, buttonText:200 },
  'record:shipping': { title:160, zone:200, costText:4000, estimatedTime:200, cashOnDelivery:4000, details:4000 },
  order: { customerName:150, phone:30, city:100, department:100, address:1000, addressNotes:1000, email:254, documentType:30, documentNumber:80, notes:3000, marketingCampaign:200 },
  'shipment-create': { carrier:200, tracking:200 },
  'shipment-metadata': { carrier:200, tracking:200, notes:4000, reason:2000 },
  'shipment-event': { reason:2000, detail:4000 },
  'campaign-draft': { name:200, caption:2200, headline:40, destinationUrl:2048, whatsappNumber:16, whatsappGreeting:1024 },
  'asset-metadata': { name:200 },
  'advertising-result-action': { reason:500 },
  'import-resolver': { reason:2000, value:4000 },
  'storefront-settings': { brandName:200, tagline:500, whatsapp:30, whatsappTemplate:2000, facebook:2048, instagram:2048, email:254, hours:1000, paymentInfo:4000 },
  'business-action:account-save': { name:200, reason:2000 },
  'settings:person': { name:200, reason:2000 },
  'settings:platform': { name:200, reason:2000 },
  'settings:source': { name:200, reason:2000 },
  'settings:policy': { reason:2000 },
  'settings:preferences': { reportGenerationTime:5, reason:2000 },
  'settings:alert-rule': { reason:2000 },
  'settings:alert': { reason:2000 },
  'business-action:collection': { holder:30, method:100, reference:200 },
  'business-action:refund': { holder:30, method:100, reference:200, reason:2000 },
  'business-action:expense': { category:80, concept:300, supplier:200, sourceKey:200, reference:200, reason:2000 },
  'business-action:expense-recovery': { reference:200, reason:2000 },
  'business-action:pay-expense': { reference:200 },
  'business-action:settlement-save': { externalKey:200, reason:2000 },
  'business-action:settlement-confirm': { externalKey:200, reason:2000 },
  'business-action:transfer': { concept:300, reference:200 },
  'business-action:cash-reopen': { reason:2000 },
  'business-action:cash-reverse': { reason:2000 },
  'business-action:document-reverse': { reason:2000 },
  'business-action:resolve-legacy-payment': { method:100, reference:200, reason:2000 },
  'business-action:return': { reason:2000 },
  'business-action:payroll-prepare': { reason:2000 },
  'business-action:payroll-confirm': { reason:2000 },
  'business-action:payroll-pay': { reference:200 },
  'business-action:advance': { concept:300, reference:200 },
  'business-action:income': { concept:300, description:2000, reference:200 },
  'business-action:complete-costs': { reason:2000 },
  'business-action:link-shipment': { reason:2000 },
  'import-draft': { sheetName:100, header:500, fieldName:100, destination:100, expenseCampaign:200, expenseConcept:500, expenseSupplier:200 },
  'import-platform-name': { name:150 },
  'import-source-name': { name:150 },
  'import-profile-name': { name:150 },
  'onboarding:cash': { accountName:200, responsibleName:200 },
  'onboarding:product': { title:160, presentation:500, sku:200 },
};

const booleanFields = new Set([
  'orderable','featured','active','enabled','closingEnabled','split','selected','showNextStage','allowCredit','reviewConfirmed',
]);
const dateFields = new Set([
  'costEffectiveOn','placedOn','estimatedDeliveryOn','occurredOn','effectiveOn','shippingExpenseDate',
  'returnExpenseDate','platformFeeExpenseDate','openingOn','closingOn','startOn','endOnExclusive',
  'reportedOn','receivedOn','incurredOn','refundOn','receiptOn','effectiveFrom','effectiveTo',
]);
const extraDateFields=new Set(['reportsStartOn','cancellationOn','occurredAt','sourceAsOf','publishAt','startAt','endAt','reportAsOf']);
export function assistantEconomicFieldKind(field) {
  if(/Minor$/.test(field)||field==='price')return 'money';
  return dateFields.has(field)||extraDateFields.has(field)?'date':null;
}
const numberFields = new Set([
  'price','stockQuantity','sort','quantity','unitPriceMinor','discountMinor','shippingChargeMinor',
  'amountMinor','openingBalanceMinor','minimumMinor','toleranceMinor','countedMinor','netMinor','budgetMinor','targetCostMinor','observationDays','ageMin','ageMax',
  'grossMinor','bonusMinor','shippingCreditMinor','receiptAmountMinor','refundAmountMinor',
  'unitCostMinor','rateBps','fixedMinor','amountPerPeriodMinor','payDayOffset','reminderHours',
  'headerRow','index','group','threshold','hours','days','amount',
]);
const arrayFields = new Set([
  'items','catalogIds','lines','deductions','lineCosts','components','assignments','salaryAgreements',
  'commissionOverrides','selectedStatuses','reportPeriods','sheets','columns','platforms','placements','countries','regions','cities','genders','interests',
]);

function checkString(target, key, value, { path = '', depth = 0 } = {}) {
  if (typeof value !== 'string') fail(`${key}: se esperaba texto.`);
  const max = fieldMaxima[target]?.[key] ?? (/Id$/.test(key) || key === 'id' || key === 'lineId' ? 200 : 4000);
  if (value.length > max) fail(`${key}: máximo ${max} caracteres.`);
  const policyDateRule=target==='settings:policy'&&['shippingExpenseDate','returnExpenseDate','platformFeeExpenseDate'].includes(key);
  if (!policyDateRule && (dateFields.has(key) || /(?:On|Date)$/.test(key)) && value) businessDate(value, key);
  if (['occurredAt','sourceAsOf'].includes(key) && value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) fail(`${key}: fecha y hora no válida.`);
    businessDate(value.slice(0,10), key);
    const [hour, minute] = value.slice(11,16).split(':').map(Number);
    if (hour > 23 || minute > 59) fail(`${key}: hora no válida.`);
  }
  if (key === 'reportGenerationTime' && value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('Hora de informe no válida.');
  const enumByTarget = {
    'record:products': { productType:['product','gift'] },
    order: { deliveryMethod:['carrier','local','pickup'] },
    'shipment-event': { precision:['day','instant','unknown'] },
    'campaign-draft': { mode:['organic','paid'], objective:['whatsapp','traffic','reach','engagement'], platforms:['facebook','instagram'], placements:['facebook_feed','facebook_reels','instagram_feed','instagram_reels'] },
    'business-action:account-save': { type:['cash','bank','wallet'] },
    'business-action:resolve-legacy-payment': { mode:['opening_balance','cash_movement','receipt','refund'] },
    'settings:policy': { saleRecognition:['confirmed','dispatched','delivered'], shippingExpenseDate:['dispatch_date','charge_date'], returnExpenseDate:['charge_date','returned_date'], platformFeeExpenseDate:['charge_date','settlement_date'] },
    'settings:alert-rule': { selectedStatuses:['label_created','collected','in_transit','out_for_delivery','delivered','incident','return_in_transit','returned','cancelled','unknown'] },
  }[target]?.[key];
  if (key === 'kind' && !['products','combos'].includes(value)) fail('Tipo de referencia no permitido.');
  if (target === 'shipment-event' && key === 'status' && !shipmentStates.some(state=>state.value===value)) fail('Estado de envío no permitido.');
  if (key === 'productType' && !['product','gift'].includes(value)) fail('Tipo de producto no permitido.');
  if (key === 'condition' && !['recoverable','non_recoverable'].includes(value)) fail('Condición de devolución no permitida.');
  if (enumByTarget && value && !enumByTarget.includes(value)) fail(`${key}: opción no permitida.`);
  if (key === 'frequency' && !['weekly','halfmonthly','monthly'].includes(value)) fail('Frecuencia no permitida.');
  if (key === 'mode' && path.includes('commission') && !['percent','fixed'].includes(value)) fail('Modo de comisión no permitido.');
  if (key === 'basis' && !['net_products'].includes(value)) fail('Base de comisión no permitida.');
  if (key === 'earnWhen' && !['business_received','delivered','customer_paid'].includes(value)) fail('Devengo no permitido.');
  if (key === 'purpose' && !['orders','tracking','settlements','expenses','allocations','component_costs','observations'].includes(value)) fail('Propósito de hoja no permitido.');
  if (key === 'layout' && !['item_rows','order_rows','expense_rows','expense_columns','relation_rows'].includes(value)) fail('Diseño de hoja no permitido.');
  if (key === 'dateFormat' && !['DMY','MDY','ISO'].includes(value)) fail('Formato de fecha no permitido.');
  if (key === 'decimalSeparator' && ![',','.'].includes(value)) fail('Separador decimal no permitido.');
  if (key === 'groupSeparator' && !['.',',',' ','','\u00a0'].includes(value)) fail('Separador de miles no permitido.');
  return value;
}

function checkNumber(target, key, value, parent = '') {
  if (!Number.isSafeInteger(value)) fail(`${key}: se esperaba un entero seguro.`);
  integer(value, key, -MAX_MONEY_MINOR, MAX_MONEY_MINOR);
  const signedAccountField=['business-action:account-save','onboarding:cash'].includes(target)&&['openingBalanceMinor','minimumMinor'].includes(key);
  if (/Minor$/i.test(key) && value < 0 && key !== 'netMinor' && parent !== 'deductions' && !signedAccountField) fail(`${key}: importe negativo.`);
  if (key === 'price' && (value < 0 || value > MAX_MONEY_MINOR / 100)) fail('Precio fuera de rango.');
  if (key === 'sort' && value < 0) fail('Orden negativo no permitido.');
  if (key === 'quantity' && (value < 0 || value > 999)) fail('Cantidad fuera de rango.');
  if (key === 'quantity' && parent === 'items' && value < 1) fail('La cantidad debe ser positiva.');
  if (key === 'rateBps' && (value < 0 || value > 10_000)) fail('Tasa fuera de rango.');
  if (key === 'reminderHours' && (value < 1 || value > 87600)) fail('Recordatorio fuera de rango.');
  if (key === 'payDayOffset' && (value < 0 || value > 90)) fail('Días de pago fuera de rango.');
  if (key === 'headerRow' && (value < 1 || value > 10_000)) fail('Fila de encabezado fuera de rango.');
  if (key === 'index' && (value < 0 || value > 199)) fail('Índice de columna fuera de rango.');
  if (key === 'group' && (value < 0 || value > 49)) fail('Grupo fuera de rango.');
  if (key === 'stockQuantity' && (value < 0 || value > 1_000_000)) fail('Existencias fuera de rango.');
  return value;
}

function exactNested(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label}: objeto inválido.`);
  for (const key of Object.keys(value)) {
    if (dangerous(key) || !allowed.includes(key)) fail(`${label}: campo no permitido (${key}).`);
  }
}

const nestedFields = {
  items: ['productId','lineId','kind','itemId','quantity','unitPriceMinor','discountMinor','title','productType'],
  lines: ['lineId','quantity','condition','collectionId','grossMinor','deductions','label'],
  deductions: ['expenseId','amountMinor','label'],
  lineCosts: ['lineId','selected','unitCostMinor','components'],
  components: ['productId','unitCostMinor'],
  salaryAgreements: ['id','enabled','amountPerPeriodMinor','frequency','effectiveFrom','effectiveTo','payDayOffset'],
  commissionOverrides: ['id','effectiveOn','enabled','mode','rateBps','fixedMinor','basis','earnWhen'],
};
const expectedNested = (target, key) => {
  if (key === 'items' && ['record:products','record:combos'].includes(target)) return ['productId','quantity'];
  if (key === 'items' && target === 'order') return ['lineId','kind','itemId','quantity','unitPriceMinor','discountMinor','title','productType'];
  if (key === 'columns') return ['index','header','destination','group','fieldName'];
  if (key === 'sheets') return ['sheetName','enabled','headerRow','dateFormat','decimalSeparator','groupSeparator','layout','purpose','columns','statusMap','oneOrderPerGuide','reportAsOf','defaults','identityMode','expenseGroupNames','expenseCategoryMap'];
  if (key === 'commission') return ['enabled','mode','rateBps','fixedMinor','basis','earnWhen'];
  if (key === 'thresholds') return ['hours','days','amount','unit'];
  if (key === 'audience') return ['countries','regions','cities','ageMin','ageMax','genders','interests'];
  if (key === 'alertDefaults') return ['responsibleId','reminderHours'];
  if (key === 'assignments' && target === 'business-action:link-shipment') return ['lineId','quantity'];
  if (key === 'assignments' && ['shipment-create','shipment-metadata'].includes(target)) return null;
  return nestedFields[key]||null;
};

function checkImportConfig(value, { patch, depth, baseline }) {
  exactNested(value, ['formatVersion','sheets'], 'Configuración de importación');
  if (patch && value.formatVersion != null && value.formatVersion !== 2) fail('Versión de configuración de importación no permitida.');
  if (value.formatVersion != null && value.formatVersion !== 2) fail('Versión de configuración de importación no permitida.');
  if (!Array.isArray(value.sheets) || value.sheets.length > 100) fail('Hojas de importación inválidas.');
  const baseConfig=baseline?.config || baseline;
  const purposes=['orders','tracking','settlements','expenses','allocations','component_costs','observations'];
  const layoutOptions=purpose=>['allocations','component_costs','observations'].includes(purpose)
    ? ['relation_rows'] : purpose==='expenses' ? ['expense_rows','expense_columns'] : ['item_rows','order_rows'];
  const statuses=new Set(['label_created','collected','in_transit','out_for_delivery','delivered','incident','return_in_transit','returned','cancelled','unknown']);
  const categories=new Set(['advertising','operating','other']);
  const output = {};
  if (value.formatVersion != null || !patch) output.formatVersion = 2;
  output.sheets = value.sheets.map(sheet => {
    exactNested(sheet, expectedNested('import-draft','sheets'), 'Hoja');
    const original=baseConfig?.sheets?.find(item=>item.sheetName===sheet.sheetName);
    const effective={...(original || {}),...sheet};
    const checkedSheet = {};
    for (const [key, item] of Object.entries(sheet)) {
      if (patch && !['sheetName','headerRow','dateFormat','decimalSeparator','groupSeparator','layout','purpose','columns'].includes(key)) {
        fail(`Campo de control de importación no editable (${key}).`);
      }
      if (key === 'sheetName') {
        if (typeof item !== 'string' || item.length>100 || /[\u0000-\u001f\u007f]/.test(item)) fail('Nombre de hoja no válido.');
        checkedSheet[key]=item;
      }
      else if (key === 'enabled') {
        if (typeof item !== 'boolean') fail('enabled: se esperaba un booleano.');
        checkedSheet[key] = item;
      } else if (key === 'columns') {
        if (!Array.isArray(item) || item.length > 200) fail('Asigna como máximo 200 columnas.');
        checkedSheet[key] = item.map(column => {
          exactNested(column, expectedNested('import-draft','columns'), 'Columna');
          const checked = {};
          for (const [columnKey,columnValue] of Object.entries(column)) {
            if (patch && !['index','header','destination','group','fieldName'].includes(columnKey)) fail(`Campo de columna no permitido (${columnKey}).`);
            if (columnKey === 'index' || columnKey === 'group') checked[columnKey]=checkNumber('import-draft',columnKey,columnValue,'columns');
            else if (columnKey === 'header' || columnKey === 'fieldName') checked[columnKey]=checkString('import-draft',columnKey,columnValue);
            else if (columnKey === 'destination') {
              if (typeof columnValue !== 'string' || (columnValue !== 'ignore' && !(columnValue===''&&!patch) && !importFields.some(field=>field.value===columnValue))) fail('Destino de importación no permitido.');
              if (columnValue && columnValue !== 'ignore' && effective.purpose && !isImportFieldAllowed(columnValue,effective.purpose)) fail('Destino incompatible con el propósito de la hoja.');
              checked[columnKey]=columnValue;
            }
          }
          if (checked.destination && checked.destination !== 'ignore') {
            const field=importFields.find(candidate=>candidate.value===checked.destination);
            if (field?.type !== 'additional' && Object.hasOwn(checked,'fieldName')) fail('Nombre adicional solo disponible para destinos personalizados.');
            if (field?.type === 'additional' && !checked.fieldName?.trim()) fail('El campo adicional necesita un nombre.');
          }
          return checked;
        });
      } else if (key === 'headerRow') checkedSheet[key]=checkNumber('import-draft',key,item,'sheet');
      else if (key === 'dateFormat') checkedSheet[key]=checkString('import-draft',key,item);
      else if (key === 'decimalSeparator' || key === 'groupSeparator' || key === 'layout' || key === 'purpose') {
        checkedSheet[key]=checkString('import-draft',key,item);
      } else if (key === 'oneOrderPerGuide') {
        if (typeof item !== 'boolean') fail('oneOrderPerGuide: se esperaba un booleano.');
        checkedSheet[key]=item;
      } else if (key === 'statusMap') {
        if (!isPlainObject(item) || Object.keys(item).length>500) fail('Equivalencias de estado inválidas.');
        const map={};
        const seen=new Set();
        for (const [from,to] of Object.entries(item)) {
          if (dangerous(from) || !from.trim() || from.length>500 || typeof to!=='string' || !statuses.has(to)) fail('Equivalencia de estado no permitida.');
          const normalized=from.trim();
          if (seen.has(normalized)) fail('La equivalencia de estado se repite.');
          seen.add(normalized);
          map[normalized]=to;
        }
        checkedSheet[key]=map;
      } else if (key === 'reportAsOf') {
        if (item == null || item === '') checkedSheet[key]=null;
        else if (typeof item === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item)) checkedSheet[key]=businessDate(item,'Fecha de corte');
        else if (typeof item === 'string') checkedSheet[key]=instant(item,'Fecha de corte');
        else fail('Fecha de corte inválida.');
      } else if (key === 'identityMode') {
        if (!['provided','generated'].includes(item)) fail('Modo de identidad no permitido.');
        checkedSheet[key]=item;
      } else if (key === 'defaults') {
        if (!isPlainObject(item)) fail('Valores fijos inválidos.');
        const purpose=effective.purpose || 'orders';
        const auxiliary=['allocations','component_costs','observations'].includes(purpose);
        const allowed=purpose==='expenses'
          ? ['expenseCategory','expenseConcept','expenseSupplier','expenseCampaign']
          : purpose==='orders' ? ['deliveryMethod','carrier','giftQuantity'] : auxiliary ? [] : ['deliveryMethod','carrier'];
        const defaults={};
        for (const [name,defaultValue] of Object.entries(item)) {
          if (!allowed.includes(name) || dangerous(name)) fail('Valor fijo no permitido.');
          if (name==='giftQuantity') defaults[name]=integer(defaultValue,name,1,999);
          else if (name==='expenseCategory') {
            if (!categories.has(defaultValue)) fail('Categoría fija no permitida.');
            defaults[name]=defaultValue;
          } else if (name==='deliveryMethod') {
            if (!['carrier','local','pickup'].includes(defaultValue)) fail('Modalidad fija no permitida.');
            defaults[name]=defaultValue;
          } else {
            const maximum=name==='expenseConcept'?500:200;
            if (typeof defaultValue!=='string' || !defaultValue.trim() || defaultValue.length>maximum) fail('Valor fijo de texto no válido.');
            defaults[name]=defaultValue;
          }
        }
        checkedSheet[key]=defaults;
      } else if (key === 'expenseGroupNames' || key === 'expenseCategoryMap') {
        const maxEntries=key==='expenseGroupNames'?50:100;
        if (!isPlainObject(item) || Object.keys(item).length>maxEntries) fail(`${key}: mapa inválido.`);
        if (key==='expenseGroupNames' && effective.layout!=='expense_columns' && Object.keys(item).length) fail('Los grupos requieren gastos por columnas.');
        if (key==='expenseCategoryMap' && effective.purpose!=='expenses' && Object.keys(item).length) fail('Equivalencias de categoría solo para gastos.');
        const map={};
        const unique=new Set();
        for (const [from,to] of Object.entries(item)) {
          if (dangerous(from) || !from.trim()) fail(`${key}: clave vacía o no permitida.`);
          if (key==='expenseGroupNames') {
            if (!/^(?:0|[1-4]?\d)$/.test(from)) fail('Grupo de campaña no válido.');
            if (typeof to!=='string' || !to.trim() || to.length>200) fail('Nombre de campaña no válido.');
            const normalized=normalizeImportFieldName(to);
            if (unique.has(normalized)) fail('Los nombres de campaña se repiten.');
            unique.add(normalized);
            map[from]=to;
          } else {
            if (from.length>200 || !categories.has(to)) fail('Equivalencia de categoría no permitida.');
            const normalized=normalizeImportFieldName(from);
            if (unique.has(normalized)) fail('Las categorías de origen se repiten.');
            unique.add(normalized);
            map[from.trim()]=to;
          }
        }
        checkedSheet[key]=map;
      }
    }
    const purpose=effective.purpose || 'orders';
    const layouts=layoutOptions(purpose);
    const layout=effective.layout || layouts[0];
    if (!purposes.includes(purpose) || !layouts.includes(layout)) fail('Distribución incompatible con el propósito de importación.');
    if (effective.identityMode==='generated' && !(purpose==='expenses' || purpose==='orders' && layout==='order_rows')) fail('El modo de identidad generada no corresponde a esta distribución.');
    return checkedSheet;
  });
  return output;
}

function assertImportPatchIdentity(config,baseline) {
  if (!config || !baseline) return;
  const baseConfig=baseline.config || baseline;
  const knownSheets=baseConfig?.sheets;
  if (!Array.isArray(knownSheets)) fail('Falta la configuración original de importación.');
  for (const sheet of config.sheets || []) {
    if (typeof sheet.sheetName !== 'string') fail('La hoja necesita su nombre original.');
    const original=knownSheets.find(item=>item.sheetName===sheet.sheetName);
    if (!original) fail('La propuesta referencia una hoja ajena a esta configuración.');
    for (const column of sheet.columns || []) {
      if (!Number.isSafeInteger(column.index)) fail('La columna necesita su índice original.');
      const old=original.columns?.find(item=>item.index===column.index);
      if (!old || (column.header != null && column.header!==old.header)) fail('La propuesta referencia una columna ajena al archivo.');
    }
  }
}

function checkNestedObject(target,key,value,{patch,depth,baseline}) {
  if (key === 'config') return checkImportConfig(value,{patch,depth,baseline});
  if (key === 'assignments' && ['shipment-create','shipment-metadata'].includes(target)) {
    const assignments = {};
    const entries = Array.isArray(value) ? value.map(item => {
      exactNested(item,['lineId','quantity'],'Asignación');
      return [item.lineId,item.quantity];
    }) : isPlainObject(value) ? Object.entries(value) : null;
    if (!entries) fail('Asignaciones inválidas.');
    for (const [id, quantity] of entries) {
      if (typeof id !== 'string' || dangerous(id) || !id || id.length > 200 || own(assignments,id)) fail('Referencia de asignación inválida.');
      assignments[id] = checkNumber(target,'quantity',quantity,'assignments');
    }
    return assignments;
  }
  const allowed = expectedNested(target,key);
  exactNested(value, allowed || [], key);
  const output = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (blockedNestedKey.test(childKey) || privateKey.test(childKey)) {
      if (patch) fail(`${key}: campo de control no permitido (${childKey}).`);
      continue;
    }
    output[childKey] = checkValue(target,childKey,child,{patch,depth:depth+1,parent:key,path:`${key}.${childKey}`,baseline});
  }
  if (key === 'commission') {
    if (output.mode != null && !['percent','fixed'].includes(output.mode)) fail('Modo de comisión no permitido.');
    if (output.basis != null && output.basis !== 'net_products') fail('Base de comisión no permitida.');
    if (output.earnWhen != null && !['business_received','delivered','customer_paid'].includes(output.earnWhen)) fail('Devengo no permitido.');
  }
  if (key === 'thresholds') {
    const bounds = {hours:[1,87600],days:[1,3650],amount:[1,3650],unit:['day','week','month']};
    for (const [name, item] of Object.entries(output)) {
      const choices = bounds[name];
      if (Array.isArray(choices) && typeof choices[0] === 'number' && (item < choices[0] || item > choices[1])) fail('Umbral fuera de rango.');
      if (Array.isArray(choices) && typeof choices[0] === 'string' && !choices.includes(item)) fail('Unidad de umbral no permitida.');
    }
  }
  if (key === 'alertDefaults' && own(output,'reminderHours') && (output.reminderHours < 1 || output.reminderHours > 87600)) fail('Recordatorio fuera de rango.');
  return output;
}

function checkValue(target,key,value,{patch=false,depth=0,parent='',path=key,baseline=null}={}) {
  if (depth > 10) fail(`${key}: estructura demasiado profunda.`);
  if (value == null) return value;
  const schemaField=parent?null:(target==='storefront-settings'?settingsFields:target.startsWith('record:')?schemas[target.slice(7)]?.fields:null)?.find(field=>field.name===key);
  if(schemaField&&!['checkbox','number','money','optionalNumber','moneyOptionalMinor','multi','comboItems'].includes(schemaField.type))return checkString(target,key,value,{path,depth});
  if (booleanFields.has(key)) {
    if (typeof value !== 'boolean') fail(`${key}: se esperaba un booleano.`);
    return value;
  }
  if (numberFields.has(key)) return checkNumber(target,key,value,parent);
  if (key === 'assignments' && ['shipment-create','shipment-metadata'].includes(target)) return checkNestedObject(target,key,value,{patch,depth,baseline});
  if (Array.isArray(value)) {
    if (!arrayFields.has(key) && !['items','columns','sheets'].includes(key)) fail(`${key}: lista no permitida.`);
    if (value.length > (key === 'items' || key === 'lines' ? 100 : 200)) fail(`${key}: lista demasiado grande.`);
    if (key === 'catalogIds') return value.map(id => checkString(target,'catalogId',id,{path}));
    if (key==='genders')return value.map(item=>{if(![1,2].includes(item))fail('Género de audiencia no permitido.');return item;});
    if (['platforms','placements','countries'].includes(key)) return value.map(item=>checkString(target,key,item,{path}));
    if (['regions','cities','interests'].includes(key) && target === 'campaign-draft') return value.map(item=> {
      if (typeof item === 'string') return checkString(target,key,item,{path});
      exactNested(item,['key','source','providerId','label','context'],key);
      return boundedSubmissionValue(item,depth+1);
    });
    if (key === 'selectedStatuses') {
      const allowed = new Set(['label_created','collected','in_transit','out_for_delivery','delivered','incident','return_in_transit','returned','cancelled','unknown']);
      return value.map(status => {
        const item = checkString(target,key,status,{path});
        if (!allowed.has(item)) fail('Estado logístico no permitido.');
        return item;
      });
    }
    if (key === 'reportPeriods') {
      const allowed = new Set(['day','week','month','quarter','halfyear','year']);
      return value.map(period => {
        const item = checkString(target,key,period,{path});
        if (!allowed.has(item)) fail('Periodicidad de informe no permitida.');
        return item;
      });
    }
    return value.map(item => {
    const nested = expectedNested(target,key);
      if (!isPlainObject(item)) fail(`${key}: elemento inválido.`);
      exactNested(item,nested || [],key);
      const out = {};
      for (const [childKey,child] of Object.entries(item)) {
        if (blockedNestedKey.test(childKey) || privateKey.test(childKey)) {
          if (patch) fail(`${key}: campo de control no permitido (${childKey}).`);
          continue;
        }
        out[childKey] = checkValue(target,childKey,child,{patch,depth:depth+1,parent:key,path:`${path}.${childKey}`,baseline});
      }
      return out;
    });
  }
  if (isPlainObject(value)) return checkNestedObject(target,key,value,{patch,depth,baseline});
  if (typeof value === 'string') return checkString(target,key,value,{path,depth});
  fail(`${key}: tipo de valor no válido.`);
}

function refValues(value, out = new Set()) {
  if (Array.isArray(value)) for (const item of value) refValues(item,out);
  else if (isPlainObject(value)) for (const [key,item] of Object.entries(value)) {
    if ((key === 'id' || key === 'lineId' || /(?:Id|ID)$/.test(key)) && typeof item === 'string') out.add(`${key}:${item}`);
    refValues(item,out);
  }
  return out;
}
function choiceSet(referenceChoices,path,key,context) {
  if (path === 'assignments' && key === 'lineId' && isPlainObject(referenceChoices?.assignments)) {
    return new Set(Object.keys(referenceChoices.assignments));
  }
  let choice = referenceChoices?.[`${path}.${key}`] ?? referenceChoices?.[key] ?? referenceChoices?.[path];
  if (choice && !Array.isArray(choice) && !(choice instanceof Set) && typeof choice === 'object') choice = choice[context?.kind];
  return choice instanceof Set ? choice : Array.isArray(choice) ? new Set(choice.map(String)) : null;
}
function assignmentChoiceLimit(referenceChoices,id) {
  const choices = referenceChoices?.assignments;
  if (Array.isArray(choices) || choices instanceof Set) return null;
  const item = choices?.[id];
  if (Number.isSafeInteger(item) && item >= 0) return item;
  const limit = item?.maxQuantity ?? item?.quantity;
  return Number.isSafeInteger(limit) && limit >= 0 ? limit : null;
}
function assignmentBaselineLimit(baseline,id) {
  let limit = null;
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isPlainObject(value)) return;
    if (value.lineId === id && Number.isSafeInteger(value.quantity) && value.quantity >= 0) limit = Math.max(limit ?? 0,value.quantity);
    for (const item of Object.values(value)) visit(item);
  };
  visit(baseline);
  return limit;
}
function assertKnownReferences(value,baseline,referenceChoices) {
  const known = refValues(baseline || {});
  const baselineList = path => {
    const parts = path.split('.');
    let item = baseline;
    for (const part of parts) item = item?.[part];
    return Array.isArray(item) ? item : [];
  };
  const check = (item,path='',context={}) => {
    if (Array.isArray(item)) {
      const choices = choiceSet(referenceChoices,path,'',context);
      const existing = new Set(baselineList(path).filter(value=>typeof value==='string'));
      for (const child of item) {
        if (path === 'catalogIds' && typeof child === 'string'
          && !existing.has(child) && !choices?.has(child)) fail(`Referencia no autorizada en ${path}.`);
        check(child,path,context);
      }
      return;
    }
    if (!isPlainObject(item)) return;
    const local = { ...context, ...(typeof item.kind === 'string' ? {kind:item.kind} : {}) };
    if (path === 'assignments') {
      if (own(item,'lineId') && own(item,'quantity')) {
        const id = item.lineId, quantity = item.quantity;
        const limit = assignmentChoiceLimit(referenceChoices,id) ?? assignmentBaselineLimit(baseline,id);
        if (typeof id !== 'string' || !id || limit == null) fail('La asignación referencia una línea ajena al formulario.');
        if (quantity > limit) fail('La cantidad asignada supera la cantidad permitida para esa línea.');
      } else for (const [id,quantity] of Object.entries(item)) {
        const limit = assignmentChoiceLimit(referenceChoices,id) ?? assignmentBaselineLimit(baseline,id);
        if (limit == null) fail('La asignación referencia una línea ajena al formulario.');
        if (quantity > limit) fail('La cantidad asignada supera la cantidad permitida para esa línea.');
      }
    }
    for (const [key,child] of Object.entries(item)) {
      const childPath = path ? `${path}.${key}` : key;
      if ((key === 'id' || key === 'lineId' || /(?:Id|ID)$/.test(key)) && typeof child === 'string') {
        const choices = choiceSet(referenceChoices,path,key,local);
        if (!known.has(`${key}:${child}`) && !choices?.has(child)) fail(`Referencia no presente en el formulario ni en opciones autorizadas: ${key}.`);
      }
      check(child,childPath,local);
    }
  };
  check(value);
}

export function assistantFormDescriptor(target) {
  if (!Object.hasOwn(descriptors,target)) return null;
  const fields = descriptors[target].filter(field=>!formMetadataFields.has(field));
  const blocked = new Set([...nonPatchable,...(nonPatchableByTarget[target] || [])]);
  const patchFields = fields.filter(field => !blocked.has(field) && !/(?:Version|Generation)$/.test(field));
  return Object.freeze({target,fields:Object.freeze([...fields]),patchFields:Object.freeze(patchFields)});
}
export function assistantFormTargets() { return Object.keys(descriptors); }

function hasReferences(value,path='') {
  if (Array.isArray(value)) {
    if (path === 'catalogIds' && value.length) return true;
    return value.some(item=>hasReferences(item,path));
  }
  if (!isPlainObject(value)) return false;
  if (path === 'assignments' && Object.keys(value).length) return true;
  return Object.entries(value).some(([key,item]) =>
    ['id','lineId'].includes(key) || /(?:Id|ID)$/.test(key) || hasReferences(item,path?`${path}.${key}`:key));
}

export function validateAssistantFormValues(target,input,{patch=false,baseline=null,referenceChoices=null,requireKnownReferences=false,allowUnresolvedReferences=false,allowResolvedReferences=false}={}) {
  const descriptor=assistantFormDescriptor(target);
  if (!descriptor || !isPlainObject(input)) fail('Formulario no asistible.');
  const allowed=patch?descriptor.patchFields:descriptor.fields;
  for (const key of Object.keys(input)) {
    if (dangerous(key) || !allowed.includes(key)) fail(`Campo no permitido en ${target}: ${key}.`);
    if (patch && /(?:Id|ID)$/.test(key) && !allowResolvedReferences) fail(`La referencia requiere resolución autorizada: ${key}.`);
  }
  const output={};
  for (const [key,value] of Object.entries(input)) {
    if (blockedNestedKey.test(key) || privateKey.test(key)) {
      if (patch) fail(`Campo de control no permitido en ${target}: ${key}.`);
      continue;
    }
    let candidate=value;
    if(patch&&baseline&&['commission','thresholds','alertDefaults','audience'].includes(key)&&isPlainObject(value)&&isPlainObject(baseline[key]))candidate={...baseline[key],...value};
    if(patch&&baseline&&['salaryAgreements','commissionOverrides'].includes(key)&&Array.isArray(value)&&Array.isArray(baseline[key])){
      if(value.some(row=>!row?.id||!baseline[key].some(old=>old.id===row.id))||!value.length&&baseline[key].length)fail('Las vigencias se modifican desde sus filas existentes.');
      candidate=baseline[key].map(old=>({...old,...(value.find(row=>row.id===old.id)||{})}));
    }
    output[key]=checkValue(target,key,candidate,{patch,path:key,baseline});
  }
  if (patch && target === 'import-draft' && output.config) assertImportPatchIdentity(output.config,baseline);
  if (patch && hasReferences(output)) {
    if (allowUnresolvedReferences && !requireKnownReferences) {
      // Structural proposal validation only; the authenticated service must resolve every ID before apply/execute.
    } else {
      if (!baseline && !referenceChoices) fail('La propuesta necesita referencias vigentes y opciones autorizadas.');
      assertKnownReferences(output,baseline,referenceChoices);
    }
  } else if (patch && requireKnownReferences) assertKnownReferences(output,baseline,referenceChoices);
  return output;
}

export function serializeAssistantDraft(target,values) {
  const descriptor=assistantFormDescriptor(target);
  if (!descriptor || !isPlainObject(values)) return {};
  const selected={};
  for (const field of descriptor.fields) if (own(values,field)) {
    if (nonPatchable.has(field) || blockedNestedKey.test(field) || privateKey.test(field)) continue;
    let safe=safeValue(values[field],0,target);
    if(target==='order'&&field==='items'&&Array.isArray(safe))safe=canonicalOrderLines(safe);
    if (safe !== undefined) selected[field]=safe;
  }
  return selected;
}

export function serializeAssistantForm(target,values) {
  if (!Object.hasOwn(descriptors,target) || !isPlainObject(values)) return {};
  return validateAssistantFormValues(target,serializeAssistantDraft(target,values));
}

export function filterAssistantPatch(target,patch,options={}) {
  return validateAssistantFormValues(target,patch,{...options,patch:true});
}

function canonicalOrderLines(value) {
  if(!Array.isArray(value))fail('Líneas de pedido inválidas.');
  const allowed=expectedNested('order','items');
  return value.map(row=>{
    if(!isPlainObject(row))fail('Línea de pedido inválida.');
    return Object.fromEntries(allowed.filter(key=>own(row,key)).map(key=>[key,row[key]]));
  });
}

export function formatAssistantChangeValue(field,value,currency='COP') {
  const display=(key,item)=>{
    if(item==null)return 'Sin dato';
    if(item==='')return 'Vacío';
    if(typeof item==='boolean')return item?'Sí':'No';
    if(typeof item==='number'&&Number.isSafeInteger(item)){
      if(/Minor$/.test(key)||key==='price'){
        const amount=key==='price'?pesosToMinor(item):item;
        return currency?`${formatMoneyMinor(amount,{currency})} ${currency}`:`${formatMoneyMinor(amount,{currency:null})} · moneda sin verificar`;
      }
    }
    if(Array.isArray(item))return item.map(child=>display(key,child));
    if(isPlainObject(item))return Object.fromEntries(Object.entries(item).map(([name,child])=>[name,display(name,child)]));
    return item;
  };
  const normalized=display(field,value);
  return typeof normalized==='object'?JSON.stringify(normalized,null,2):String(normalized);
}

const businessSettingsSubmissionFields = ['version','rulesVersions','setupPolicyConfirmed','defaultReceiptAccountId','defaultPaymentAccountId','reportsStartOn','reportGenerationTime','reportPeriods','alertDefaults','reason'];
const submissionMetadata = formMetadataFields;
const humanSubmissionFields = {
  order: ['status','statusReason','cancellationOn','sellerId'],
  'shipment-create': ['orderId','replacesShipmentId'],
  'shipment-metadata': ['replacesShipmentId'],
  'shipment-event': ['status','correctionOf','inventoryOpeningIncluded','source'],
  'campaign-draft': ['aiDisclosure'],
  'business-action:account-save': ['type','active','closingEnabled'],
  'business-action:collection': ['allowCredit'],
  'business-action:expense': ['reviewConfirmed'],
  'business-action:return': ['inventoryOpeningIncluded'],
  'settings:person': ['active','userId'],
  'settings:platform': ['active','platformId'],
  'settings:source': ['active','platformId'],
  'settings:policy': businessSettingsSubmissionFields.filter(key=>!['version','reason'].includes(key)),
  'settings:preferences': ['rulesVersions','setupPolicyConfirmed'],
  'settings:alert': ['state'],
};

function boundedSubmissionValue(value,depth=0) {
  if (depth>10) fail('El formulario es demasiado profundo.');
  if (value==null || typeof value==='boolean') return value;
  if (typeof value==='string') {
    if(value.length>12000)fail('El campo supera el límite del formulario.');
    return value;
  }
  if (typeof value==='number') {
    if(!Number.isFinite(value))fail('El formulario contiene un número no finito.');
    return value;
  }
  if (Array.isArray(value)) {
    if(value.length>200)fail('El formulario contiene demasiados elementos.');
    return value.map(item=>boundedSubmissionValue(item,depth+1));
  }
  if(!isPlainObject(value))fail('El formulario contiene un valor no serializable.');
  const output={};
  for(const [key,item] of Object.entries(value)) {
    if(dangerous(key)||privateKey.test(key))fail('El formulario contiene un campo privado o no permitido.');
    if(item!==undefined)output[key]=boundedSubmissionValue(item,depth+1);
  }
  return output;
}

function humanFieldsForTarget(target) {
  const descriptor=assistantFormDescriptor(target);
  if(!descriptor)fail('Formulario no asistible.');
  if(target.startsWith('record:')) {
    const kind=target.slice('record:'.length);
    return schemas[kind].fields.map(field=>field.name).filter(key=>!descriptor.fields.includes(key));
  }
  if(target==='storefront-settings')return settingsFields.map(field=>field.name).filter(key=>!descriptor.patchFields.includes(key));
  return humanSubmissionFields[target]||[];
}

function validateHumanSubmissionValue(target,key,value) {
  if(value===undefined)return undefined;
  if(['allowCredit','reviewConfirmed','inventoryOpeningIncluded','active','closingEnabled','launchApproved','showNextStage','setupPolicyConfirmed'].includes(key)) {
    if(typeof value!=='boolean')fail(`${key}: se esperaba confirmación humana explícita.`);
    return value;
  }
  if(key==='aiDisclosure') {
    if(value!==null&&typeof value!=='boolean')fail('La declaración de IA debe ser una elección humana.');
    return value;
  }
  if(key==='status') {
    const options=target==='order'?['new','preparing','sent','delivered','returned','cancelled']
      :target==='shipment-event'?shipmentStates.map(item=>item.value):['draft','published','archived'];
    if(!options.includes(value))fail('Estado no permitido.');
    return value;
  }
  if(key==='state') {
    if(!['','open','acknowledged'].includes(value))fail('Estado de alerta no permitido.');
    return value;
  }
  if(key==='source') {
    if(value!=='manual')fail('El evento asistido conserva la fuente manual.');
    return value;
  }
  if(['rulesVersions','alertDefaults','reportPeriods'].includes(key))return boundedSubmissionValue(value);
  if(['reportsStartOn','cancellationOn'].includes(key)) {
    if(value==null||value==='')return value;
    return businessDate(value,key);
  }
  if(typeof value==='string') {
    const maximum=['image','logo'].includes(key)?2048:key==='statusReason'?500:200;
    if(value.length>maximum)fail(`${key}: valor demasiado largo.`);
    if(key==='slug'&&value&&!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))fail('Dirección corta no válida.');
    if(key==='placement'&&!schemas.messages.fields.find(field=>field.name==='placement').options.some(option=>option.value===value))fail('Ubicación no válida.');
    return value;
  }
  if(value==null)return null;
  return boundedSubmissionValue(value);
}

export function validateAssistantHumanAcknowledgements(target,value={}) {
  if(!isPlainObject(value))fail('Controles humanos inválidos.');
  const allowed=humanFieldsForTarget(target),output={};
  for(const [key,item] of Object.entries(value)) {
    if(!allowed.includes(key)||dangerous(key))fail(`Control humano no permitido en ${target}: ${key}.`);
    const checked=validateHumanSubmissionValue(target,key,item);
    if(checked!==undefined)output[key]=checked;
  }
  return output;
}

export function serializeAssistantHumanAcknowledgements(target,payload={}) {
  if(!isPlainObject(payload))fail('Formulario inválido.');
  const selected={};
  for(const key of humanFieldsForTarget(target))if(own(payload,key)&&payload[key]!==undefined)selected[key]=payload[key];
  return validateAssistantHumanAcknowledgements(target,selected);
}

// This validates the actual human submission, not a model patch. Original domain
// handlers remain authoritative for required fields, references and business rules.
export function validateAssistantSubmission(target,payload) {
  const descriptor=assistantFormDescriptor(target);
  if(!descriptor||!isPlainObject(payload))fail('Formulario no asistible.');
  const human=serializeAssistantHumanAcknowledgements(target,payload);
  const kind=target.startsWith('record:')?target.slice('record:'.length):null;
  const canonicalFields=kind?schemas[kind].fields.map(field=>field.name)
    :target==='storefront-settings'?settingsFields.map(field=>field.name)
    :['settings:policy','settings:preferences'].includes(target)?[...new Set([...descriptor.fields,...businessSettingsSubmissionFields])]
    :[...new Set([...descriptor.fields,...humanFieldsForTarget(target)])];
  const output={};
  for(const [key,value] of Object.entries(payload)) {
    if(value===undefined)continue;
    if(dangerous(key)||privateKey.test(key))fail('El formulario contiene un campo privado o no permitido.');
    if(submissionMetadata.has(key)) {
      if(key==='version'&&value!=null)output.version=integer(value,'Versión',0);
      continue;
    }
    if(!canonicalFields.includes(key)) {
      // RecordEditor starts with a read projection containing derived stock and
      // timestamps. Only its original schema is ever submitted to the handler.
      if(kind)continue;
      fail(`Campo de guardado no permitido en ${target}: ${key}.`);
    }
    if(own(human,key)) {output[key]=human[key];continue;}
    if(['split','precision'].includes(key))continue;
    if(key==='assignments'&&['shipment-create','shipment-metadata'].includes(target)) {
      const assignments=checkValue(target,key,value);
      output[key]=Object.entries(assignments).map(([lineId,quantity])=>({lineId,quantity}));
    } else if(target==='order'&&key==='items')output[key]=checkValue(target,key,canonicalOrderLines(value));
    else if(descriptor.fields.includes(key))output[key]=checkValue(target,key,value);
    else output[key]=boundedSubmissionValue(value);
  }
  return output;
}

export function assistantSubmissionFields(target) {
  const descriptor=assistantFormDescriptor(target);
  if(!descriptor)return [];
  if(target.startsWith('record:'))return schemas[target.slice('record:'.length)].fields.map(field=>field.name);
  if(target==='storefront-settings')return settingsFields.map(field=>field.name);
  return [...new Set([...descriptor.fields,...humanFieldsForTarget(target),...(['settings:policy','settings:preferences'].includes(target)?businessSettingsSubmissionFields:[])])].filter(key=>!submissionMetadata.has(key));
}
