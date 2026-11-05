/** Definición compartida de formularios. Sin secretos ni accesos a la base de datos. */
export const contentStates = [{value:'draft', label:'Borrador'}, {value:'published',label:'Publicado'}, {value:'archived',label:'Archivado'}];
export const orderStates = [
 {value:'new',label:'Nuevo'}, {value:'preparing',label:'Preparando'}, {value:'sent',label:'Enviado'},
 {value:'delivered',label:'Entregado'}, {value:'returned',label:'Devuelto'}, {value:'cancelled',label:'Cancelado'}
];
export const shipmentStates = [
 {value:'label_created',label:'Guía creada'}, {value:'collected',label:'Recogido'},
 {value:'in_transit',label:'En tránsito'}, {value:'out_for_delivery',label:'En reparto'},
 {value:'delivered',label:'Entregado'}, {value:'incident',label:'Con novedad'},
 {value:'return_in_transit',label:'Devolución en tránsito'}, {value:'returned',label:'Devuelto'},
 {value:'cancelled',label:'Cancelado'}, {value:'unknown',label:'Estado sin identificar'}
];
export const orderTransitions = {new:['preparing','cancelled'],preparing:['sent','cancelled'],sent:['delivered','returned'],delivered:['returned'],returned:[],cancelled:[]};
export const paymentStates = [{value:'not_required',label:'Sin cobro'}, {value:'pending',label:'Pendiente'}, {value:'partial',label:'Abono parcial'}, {value:'paid',label:'Pagado'}, {value:'partially_refunded',label:'Reembolso parcial'}, {value:'refunded',label:'Reembolsado'}, {value:'legacy_review',label:'Pago histórico por conciliar'}];
export const paymentMethods = ['Nequi','Daviplata','Transferencia','Efectivo contraentrega'];

const importField = (value, label, group, type, scope, effect, description, extra = {}) => Object.freeze({value,label,group,type,scope,effect,description,...extra});
// Identifier types intentionally retain the normalization of existing import profiles.
export const importFields = Object.freeze([
 importField('externalOrderId','ID externo del pedido','Identidad','identifier','order','information','Identidad del pedido en esta fuente.'),
 importField('internalOrderNumber','Número AN del pedido','Identidad','identifier','order','information','Vincula un pedido existente por su número AN.'),
 importField('externalShipmentId','ID externo del envío','Identidad','identifier','shipment','information','Identidad de la guía en esta fuente.'),
 importField('externalEventId','ID externo del evento','Identidad','identifier','event','logistics','Identidad estable del evento de seguimiento.'),
 importField('rawShipmentStatus','Estado del envío en la plataforma','Estados','text','shipment','information','Estado administrativo del origen. No confirma entrega, cobro ni cancelación.',{max:500}),
 importField('rawStatus','Estado de la entrega / seguimiento','Estados','identifier','event','logistics','Observación logística; requiere equivalencia explícita para interpretar el estado.',{max:500}),
 importField('carrier','Transportadora','Envío y fechas','identifier','shipment','logistics','Transportadora responsable de la guía.',{max:150}),
 importField('tracking','Guía','Envío y fechas','identifier','shipment','logistics','Número de guía; conserva ceros iniciales.',{max:200}),
 importField('shippingType','Tipo de envío','Envío y fechas','text','shipment','information','Servicio o modalidad declarada por el origen. No equivale a modalidad del pedido ni confirma un cobro.',{max:200}),
 importField('shipmentReference','Referencia del envío','Envío y fechas','text','shipment','information','Referencia informativa, no identidad ni referencia de recaudo o liquidación.',{max:500}),
 importField('cancellationReason','Motivo de anulación de la guía','Envío y fechas','text','shipment','information','Motivo informado por el origen; no cancela el envío ni el pedido.',{max:2000}),
 importField('shipmentNotes','Notas del envío en el origen','Envío y fechas','text','shipment','information','Notas de origen separadas de las notas manuales.',{max:4000}),
 importField('eventAt','Fecha del evento','Envío y fechas','date','event','logistics','Fecha real del evento de seguimiento.'),
 importField('reportAsOf','Fecha de corte del reporte','Envío y fechas','date','shipment','information','Corte explícito de la fuente, nunca fecha de carga.'),
 importField('placedOn','Fecha del pedido','Envío y fechas','date','order','commercial','Fecha comercial del pedido.'),
 importField('labelCreatedAt','Fecha de creación de guía','Envío y fechas','date','event','logistics','Fecha de creación de la guía.'),
 importField('collectedAt','Fecha de recogida','Envío y fechas','date','event','logistics','Recogida real; no es un recaudo de dinero.'),
 importField('estimatedDeliveryOn','Entrega estimada','Envío y fechas','date','shipment','logistics','Fecha estimada de entrega; no confirma entrega real.'),
 importField('deliveredAt','Fecha de entrega','Envío y fechas','date','event','logistics','Fecha real de entrega.'),
 importField('returnAt','Fecha de retorno','Envío y fechas','date','event','logistics','Fecha real del retorno.'),
 importField('eventDetail','Detalle del evento','Envío y fechas','identifier','event','logistics','Detalle de la observación logística.'),
 importField('customerName','Nombre del destinatario','Destinatario y vendedor','identifier','order','commercial','Destinatario observado; un pedido existente requiere autorización comercial.',{max:150}),
 importField('phone','Teléfono','Destinatario y vendedor','identifier','order','commercial','Teléfono observado del destinatario.',{max:30}),
 importField('department','Departamento','Destinatario y vendedor','identifier','order','commercial','Departamento del destinatario.',{max:100}),
 importField('city','Ciudad','Destinatario y vendedor','identifier','order','commercial','Ciudad del destinatario.',{max:100}),
 importField('address','Dirección','Destinatario y vendedor','identifier','order','commercial','Dirección del destinatario.',{max:500}),
 importField('addressNotes','Barrio y referencias de dirección','Destinatario y vendedor','text','order','commercial','Barrio y referencias para ubicar la dirección.',{max:500}),
 importField('email','Correo del destinatario','Destinatario y vendedor','text','order','commercial','Correo del destinatario; se valida al preparar el pedido.',{max:254}),
 importField('documentType','Tipo de documento del destinatario','Destinatario y vendedor','text','order','commercial','Se requiere junto con el número de documento.',{max:30}),
 importField('documentNumber','Número de documento del destinatario','Destinatario y vendedor','identifier','order','commercial','Conserva ceros iniciales; requiere tipo de documento.',{max:80}),
 importField('orderNotes','Notas del pedido','Destinatario y vendedor','text','order','commercial','Notas del pedido; no son notas del envío en el origen.',{max:3000}),
 importField('deliveryMethod','Modalidad de entrega del pedido','Destinatario y vendedor','enum','order','commercial','Usa carrier, local o pickup. No traduce automáticamente PAGO CONTRAENTREGA.',{options:[{value:'carrier',label:'Transportadora'},{value:'local',label:'Entrega local'},{value:'pickup',label:'Recogida'}]}),
 importField('sellerExternalKey','ID externo del vendedor','Destinatario y vendedor','identifier','order','commercial','Requiere vincular un vendedor real.'),
 importField('externalLineId','ID externo de línea','Productos','identifier','line','commercial','Identidad estable de la línea del pedido.'),
 importField('productExternalKey','ID o referencia del producto','Productos','identifier','line','commercial','Requiere vincular un producto real.'),
 importField('quantity','Cantidad','Productos','integer','line','commercial','Unidades enteras entre 1 y 999.'),
 importField('unitPrice','Precio unitario','Productos','money','line','commercial','Precio por unidad en COP.'),
 importField('lineDiscount','Descuento total de línea','Productos','money','line','commercial','Descuento total de la línea en COP, una sola vez.'),
 importField('orderUnitCost','Costo histórico unitario','Productos','money','line','cost','Costo unitario de esta venta en COP; no modifica el catálogo.'),
 importField('giftProductExternalKey','Referencia del obsequio','Productos','identifier','line','commercial','Agrega una línea sin cobro; requiere vincular un obsequio real con componentes confirmados.'),
 importField('giftQuantity','Cantidad de obsequios','Productos','integer','line','commercial','Unidades de obsequio entre 1 y 999; no se deducen de la cantidad vendida.'),
 importField('marketingCampaign','Campaña de origen','Destinatario y vendedor','text','order','commercial','Campaña que originó el pedido, no un gasto.',{max:200}),
 importField('expenseExternalId','ID del gasto','Gastos','identifier','expense','information','Identidad estable del gasto.',{max:200}),
 importField('expenseDate','Fecha económica del gasto','Gastos','date','expense','cost','Fecha explícita del gasto.'),
 importField('expenseCategory','Categoría del gasto','Gastos','enum','expense','cost','Publicidad, operación u otros.',{options:[{value:'advertising',label:'Publicidad'},{value:'operating',label:'Operación'},{value:'other',label:'Otros'}]}),
 importField('expenseConcept','Concepto del gasto','Gastos','text','expense','information','Concepto obligatorio del gasto.',{max:500}),
 importField('expenseAmount','Importe del gasto','Gastos','money','expense','cost','COP no negativo; blanco no equivale a cero.'),
 importField('expenseSupplier','Proveedor','Gastos','text','expense','information','Proveedor informado.',{max:200}),
 importField('expenseReference','Referencia del gasto','Gastos','text','expense','information','Referencia informativa.',{max:300}),
 importField('expenseNotes','Notas del gasto','Gastos','text','expense','information','Notas informativas.',{max:4000}),
 importField('expenseCampaign','Campaña publicitaria','Gastos','text','expense','information','Nombre o identificador de campaña.',{max:200}),
 importField('expenseQuantity','Cantidad publicitaria','Gastos','integer','expense_line','cost','Cantidad entera entre cero y un millón.'),
 importField('expenseUnitCost','Costo unitario publicitario','Gastos','money','expense_line','cost','Costo unitario en COP.'),
 importField('expenseControlTotal','Total de comprobación','Gastos','money','expense','validation','Comprobación, no gasto.'),
 importField('orderAdditionalField','Otro dato del pedido','Información adicional','additional','order','information','Información con nombre; no modifica dinero.',{max:4000}),
 importField('expenseAdditionalField','Otro dato del gasto','Información adicional','additional','expense','information','Información con nombre; no modifica dinero.',{max:4000}),
 importField('allocationQuantity','Cantidad asignada','Relaciones','integer','allocation','information','Unidades asignadas, entre 1 y 999.'),
 importField('componentProductExternalKey','Referencia del componente','Relaciones','identifier','component','information','Producto real componente.'),
 importField('componentUnitCost','Costo unitario del componente','Relaciones','money','component','cost','Costo histórico del componente.'),
 importField('observationScope','Ámbito','Observaciones','enum','observation','information','Entidad a la que acompaña el dato.',{options:['order','shipment','expense'].map(value => ({value,label:value}))}),
 importField('observationEntityId','ID entidad','Observaciones','identifier','observation','information','Identidad externa de la entidad.',{max:200}),
 importField('observationKey','Clave','Observaciones','text','observation','information','Clave informativa del catálogo o additional:nombre.',{max:200}),
 importField('observationLabel','Etiqueta','Observaciones','text','observation','information','Etiqueta informativa.',{max:500}),
 importField('observationValueType','Tipo de valor','Observaciones','enum','observation','information','Tipo explícito; dinero en centavos.',{options:['text','integer','money_minor','date','boolean'].map(value => ({value,label:value}))}),
 importField('observationValue','Valor','Observaciones','text','observation','information','Dato tipado; nunca genera cargos.',{max:4000}),
 importField('observationOriginSheet','Hoja origen','Observaciones','text','observation','information','Origen declarado, no prueba de otra fuente.',{max:100}),
 importField('observationOriginRow','Fila origen','Observaciones','integer','observation','information','Fila declarada, entre 1 y 10001.',{min:1,max:10001}),
 importField('observationOriginColumn','Columna origen','Observaciones','integer','observation','information','Columna Excel declarada, entre 1 y 200.',{min:1,max:200}),
 importField('observationOriginHeader','Encabezado origen','Observaciones','text','observation','information','Encabezado declarado.',{max:500}),
 importField('shippingCharge','Flete cobrado al cliente','Importes y cargos','money','order','commercial','Flete del acuerdo comercial; no acredita dinero recibido.'),
 importField('shippingOutCost','Costo de flete de ida','Importes y cargos','money','shipment','cost','Cargo real de ida en COP, separado del precio cobrado.'),
 importField('shippingOutCostDate','Fecha del costo de ida','Importes y cargos','date','shipment','cost','Fecha explícita del cargo de ida.'),
 importField('shippingReturnCost','Costo de retorno','Importes y cargos','money','shipment','cost','Cargo real de retorno en COP.'),
 importField('shippingReturnCostDate','Fecha del costo de retorno','Importes y cargos','date','shipment','cost','Fecha explícita del cargo de retorno.'),
 importField('platformFee','Cargo de plataforma','Importes y cargos','money','shipment','cost','Cargo de plataforma en COP.'),
 importField('platformFeeDate','Fecha del cargo','Importes y cargos','date','shipment','cost','Fecha explícita del cargo de plataforma.'),
 importField('insuredValue','Valor asegurado / declarado','Seguro','money','shipment','information','Valor declarado en COP. No es costo, precio ni recaudo.'),
 importField('insuranceCost','Costo del seguro','Seguro','money','shipment','cost','Cargo de seguro separado del flete de ida. Si ya está incluido en el costo total de envío, no lo sumes otra vez: conserva el desglose como información adicional'),
 importField('insuranceCostDate','Fecha del costo del seguro','Seguro','date','shipment','cost','Fecha del cargo; desconocida si no se informa.'),
 importField('expectedCollection','Valor a recaudar','Valor a recaudar','money','shipment','information','Importe solicitado al transportador en COP; no registra un cobro.'),
 importField('collectedAmount','Recaudo acumulado o importe de transacción','Recaudo recibido','money','collection','collection','Dinero recibido según la fuente; no se infiere de un valor declarado.'),
 importField('collectionDate','Fecha del recaudo','Recaudo recibido','date','collection','collection','Fecha real del recaudo recibido.'),
 importField('collectionExternalId','ID externo del recaudo','Recaudo recibido','identifier','collection','collection','Identidad de una transacción de recaudo.'),
 importField('collectionReference','Referencia del recaudo','Recaudo recibido','identifier','collection','collection','Referencia del recaudo recibido.'),
 importField('settlementExternalId','ID externo de liquidación','Liquidaciones','identifier','settlement','settlement','Identidad de la declaración de liquidación.'),
 importField('settlementDate','Fecha de liquidación','Liquidaciones','date','settlement','settlement','Fecha de la declaración; no confirma un pago.'),
 importField('settlementGross','Bruto de liquidación','Liquidaciones','money','settlement','settlement','Bruto declarado en COP.'),
 importField('settlementNet','Neto de liquidación','Liquidaciones','money','settlement','settlement','Neto declarado en COP; confirmar recepción es una acción separada.'),
 importField('settlementReference','Referencia de liquidación','Liquidaciones','identifier','settlement','settlement','Referencia de la declaración de liquidación.'),
 importField('additionalField','Conservar como campo adicional','Información adicional','additional','shipment','information','Nombre obligatorio. Conserva texto del origen sin modificar estado, costos, inventario ni dinero.',{max:4000})
]);
const importFieldDefinitions = new Map(importFields.map(definition => [definition.value,definition]));
export function normalizeImportFieldName(value) {
 return String(value ?? '').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase('es');
}
export function isImportFieldAllowed(destination,purpose) {
 if (destination === 'ignore') return true;
 const definition = importFieldDefinitions.get(destination);
 if (!definition) return false;
 if (['giftProductExternalKey','giftQuantity'].includes(destination)) return purpose === 'orders';
 if (purpose === 'expenses') return ['expense','expense_line'].includes(definition.scope) || destination === 'reportAsOf';
 if (purpose === 'allocations') return ['externalOrderId','externalShipmentId','externalLineId','allocationQuantity'].includes(destination);
 if (purpose === 'component_costs') return ['externalOrderId','externalLineId','componentProductExternalKey','componentUnitCost'].includes(destination);
 if (purpose === 'observations') return definition.scope === 'observation' || destination === 'reportAsOf';
 return ['orders','tracking','settlements'].includes(purpose) && !['expense','expense_line','allocation','component','observation'].includes(definition.scope);
}
export function getImportColumnIssues(columns = [], layout = 'item_rows', purpose = null) {
 const issues = [], destinations = new Map(), names = new Map(), positions = new Map();
 const duplicate = (map, key, index, code, message) => {
  const indexes = map.get(key) || []; indexes.push(index); map.set(key,indexes);
  if (indexes.length === 2) issues.push({code,indexes,message});
 };
 for (const column of columns) {
  const index = column.index, destination = column.destination, group = column.group ?? 0;
  duplicate(positions,index,index,'IMPORT_COLUMN_DUPLICATE',`La columna ${index+1} tiene más de una asignación. Cambia el destino o ignórala.`);
  if (!destination || destination === 'ignore') continue;
  const definition = importFieldDefinitions.get(destination);
  if (!definition) { issues.push({code:'IMPORT_COLUMN_DESTINATION',indexes:[index],message:`Columna ${index+1}: destino no permitido. Cambia el destino o ignora la columna.`}); continue; }
  if (purpose && !isImportFieldAllowed(destination,purpose)) issues.push({code:'IMPORT_COLUMN_DESTINATION',indexes:[index],message:`Columna ${index+1}: destino incompatible con el propósito de la hoja.`});
  const grouped = definition.scope === 'line' && layout === 'order_rows' || definition.scope === 'expense_line' && layout === 'expense_columns';
  if (!Number.isSafeInteger(group) || group < 0 || group > 49 || group && !grouped) issues.push({code:'IMPORT_COLUMN_DESTINATION',indexes:[index],message:`Columna ${index+1}: grupo incompatible con el destino o fuera de 1 a 50.`});
  if (definition.type === 'additional') {
   const label = typeof column.fieldName === 'string' ? column.fieldName.trim() : '';
   const key = normalizeImportFieldName(label);
   if (!key || label.length > 100) issues.push({code:'IMPORT_ADDITIONAL_NAME',indexes:[index],message:`Columna ${index+1}: escribe un nombre adicional de 1 a 100 caracteres o ignora la columna.`});
   else duplicate(names,`${definition.scope}:${key}`,index,'IMPORT_ADDITIONAL_DUPLICATE',`El nombre adicional «${label}» se repite en el mismo ámbito. Cambia el nombre o ignora una de las columnas.`);
  } else duplicate(destinations,`${grouped ? group : 0}:${destination}`,index,'IMPORT_COLUMN_DUPLICATE',`El destino «${definition.label}» se repite. Cambia el destino, el grupo o ignora una de las columnas.`);
 }
 return issues;
}
const field = (name,label,type='text',extra={}) => ({name,label,type,...extra});
const common = [field('title','Nombre','text',{required:true,max:160}),field('slug','Dirección corta (sin espacios)','text',{required:true,max:180}),field('status','Publicación','select',{options:contentStates}),field('sort','Orden de aparición','number',{min:0})];
export const schemas = {
 products:{ label:'Productos', singular:'producto', help:'Cada presentación con precio o existencias propias debe ser una referencia independiente.', fields:[
 ...common,field('image','Fotografía del producto','image',{localUpload:true}),field('description','Descripción corta','textarea',{max:3000}),
 field('presentation','Presentación / contenido'),field('flavor','Sabor'),field('price','Precio en pesos colombianos','money',{required:true,min:0}),
 field('stockQuantity','Existencias físicas (unidades)','optionalNumber',{min:0,description:'Cuenta todas las unidades físicas, incluidas las reservadas. Vacío = sin contar; 0 = ninguna unidad. Los pedidos reservan al guardarse y descuentan al despachar.'}),
 field('featured','Destacar en el inicio','checkbox'),field('catalogIds','Catálogos','multi',{source:'catalogs'}),
 field('productType','Tipo de producto','select',{options:[{value:'product',label:'Producto'},{value:'gift',label:'Obsequio'}]}),
 field('sku','SKU interno'),field('unitCostMinor','Costo unitario','moneyOptionalMinor'),field('costEffectiveOn','Vigente desde','date'),
 field('orderable','Disponible para pedidos','checkbox'),field('items','Componentes del obsequio','comboItems',{source:'products'}),
 field('productInfo','Información de etiqueta / advertencias aprobadas','textarea',{max:4000})]},
 catalogs:{label:'Catálogos',singular:'catálogo',help:'Agrupa productos en colecciones. No es una sincronización del catálogo de WhatsApp.',fields:[...common,field('description','Descripción','textarea'),field('image','Imagen de portada','image')]},
 combos:{label:'Combos',singular:'combo',help:'Selecciona referencias y cantidades. El precio se fija manualmente; las existencias dependen de sus componentes.',fields:[...common,
 field('description','Descripción','textarea'),field('image','Imagen del combo','image'),field('price','Precio del combo (COP)','money',{required:true}),
 field('orderable','Disponible para pedidos','checkbox'),
 field('items','Productos incluidos','comboItems',{source:'products'}),field('catalogIds','Catálogos','multi',{source:'catalogs'}),
 field('conditions','Condiciones de la oferta','textarea')]},
 faqs:{label:'Preguntas frecuentes',singular:'pregunta',help:'Publica únicamente respuestas confirmadas por el negocio.',fields:[...common.map(f=>f.name==='title'?{...f,label:'Pregunta'}:f),field('answer','Respuesta','textarea',{required:true,max:5000})]},
 messages:{label:'Mensajes comerciales',singular:'mensaje',help:'Textos de la web. No envían respuestas automáticas ni campañas por WhatsApp.',fields:[...common,
 field('placement','Ubicación','select',{options:[{value:'hero',label:'Mensaje principal'},{value:'announcement',label:'Franja superior'},{value:'feature',label:'Bloque de información'}]}),
 field('body','Texto de apoyo','textarea',{max:3000}),field('buttonText','Texto del botón (abre WhatsApp)')]},
 shipping:{label:'Condiciones de envío',singular:'condición de envío',help:'Información pública de cobertura y condiciones. No cotiza ni genera guías automáticamente.',fields:[...common,
 field('zone','Zona / cobertura'),field('costText','Cómo se determina el costo','textarea'),field('estimatedTime','Tiempo estimado confirmado'),
 field('cashOnDelivery','Condiciones de contraentrega','textarea'),field('details','Otros detalles','textarea')]}
};
export const settingsFields = [
 field('brandName','Nombre de la marca','text',{required:true}),field('tagline','Eslogan'),field('logo','Enlace del logo','image'),
 field('whatsapp','WhatsApp con código de país, solo números','text',{required:true}),
 field('whatsappTemplate','Mensaje prellenado de consulta','textarea'),
 field('facebook','Enlace de Facebook','url'),field('instagram','Enlace de Instagram','url'),
 field('email','Correo público','email'),field('hours','Horario de atención'),
 field('paymentInfo','Métodos de pago que se mostrarán','textarea'),
 field('launchApproved','Publicar la vitrina (contenido revisado y aprobado)','checkbox'),
 field('showNextStage','Mostrar orientación sobre la siguiente etapa en el panel','checkbox')
];
export const defaults = {
 brandName:'ALL NUTRITION COLOMBIA',tagline:'Suplementos al alcance de todos',logo:'/brand/logo.jpg',
 whatsapp:'573043440035',whatsappTemplate:'Hola, quiero información sobre {producto}. ¿Me confirman disponibilidad y costo de envío?',
 facebook:'',instagram:'',email:'',hours:'',paymentInfo:'Pagos anticipados: Nequi, Daviplata y transferencia. Contraentrega: efectivo, sujeto a cobertura.',
 launchApproved:false,showNextStage:true
};
export function emptyRecord(kind) {
 const data={}; for(const f of schemas[kind].fields) data[f.name] = f.type==='checkbox'?false:f.type==='multi'||f.type==='comboItems'?[]:f.type==='select'?f.options[0].value:f.type==='moneyOptionalMinor'||f.type==='optionalNumber'||f.type==='date'?null:f.type==='money'||f.type==='number'?0:'';
 return data;
}
export function money(value) { return new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(value||0); }
export function slugify(value) { return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,180); }
export function whatsAppLink(settings,product='los productos de All Nutrition') {
 return `https://wa.me/${settings.whatsapp}?text=${encodeURIComponent(settings.whatsappTemplate.replaceAll('{producto}',product))}`;
}
