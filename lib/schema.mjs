/** Definición compartida de formularios. Sin secretos ni accesos a la base de datos. */
export const contentStates = [{value:'draft', label:'Borrador'}, {value:'published',label:'Publicado'}, {value:'archived',label:'Archivado'}];
export const orderStates = [
 {value:'new',label:'Nuevo'}, {value:'preparing',label:'Preparando'}, {value:'sent',label:'Enviado'},
 {value:'delivered',label:'Entregado'}, {value:'returned',label:'Devuelto'}, {value:'cancelled',label:'Cancelado'}
];
export const orderTransitions = {new:['preparing','cancelled'],preparing:['sent','cancelled'],sent:['delivered','returned'],delivered:['returned'],returned:[],cancelled:[]};
export const paymentStates = [{value:'pending',label:'Pendiente'}, {value:'partial',label:'Abono parcial'}, {value:'paid',label:'Pagado'}, {value:'refunded',label:'Reembolsado'}];
export const paymentMethods = ['Nequi','Daviplata','Transferencia','Efectivo contraentrega'];
const field = (name,label,type='text',extra={}) => ({name,label,type,...extra});
const common = [field('title','Nombre','text',{required:true,max:160}),field('slug','Dirección corta (sin espacios)','text',{required:true,max:180}),field('status','Publicación','select',{options:contentStates}),field('sort','Orden de aparición','number',{min:0})];
export const schemas = {
 products:{ label:'Productos', singular:'producto', help:'Cada presentación con precio o disponibilidad propia debe ser una referencia independiente.', fields:[
 ...common,field('image','Enlace de la fotografía','image'),field('description','Descripción corta','textarea',{max:3000}),
 field('presentation','Presentación / contenido'),field('flavor','Sabor'),field('price','Precio en pesos colombianos','money',{required:true,min:0}),
 field('availability','Disponibilidad manual','select',{options:[{value:'consult',label:'Consultar disponibilidad'},{value:'available',label:'Disponible'},{value:'soldout',label:'Agotado'}]}),
 field('featured','Destacar en el inicio','checkbox'),field('catalogIds','Catálogos','multi',{source:'catalogs'}),
 field('productInfo','Información de etiqueta / advertencias aprobadas','textarea',{max:4000})]},
 catalogs:{label:'Catálogos',singular:'catálogo',help:'Agrupa productos en colecciones. No es una sincronización del catálogo de WhatsApp.',fields:[...common,field('description','Descripción','textarea'),field('image','Imagen de portada','image')]},
 combos:{label:'Combos',singular:'combo',help:'Selecciona referencias y cantidades. El precio se fija manualmente; no se calcula inventario.',fields:[...common,
 field('description','Descripción','textarea'),field('image','Imagen del combo','image'),field('price','Precio del combo (COP)','money',{required:true}),
 field('items','Productos incluidos','comboItems',{source:'products'}),field('catalogIds','Catálogos','multi',{source:'catalogs'}),
 field('conditions','Condiciones de la oferta','textarea')]},
 faqs:{label:'Preguntas frecuentes',singular:'pregunta',help:'Publica únicamente respuestas confirmadas por el negocio.',fields:[...common.map(f=>f.name==='title'?{...f,label:'Pregunta'}:f),field('answer','Respuesta','textarea',{required:true,max:5000})]},
 messages:{label:'Mensajes comerciales',singular:'mensaje',help:'Textos de la web. No envían respuestas automáticas ni campañas por WhatsApp.',fields:[...common,
 field('placement','Ubicación','select',{options:[{value:'hero',label:'Mensaje principal'},{value:'announcement',label:'Franja superior'},{value:'feature',label:'Bloque de información'}]}),
 field('body','Texto de apoyo','textarea',{max:3000}),field('buttonText','Texto del botón (abre WhatsApp)')]},
 shipping:{label:'Datos de envío',singular:'condición de envío',help:'Información pública de cobertura y condiciones. No cotiza ni genera guías automáticamente.',fields:[...common,
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
 const data={}; for(const f of schemas[kind].fields) data[f.name] = f.type==='checkbox'?false:f.type==='multi'||f.type==='comboItems'?[]:f.type==='select'?f.options[0].value:f.type==='money'||f.type==='number'?0:'';
 if(kind==='products') data.availability='consult'; return data;
}
export function money(value) { return new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(value||0); }
export function slugify(value) { return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,180); }
export function whatsAppLink(settings,product='los productos de All Nutrition') {
 return `https://wa.me/${settings.whatsapp}?text=${encodeURIComponent(settings.whatsappTemplate.replaceAll('{producto}',product))}`;
}
