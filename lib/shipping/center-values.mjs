import { fail, integer, text } from '../validation-core.mjs';
import { moneyMinor } from '../business/money.mjs';
import { instant } from '../business/dates.mjs';

export const PACK_FIELDS = Object.freeze([
  {name:'packedWeightG', key:'weightG', label:'Peso', unit:'kg', precision:3, max:1_000_000},
  {name:'packedLengthMm', key:'lengthMm', label:'Largo', unit:'cm', precision:1, max:10_000},
  {name:'packedWidthMm', key:'widthMm', label:'Ancho', unit:'cm', precision:1, max:10_000},
  {name:'packedHeightMm', key:'heightMm', label:'Alto', unit:'cm', precision:1, max:10_000},
]);

export function parsePackedMeasure(value, field) {
  const clean = String(value ?? '').trim();
  if (!clean) return null;
  const match = /^(\d{1,7})(?:[.,](\d+))?$/.exec(clean);
  if (!match || (match[2]?.length ?? 0) > field.precision) fail(`${field.label}: usa hasta ${field.precision} decimales en ${field.unit}.`);
  const factor = 10 ** field.precision;
  const minor = Number(match[1]) * factor + Number((match[2] ?? '').padEnd(field.precision, '0'));
  if (minor < 1 || minor > field.max) fail(`${field.label}: escribe un valor mayor que cero y de hasta ${field.max/factor} ${field.unit}.`);
  return minor;
}

export const RECIPIENT_FIELDS = Object.freeze([
  ['customerName','Nombre',200], ['city','Municipio',100], ['department','Departamento',100],
  ['address','Dirección',500], ['addressNotes','Apartamento e indicaciones',1000],
  ['phone','Teléfono',30], ['email','Correo',254], ['documentType','Tipo de documento',30], ['documentNumber','Documento',80],
]);

export function shippingObject(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(`${label}: campos no válidos.`);
  return input;
}

export function recipientValues(input, { complete = false } = {}) {
  shippingObject(input, RECIPIENT_FIELDS.map(([key]) => key), 'Destinatario');
  const data = Object.fromEntries(RECIPIENT_FIELDS.map(([key,label,max]) => [key,text(input[key],label,max,complete && ['customerName','city','address','phone'].includes(key))]));
  if (data.phone && (!/^\+?[0-9 ()-]+$/.test(data.phone) || data.phone.replace(/\D/g,'').length < 7)) fail('Teléfono no válido.');
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) fail('Correo no válido.');
  if (complete && Boolean(data.documentType) !== Boolean(data.documentNumber)) fail('Completa el tipo y número de documento o deja ambos vacíos.');
  return data;
}

const oneOf = (value, allowed, label) => { if (!allowed.includes(value)) fail(`${label}: opción no válida.`); return value; };
const nullableText = (value, label, max = 100) => value == null || value === '' ? null : text(value,label,max,true);
const nullableNumber = (value, label, min, max) => value == null ? null : integer(value,label,min,max);

export function parcelValues(input) {
  shippingObject(input, PACK_FIELDS.map(field => field.key), 'Bulto');
  return Object.fromEntries(PACK_FIELDS.map(({key,label,max}) => [key,nullableNumber(input[key],label,1,max)]));
}

export function locationValues(input = {}) {
  shippingObject(input,['dane','city','state'],'Localidad');
  const dane = nullableText(input.dane,'DANE',16);
  if (dane && !/^\d+$/.test(dane)) fail('DANE: usa solo números.');
  return {dane,city:text(input.city,'Municipio',100),state:text(input.state,'Departamento',100)};
}

export function routeValues(input = {}) {
  shippingObject(input,['origin','destination','deliveryType'],'Ruta');
  return {origin:locationValues(input.origin),destination:locationValues(input.destination),deliveryType:oneOf(input.deliveryType ?? 'address',['address','office'],'Tipo de entrega')};
}

export function shippingPaymentValues(input = {}) {
  shippingObject(input,['declaredMinor','collectionMinor','payer','includeShipping','collectionConfirmed'],'Pago');
  for (const key of ['includeShipping','collectionConfirmed']) if (input[key] !== undefined && typeof input[key] !== 'boolean') fail('Pago: opción no válida.');
  return {
    declaredMinor:input.declaredMinor == null ? null : moneyMinor(input.declaredMinor,'Valor declarado'),
    collectionMinor:input.collectionMinor == null ? null : moneyMinor(input.collectionMinor,'Recaudo'),
    payer:oneOf(input.payer ?? 'sender',['sender','recipient'],'Quién paga'),
    includeShipping:input.includeShipping ?? false, collectionConfirmed:input.collectionConfirmed ?? false,
  };
}

function hekaOptions(input) {
  shippingObject(input,['warehouse','version','channel','seller'],'Opciones de Heka');
  return {
    warehouse:nullableText(input.warehouse,'Bodega',200),
    version:oneOf(input.version ?? null,[null,'1','2'],'Versión de tarifa'),
    channel:oneOf(input.channel ?? null,[null,'hekaentrega','loggy24'],'Canal'),
    seller:nullableText(input.seller,'Vendedor',200),
  };
}

export function preparationValues(input) {
  shippingObject(input,['route','parcel','lines','recipient','payment','options','offer'],'Preparación');
  const lines = input.lines ?? [];
  if (!Array.isArray(lines) || lines.length > 50) fail('Usa como máximo 50 líneas en la preparación.');
  const options = shippingObject(input.options ?? {},['heka'],'Opciones de plataforma');
  return {
    route:routeValues(input.route), parcel:parcelValues(input.parcel ?? {}),
    lines:lines.map(line => {
      shippingObject(line,['kind','itemId','lineId','quantity','title','unitPriceMinor'],'Línea');
      return {
        kind:oneOf(line.kind,['products','combos'],'Tipo de referencia'), itemId:text(line.itemId,'Referencia',100,true),
        lineId:nullableText(line.lineId,'Línea del pedido'), quantity:integer(line.quantity,'Cantidad',1,999),
        title:text(line.title,'Descripción',200), unitPriceMinor:line.unitPriceMinor == null ? null : moneyMinor(line.unitPriceMinor,'Valor unitario'),
      };
    }),
    recipient:recipientValues(input.recipient ?? {}), payment:shippingPaymentValues(input.payment),
    options:Object.hasOwn(options,'heka') ? {heka:hekaOptions(options.heka)} : {},
    offer:input.offer == null ? null : savedOffer(input.offer),
  };
}

function savedOffer(input) {
  shippingObject(input,['providerId','providerLabel','environment','version','carrier','service','total','amount','currency','days','quotedAt'],'Oferta');
  for (const key of ['total','amount']) if (input[key] != null && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > Number.MAX_SAFE_INTEGER)) fail('Importe estimado no válido.');
  const currency = nullableText(input.currency,'Moneda',3);
  if (currency && !/^[A-Z]{3}$/.test(currency)) fail('Moneda no válida.');
  return {
    providerId:text(input.providerId,'Plataforma',100,true), providerLabel:text(input.providerLabel,'Nombre de plataforma',100,true),
    environment:oneOf(input.environment,['production','test'],'Entorno'), version:integer(input.version,'Versión de conexión',1,2147483647),
    carrier:nullableText(input.carrier,'Transportadora'), service:nullableText(input.service,'Servicio'),
    total:input.total ?? null, amount:input.amount ?? null, currency, days:nullableNumber(input.days,'Plazo',0,365), quotedAt:instant(input.quotedAt,'Fecha de cotización'),
  };
}
