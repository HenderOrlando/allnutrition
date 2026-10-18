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
