'use client';
import { useMemo } from 'react';
import ImportedData from './ImportedData';
import { formatMoneyMinor } from '@/lib/business/money.mjs';
import styles from './OrderExperience.module.css';

const CATEGORY_LABELS={advertising:'Publicidad',operating:'Operación',other:'Otros gastos'};
const integerFormatter=new Intl.NumberFormat('es-CO');
const exactMoney=value=>{const cents=value<0n?-value:value;return `${value<0n?'-':''}$ ${integerFormatter.format(cents/100n)}${cents%100n?`,${String(cents%100n).padStart(2,'0')}`:''}`;};
const quantity=value=>value==null?'Desconocidas':integerFormatter.format(value);

export function InventoryOpeningControls({date,opening,disabled,onDate,onConfirm}){
 return <fieldset className={styles.importGroup} disabled={disabled}><legend>Conteo físico de apertura (opcional)</legend><p>No se exige un conteo de apertura para cada importación. Si necesitas incorporar un conteo real para no descontar otra vez lo que ya salió antes de esa fecha, guarda las existencias reales en cada producto y confirma esta apertura. No completes un saldo desconocido con cero ni con una cantidad supuesta. Esta fecha no es un saldo de caja ni la fecha de carga.</p><label className="field">Fecha del conteo físico<input type="date" value={date} onChange={event=>onDate(event.target.value)}/></label><label className="checkbox-field"><input type="checkbox" disabled={!date} checked={!!opening?.confirmed&&opening.on===date} onChange={event=>onConfirm(event.target.checked)}/><span>Confirmo que las existencias guardadas son el conteo físico real de esta fecha</span></label><p className="small muted">Solo si confirmas una apertura: los hechos claramente anteriores quedan incluidos en ese conteo. Una salida o devolución del mismo día, o sin fecha, requiere indicar si ya estaba incluida; no se deduce de un estado ni del corte del Excel. Los pedidos existentes conservan su propia frontera.</p>{opening&&<p role="status">Apertura preparada para {opening.on}. Este cambio se aplicará al confirmar una revisión nueva; las operaciones ya incorporadas se conservan.</p>}</fieldset>;
}

export default function ImportReviewEffects({preview,opening,accepted=false,disabled,onEditProduct}){
 const {expenses,categories,stock,names,inventoryIssues}=useMemo(()=>{
  const groups=preview?.groups||[],expenses=groups.flatMap(group=>group.expenses||[]),categories=new Map();
  for(const expense of expenses){const category=expense.input.category;categories.set(category,(categories.get(category)||0n)+BigInt(expense.input.amountMinor));}
  const stock=preview?.inventory||[],names=new Map(groups.flatMap(group=>(group.lines||[]).flatMap(line=>[[line.productId||line.itemId,line.title||line.productExternalKey],...(line.components||[]).map(component=>[component.productId,component.title])])).filter(([id,name])=>id&&name));
  const inventoryIssues=Array.from(new Map(groups.flatMap(group=>(group.errors||[]).filter(issue=>issue.code==='IMPORT_INVENTORY')).map(issue=>[`${issue.productId||''}:${issue.message}`,issue])).values());
  return {expenses,categories,stock,names,inventoryIssues};
 },[preview]);
 const hasStockIssues=stock.some(effect=>effect.issue)||inventoryIssues.length>0;
 const InventoryContainer=hasStockIssues?'section':'details';
 return <section className={styles.reviewEffects} aria-label="Efectos de la importación">
  <h3>{accepted?'Proyección de la revisión aceptada':'Efectos previstos de esta revisión'}</h3>
  {accepted&&<p><strong>Esta es la revisión anterior aceptada, no el resultado aplicado.</strong> Sus cifras quedaron congeladas al confirmar y no son una nueva lectura del inventario actual. Consulta el progreso y el resultado para saber qué operaciones se incorporaron.</p>}
  <p>Se crean o actualizan operaciones completas, no saldos supuestos. <strong>Caja no cambia por registrar estos gastos.</strong> Los estados de entrega tampoco demuestran un cobro.</p>
  {!!expenses.length&&<>
   <h4>Importes de gastos preparados</h4>
   <p className="small muted">No son importes finales aplicados. Incluyen los grupos que todavía necesitan resolver errores; la confirmación aplica únicamente la selección válida. Los gastos sin cambios no se vuelven a sumar al negocio.</p>
   <dl className={`summary-grid ${styles.summaryMetrics}`}>{Array.from(categories,([category,amount])=><div key={category}><dt>{CATEGORY_LABELS[category]||category}</dt><dd>{exactMoney(amount)}</dd></div>)}</dl>
  </>}
  <div>
   <h4>Existencias, reservas y disponibles</h4>
   <p>La regla depende de las existencias físicas de cada producto: sin registrar, se permiten pedidos y guías sin descontar un saldo supuesto, y las cantidades siguen desconocidas; con un saldo positivo, se controlan reservas y se descuentan las salidas. Un saldo de cero bloquea una venta nueva hasta actualizar el conteo real. No hace falta declarar una apertura para cada importación.</p>
   <p>{stock.length?`La revisión del servidor contiene efectos de inventario para ${integerFormatter.format(stock.length)} ${stock.length===1?'producto':'productos'}.`:'Todavía no hay una proyección de inventario disponible.'} No se calculan efectos adicionales para operaciones con datos insuficientes.</p>
   {opening&&<p>Conteo confirmado al {opening.on} en esta revisión. Las salidas históricas incluidas no descuentan otra vez existencias físicas; los pendientes sí reservan.</p>}
   {hasStockIssues&&<p className="error">Hay problemas de existencias por resolver. Los detalles de inventario permanecen visibles.</p>}
   {!!inventoryIssues.length&&<ul>{inventoryIssues.map(issue=><li key={`${issue.productId||''}:${issue.message}`}>{names.get(issue.productId)||'Producto de esta operación'}: {issue.message}</li>)}</ul>}
   <InventoryContainer aria-label="Detalles de inventario">
    {hasStockIssues?<h5>Detalles de inventario que requieren revisión</h5>:<summary>Ver detalles de inventario por producto</summary>}
    {!stock.length?<p>La proyección aparecerá cuando los pedidos tengan productos reales y datos suficientes. Si hay errores, resuélvelos y vuelve a revisar; no significa que el efecto sea cero.</p>:<div className={styles.inventoryEffects}>{stock.map(effect=><article key={effect.productId} className={styles.inventoryEffect}>
     <h5>{names.get(effect.productId)||'Producto sin nombre disponible'}</h5>
     <dl><dt>Físicas guardadas</dt><dd>{quantity(effect.stockQuantity==null?null:effect.stockQuantity+effect.consumptionDelta)}</dd><dt>Reservadas guardadas</dt><dd>{quantity(effect.stockReserved-effect.reservationDelta)}</dd><dt>{effect.stockQuantity==null?'Salidas previstas (sin descontar saldo desconocido)':'Consumo adicional'}</dt><dd>{quantity(effect.consumptionDelta)}</dd><dt>Cambio de reservas</dt><dd>{quantity(effect.reservationDelta)}</dd><dt>Físicas tras aplicar</dt><dd>{quantity(effect.stockQuantity)}</dd><dt>Disponibles tras aplicar</dt><dd>{quantity(effect.available)}</dd></dl>
     {effect.stockQuantity==null&&<p>Existencias físicas sin registrar en esta revisión: no impiden incorporar pedidos ni guías. El saldo físico y el disponible siguen desconocidos; no se asume cero ni otra cantidad.</p>}
     {effect.issue&&<p className="error">{effect.issue}</p>}
     <button type="button" className="button subtle" disabled={disabled} onClick={()=>onEditProduct(effect.productId)}>{effect.stockQuantity==null?'Registrar conteo real (opcional)':'Revisar conteo'} de {names.get(effect.productId)||'este producto'}</button>
     <details><summary>Identificación técnica del producto</summary><p>{effect.productId}</p></details>
    </article>)}</div>}
   </InventoryContainer>
  </div>
 </section>;
}

export function ReviewExpenses({group}){
 return !!group.expenses?.length&&<section aria-label="Gastos de esta operación"><h5>Gastos preparados, sin pagos automáticos</h5>{group.expenses.map(expense=>{const input=expense.input;return <article key={expense.externalId} className={styles.expenseReview}><h6>{input.concept}{input.campaign?` · ${input.campaign}`:''}</h6><dl><dt>Categoría</dt><dd>{CATEGORY_LABELS[input.category]||input.category}</dd><dt>Fecha del gasto</dt><dd>{input.incurredOn||'Pendiente'}</dd><dt>Importe explícito</dt><dd>{formatMoneyMinor(input.amountMinor)}</dd>{input.quantity!=null&&<><dt>Cantidad y unitario</dt><dd>{input.quantity} × {formatMoneyMinor(input.unitCostMinor)}</dd></>}<dt>Resultado previsto</dt><dd>{expense.unchanged?'Sin cambios':expense.existingId?'Actualizar gasto existente':'Crear gasto'}</dd><dt>Fecha de corte del origen</dt><dd>{input.sourceAsOf||'Pendiente'}</dd></dl>{input.supplier&&<p>Proveedor: {input.supplier}</p>}{input.reference&&<p>Referencia: {input.reference}</p>}{input.notes&&<p style={{whiteSpace:'pre-wrap'}}>{input.notes}</p>}<details><summary>Datos informativos y procedencia del gasto</summary><dl><dt>Identidad estable</dt><dd>{expense.externalId}{expense.generated?' · Técnica':''}</dd><dt>Identificación técnica del origen</dt><dd>{input.sourceId}</dd></dl><ImportedData record={input}/></details></article>;})}</section>;
}
