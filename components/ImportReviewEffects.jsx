'use client';
import { useMemo } from 'react';
import ImportedData from './ImportedData';
import { formatMoneyMinor } from '@/lib/business/money.mjs';
import styles from './OrderExperience.module.css';

const CATEGORY_LABELS={advertising:'Publicidad',operating:'Operación',other:'Otros gastos'};
const integerFormatter=new Intl.NumberFormat('es-CO');
const exactMoney=value=>{const cents=value<0n?-value:value;return `${value<0n?'-':''}$ ${integerFormatter.format(cents/100n)}${cents%100n?`,${String(cents%100n).padStart(2,'0')}`:''}`;};
const quantity=value=>value==null?'Sin contar':integerFormatter.format(value);

export function InventoryOpeningControls({date,opening,disabled,onDate,onConfirm}){
 return <fieldset className={styles.importGroup} disabled={disabled}><legend>Conteo físico de apertura</legend><p>Para incorporar historia sin descontar otra vez lo que ya salió, guarda primero las existencias reales en cada producto. Esta fecha no es un saldo de caja ni la fecha de carga.</p><label className="field">Fecha del conteo físico<input type="date" value={date} onChange={event=>onDate(event.target.value)}/></label><label className="checkbox-field"><input type="checkbox" disabled={!date} checked={!!opening?.confirmed&&opening.on===date} onChange={event=>onConfirm(event.target.checked)}/><span>Confirmo que las existencias guardadas son el conteo físico real de esta fecha</span></label><p className="small muted">Los hechos claramente anteriores quedan incluidos en ese conteo. Una salida o devolución del mismo día, o sin fecha, requiere indicar si ya estaba incluida; no se deduce de un estado ni del corte del Excel. Los pedidos existentes conservan su propia frontera.</p>{opening&&<p role="status">Apertura preparada para {opening.on}. Todavía no se ha aplicado ninguna operación.</p>}</fieldset>;
}

export default function ImportReviewEffects({preview,opening,accepted=false,disabled,onEditProduct}){
 const {expenses,categories,stock,names}=useMemo(()=>{
  const groups=preview?.groups||[],expenses=groups.flatMap(group=>group.expenses||[]),categories=new Map();
  for(const expense of expenses){const category=expense.input.category;categories.set(category,(categories.get(category)||0n)+BigInt(expense.input.amountMinor));}
  const stock=preview?.inventory||[],names=new Map(groups.flatMap(group=>(group.lines||[]).flatMap(line=>[[line.productId||line.itemId,line.title||line.productExternalKey],...(line.components||[]).map(component=>[component.productId,component.title])])).filter(([id,name])=>id&&name));
  return {expenses,categories,stock,names};
 },[preview]);
 return <section className={styles.reviewEffects} aria-label="Efectos de la importación"><h3>{accepted?'Proyección de la revisión aceptada':'Qué cambiará al aplicar'}</h3>{accepted&&<p>Estas son las cifras congeladas al confirmar, no una nueva lectura del inventario actual. El progreso indica qué operaciones ya se aplicaron.</p>}<p>Se crean o actualizan operaciones completas, no saldos supuestos. <strong>Caja no cambia por registrar estos gastos.</strong> Los estados de entrega tampoco demuestran un cobro.</p>
  {!!expenses.length&&<><h4>Importes de gastos preparados</h4><p className="small muted">Incluyen los grupos que todavía necesitan resolver errores; la confirmación aplica únicamente la selección válida. Los gastos sin cambios no se vuelven a sumar al negocio.</p><dl className={`summary-grid ${styles.summaryMetrics}`}>{Array.from(categories,([category,amount])=><div key={category}><dt>{CATEGORY_LABELS[category]||category}</dt><dd>{exactMoney(amount)}</dd></div>)}</dl></>}
  <h4>Existencias, reservas y disponibles</h4>{opening&&<p>Conteo confirmado al {opening.on}. Las salidas históricas incluidas no descuentan otra vez existencias físicas; los pendientes sí reservan.</p>}
  {!stock.length?<p>La proyección aparecerá cuando los pedidos tengan productos reales y datos suficientes. Si hay errores, resuélvelos y vuelve a revisar; no significa que el efecto sea cero.</p>:<div className={styles.inventoryEffects}>{stock.map(effect=><article key={effect.productId} className={styles.inventoryEffect}><h5>{names.get(effect.productId)||effect.productId}</h5><dl><dt>Físicas guardadas</dt><dd>{quantity(effect.stockQuantity)}</dd><dt>Reservadas guardadas</dt><dd>{quantity(effect.stockReserved)}</dd><dt>Consumo adicional</dt><dd>{quantity(effect.consumptionDelta)}</dd><dt>Cambio de reservas</dt><dd>{quantity(effect.reservationDelta)}</dd><dt>Físicas tras aplicar</dt><dd>{quantity(effect.stockQuantity==null?null:effect.stockQuantity-effect.consumptionDelta)}</dd><dt>Disponibles tras aplicar</dt><dd>{quantity(effect.available)}</dd></dl>{effect.issue&&<p className="error" role="alert">{effect.issue}</p>}<button type="button" className="button subtle" disabled={disabled} onClick={()=>onEditProduct(effect.productId)}>Revisar conteo de {names.get(effect.productId)||effect.productId}</button></article>)}</div>}
 </section>;
}

export function ReviewExpenses({group}){
 return !!group.expenses?.length&&<section aria-label="Gastos de esta operación"><h5>Gastos reales, sin pagos automáticos</h5>{group.expenses.map(expense=>{const input=expense.input;return <article key={expense.externalId} className={styles.expenseReview}><h6>{input.concept}{input.campaign?` · ${input.campaign}`:''}</h6><dl><dt>Categoría</dt><dd>{CATEGORY_LABELS[input.category]||input.category}</dd><dt>Fecha del gasto</dt><dd>{input.incurredOn||'Pendiente'}</dd><dt>Importe explícito</dt><dd>{formatMoneyMinor(input.amountMinor)}</dd>{input.quantity!=null&&<><dt>Cantidad y unitario</dt><dd>{input.quantity} × {formatMoneyMinor(input.unitCostMinor)}</dd></>}<dt>Identidad estable</dt><dd>{expense.externalId}{expense.generated?' · Técnica':''}</dd><dt>Resultado previsto</dt><dd>{expense.unchanged?'Sin cambios':expense.existingId?'Actualizar gasto existente':'Crear gasto'}</dd><dt>Fuente y corte</dt><dd>{input.sourceId} · {input.sourceAsOf||'Pendiente'}</dd></dl>{input.supplier&&<p>Proveedor: {input.supplier}</p>}{input.reference&&<p>Referencia: {input.reference}</p>}{input.notes&&<p style={{whiteSpace:'pre-wrap'}}>{input.notes}</p>}<details><summary>Datos informativos y procedencia del gasto</summary><ImportedData record={input}/></details></article>;})}</section>;
}
