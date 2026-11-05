import { importFields, normalizeImportFieldName, isImportFieldAllowed } from '../schema.mjs';
import { IMPORT_TABLES, importTableConfig } from './import-templates.mjs';
import { hash } from './commands.mjs';

const normalize=value=>normalizeImportFieldName(String(value ?? ''));
const monthlyFields=Object.freeze({estado:'rawStatus',fecha:'placedOn','nombre y apellido':'customerName',ciudad:'city',producto:'productExternalKey',cantidad:'quantity',costo:'orderUnitCost','precio venta und':'unitPrice',flete:'shippingOutCost',transportadora:'carrier',pauta:'marketingCampaign',obsequio:'giftProductExternalKey','cantidad obsequio':'giftQuantity'});
const additionalHeaders=new Set(['puntos','agencia','comision - d','registro']);
const statusSuggestions=Object.freeze({ENTREGADO:'delivered',DEVUELTO:'returned',DEVOLUCION:'returned',REPARTO:'out_for_delivery',OFICINA:'incident'});
const signature=config=>hash({...Object.fromEntries(Object.entries(config).filter(([key])=>!['sheetName','reportAsOf'].includes(key))),columns:config.columns.map(column=>({...column,header:normalize(column.header)}))});
const samples=column=>(column?.samples || []).filter(sample=>sample.value!=null && sample.value!=='' && !sample.formula);
function compatible(column,destination){
  const values=samples(column);if(!values.length)return true;
  if(destination==='phone')return values.every(sample=>/^\+?[0-9 ()-]{7,30}$/.test(String(sample.value)));
  const type=importFields.find(field=>field.value===destination)?.type;
  if(['money','integer'].includes(type))return values.every(sample=>typeof sample.value==='number' || /^\s*[\d., $+-]+\s*$/.test(String(sample.value)));
  if(type==='date')return values.every(sample=>typeof sample.value==='number' || /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(String(sample.value)) || /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(String(sample.value)));
  return values.every(sample=>['string','number','boolean'].includes(typeof sample.value));
}
function candidateColumns(candidate){return candidate.columns || (candidate.headers || []).map((header,columnIndex)=>({columnIndex,header,samples:[]}));}
function baseConfig(name,candidate){return {...importTableConfig('VENTAS'),sheetName:name,headerRow:candidate?.rowNumber || 1,columns:[],enabled:false,dateFormat:'DMY',decimalSeparator:',',groupSeparator:'.'};}
export function suggestSheetImport(sheet,{profiles=[]}={}){
  const candidate=sheet.headerCandidates?.[0],columns=candidateColumns(candidate || {}),headers=columns.map(column=>normalize(column.header));
  const counts=new Map(headers.map(header=>[header,headers.filter(value=>value===header).length]));
  let config=baseConfig(sheet.name,candidate),reasons=[],statusMapSuggestions={};
  if(sheet.empty===true)return {sheetName:sheet.name,config,requiresConfirmation:true,reasons:['Hoja vacía comprobada; no genera operaciones.'],variantKey:'empty'};
  if(!candidate)return {sheetName:sheet.name,config,requiresConfirmation:true,reasons:['Elige manualmente la fila de encabezados; no se comprobó que la hoja esté vacía.'],variantKey:'manual'};
  const definitions=Object.values(IMPORT_TABLES);
  const matches=definitions.filter(table=>table.columns.every(field=>headers.filter(header=>header===normalize(field.header)).length===1)).sort((a,b)=>b.columns.length-a.columns.length);
  const exact=matches.filter(table=>table.columns.length===matches[0]?.columns.length);
  if(exact.length===1){
    const table=exact[0];config={...importTableConfig(table.name),sheetName:sheet.name,headerRow:candidate.rowNumber,enabled:false,columns:columns.map(column=>{
      const named=table.columns.find(field=>normalize(field.header)===normalize(column.header)),catalog=importFields.filter(field=>normalize(field.label)===normalize(column.header) && isImportFieldAllowed(field.value,table.purpose));
      const field=named || (catalog.length===1?{destination:catalog[0].value}:null);
      return {index:column.columnIndex,header:column.header,destination:field && compatible(column,field.destination)?field.destination:'',group:0};
    })};
    reasons.push('Encabezados exactos de la plantilla; confirma el propósito y las asignaciones.');
  }else if(['estado','fecha','nombre y apellido','producto','cantidad','precio venta und'].every(header=>counts.get(header)===1)){
    config={...config,purpose:'orders',layout:'order_rows'};
    config.columns=columns.map(column=>{
      const header=normalize(column.header);let destination=counts.get(header)===1?monthlyFields[header] || '':'';
      const result={index:column.columnIndex,header:column.header,destination:compatible(column,destination)?destination:'',group:0};
      if(additionalHeaders.has(header) && counts.get(header)===1){result.destination='orderAdditionalField';result.fieldName=String(column.header);}
      if(header==='und neg'){
        const values=samples(column);if(values.length && values.every(sample=>/^\+?57\d{10}$|^3\d{9}$/.test(String(sample.value).replace(/[ ()-]/g,'')))){result.destination='phone';reasons.push('UND NEG tiene forma de celular: confirma su significado en esta variante.');}
        else {result.destination='orderAdditionalField';result.fieldName=String(column.header);reasons.push('UND NEG textual o ambiguo: se conserva como información del pedido, no se asigna a celular.');}
      }
      return result;
    });
    statusMapSuggestions={...statusSuggestions};reasons.push('Una fila representa un pedido y un envío solo tras confirmación. PAUTA es campaña de origen, no gasto. FECHA es comercial, nunca entrega ni corte.');
    if(headers.includes('obsequio'))reasons.push('OBSEQUIO puede agregar una línea sin cobro: confirma que contiene una referencia real, vincula sus componentes y asigna cantidad o confirma una cantidad fija por fila. No se interpreta texto libre ni se deduce la cantidad vendida.');
  }else if(columns.length>=11 && headers.filter(header=>header==='valor').length>=4 && columns.slice(1,9).filter((column,index)=>index%2===0).every(column=>samples(column).every(sample=>Number.isInteger(Number(sample.value)) && Number(sample.value)>=0))){
    config={...config,purpose:'expenses',layout:'expense_columns',defaults:{expenseCategory:'advertising',expenseConcept:'Publicidad'},expenseGroupNames:{}};
    config.columns=columns.map(column=>({index:column.columnIndex,header:column.header,destination:column.columnIndex===0?'expenseDate':column.columnIndex>=1 && column.columnIndex<=8?(column.columnIndex%2?'expenseQuantity':'expenseUnitCost'):column.columnIndex===10?'expenseControlTotal':'',group:column.columnIndex>=1 && column.columnIndex<=8?Math.floor((column.columnIndex-1)/2):0}));
    for(let group=0;group<4;group++){const name=String(columns[group*2+1]?.header || '').trim();if(name)config.expenseGroupNames[group]=name;}
    reasons.push('Publicidad por cantidad × costo unitario; confirma los nombres de campaña y el total de control. No importes dos copias de la misma tabla.');
  }else {
    const hasTotals=headers.some(header=>/total|suma|resumen/.test(header)),repeated=headers.some(header=>header && counts.get(header)>1),hasOperation=['producto','product','id pedido','id envio','concepto'].some(header=>headers.includes(header));
    if(hasTotals && repeated && !hasOperation)reasons.push('Resumen con bloques o totales, no transacciones individuales: propone no importar; confirma la exclusión.');
    else if(!hasOperation && headers.some(header=>/nombre|celular|telefono|documento/.test(header)))reasons.push('Listado de personas o contactos sin transacciones: propone no importar y no crea clientes ni bloqueos.');
    else reasons.push('No hay una tabla inequívoca; elige propósito, encabezado y columnas o excluye explícitamente.');
  }
  const variants=[...new Map(profiles.filter(profile=>profile.enabled!==false).map(profile=>[signature(profile),profile])).values()];
  const compatibleProfiles=variants.filter(profile=>profile.columns.some(column=>column.destination && column.destination!=='ignore') && profile.columns.filter(column=>column.destination && column.destination!=='ignore').every(column=>{
    const positions=columns.filter(value=>normalize(value.header)===normalize(column.header)),matched=columns.find(value=>value.columnIndex===column.index && normalize(value.header)===normalize(column.header)) || (positions.length===1?positions[0]:null);
    return !!matched && compatible(matched,column.destination);
  }));
  const exactProfile=compatibleProfiles.find(profile=>profile.sheetName===sheet.name);
  if(exactProfile || compatibleProfiles.length===1){const profile=exactProfile || compatibleProfiles[0];config={...profile,sheetName:sheet.name,headerRow:candidate.rowNumber,reportAsOf:null,enabled:false};reasons.push('Perfil compatible por encabezados y tipos; confirma esta carga y su corte.');}
  else if(compatibleProfiles.length>1)reasons.push('Hay variantes distintas compatibles: elige la que describe esta hoja.');
  const variantKey=hash([signature(config),columns.map(column=>[...new Set(samples(column).map(sample=>typeof sample.value))].sort())]);
  return {sheetName:sheet.name,config,requiresConfirmation:true,reasons,statusMapSuggestions,variantKey,compatibleProfiles:compatibleProfiles.map(profile=>({...profile,reportAsOf:null}))};
}
export function suggestWorkbookImports(workbook,profile={sheets:[]}){
  const sheets=(workbook.sheets || []).map(sheet=>suggestSheetImport(sheet,{profiles:profile.sheets || []})),variants=new Map(),comparisons=new Map();
  for(const sheet of sheets){
    const original=(workbook.sheets || []).find(value=>value.name===sheet.sheetName);
    for(const range of original.comparisonRanges || []){
      const key=JSON.stringify([range.range,range.hash]),previous=comparisons.get(key);
      if(previous && sheet.config.purpose==='expenses' && sheet.config.layout==='expense_columns'){
        sheet.possibleDuplicateOf={sheetName:previous,range:range.range,hash:range.hash};
        sheet.reasons.push(`Coincide exactamente el contenido y las fórmulas ${range.range} con «${previous}». Propone excluir la copia; confirma antes de sumar gastos independientes.`);
        sheet.config.enabled=false;sheet.variantKey+=`:duplicate:${previous}`;
      }else comparisons.set(key,sheet.sheetName);
    }
    const names=variants.get(sheet.variantKey)||[];names.push(sheet.sheetName);variants.set(sheet.variantKey,names);
  }
  return {sheets,variants:[...variants].map(([key,sheetNames])=>({key,sheetNames,requiresConfirmation:true}))};
}
