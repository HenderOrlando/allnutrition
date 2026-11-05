'use client';
import { formatMoneyMinor } from '@/lib/business/money.mjs';
import styles from './OrderExperience.module.css';

const dateFormatter=new Intl.DateTimeFormat('es-CO',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Bogota'});
const dayFormatter=new Intl.DateTimeFormat('es-CO',{dateStyle:'medium',timeZone:'UTC'});
const dateLabel=value=>value?(/^\d{4}-\d{2}-\d{2}$/.test(value)?dayFormatter:dateFormatter).format(new Date(value)):'Sin corte conocido';
const columnLabel=index=>{if(!Number.isInteger(index))return 'Sin columna conocida';let value=index+1,label='';while(value>0){value--;label=String.fromCharCode(65+value%26)+label;value=Math.floor(value/26);}return `${label} · columna ${index+1} (índice ${index})`;};
const displayValue=field=>field.valueType==='money_minor'||['insuredValue','expectedCollection'].includes(field.key)?`${formatMoneyMinor(field.value)} COP`:typeof field.value==='boolean'?(field.value?'Sí':'No'):String(field.value??'');

export default function ImportedData({record,title='Datos importados',description}){
  const fieldsBySource=new Map();
  for(const field of record.importedFields||[]){if(!fieldsBySource.has(field.sourceId))fieldsBySource.set(field.sourceId,[]);fieldsBySource.get(field.sourceId).push(field);}
  return <section className="form-section"><h3>{title}</h3>{description&&<p className="hint">{description}</p>}{!fieldsBySource.size&&<p>No hay datos informativos importados para este registro.</p>}{Array.from(fieldsBySource,([sourceId,fields])=><section key={sourceId||'without-source'}><h4>Fuente: {sourceId?(sourceId===record.sourceId&&record.sourceName?`${record.sourceName} · ${sourceId}`:`Fuente ${sourceId}`):'Sin fuente identificada'}</h4>{fields.map(field=><article className={styles.observation} key={field.key}><h5>{field.label}</h5><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{displayValue(field)}</p><dl><dt>Corte de la observación (Bogotá)</dt><dd>{dateLabel(field.sourceAsOf)}</dd><dt>Lote de importación</dt><dd>{field.batchId||'Sin lote conocido'}</dd><dt>Hoja</dt><dd>{field.sheet||'Sin hoja conocida'}</dd><dt>Columna de origen</dt><dd>{columnLabel(field.columnIndex)}</dd><dt>Encabezado original</dt><dd style={{whiteSpace:'pre-wrap'}}>{field.header||'Sin encabezado'}</dd><dt>Filas del archivo</dt><dd>{field.rowNumbers?.length?field.rowNumbers.join(', '):'Sin filas conocidas'}</dd></dl>{field.declaredOrigin&&<section><h6>Origen declarado en el archivo</h6><p className="hint">Información declarada; no acredita procedencia de otra fuente.</p><dl><dt>Hoja declarada</dt><dd>{field.declaredOrigin.sheet}</dd><dt>Fila declarada</dt><dd>{field.declaredOrigin.rowNumber}</dd><dt>Columna declarada</dt><dd>{columnLabel(field.declaredOrigin.columnIndex)}</dd><dt>Encabezado declarado</dt><dd style={{whiteSpace:'pre-wrap'}}>{field.declaredOrigin.header||'Sin encabezado'}</dd></dl></section>}</article>)}</section>)}</section>;
}
