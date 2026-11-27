'use client';

import { carrierLabel } from './HekaForms';
import styles from './ShippingCenter.module.css';

const number = new Intl.NumberFormat('es-CO',{maximumFractionDigits:2});
const weightFormat = new Intl.NumberFormat('es-CO',{maximumFractionDigits:3});
const shown = value => value == null ? 'No informado' : number.format(value);
export const environmentLabel = environment => environment === 'production' ? 'Producción' : 'Pruebas';
export const locationLabel = ({city,state,dane}={}) => [city,state].filter(Boolean).join(', ') || dane || 'Sin indicar';

function Breakdown({offer}) {
  return <details><summary>Desglose</summary><dl className={styles.breakdown}>
    {[[ 'Flete base', offer.base ],[ 'Seguro',offer.insurance ],[ 'Comisión de la transportadora',offer.carrierCommission ],[ 'Comisión de la plataforma',offer.platformCommission ]].map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{shown(value)}</dd></div>)}
    <div><dt>Restricciones</dt><dd>{[offer.restrictions].flat().filter(Boolean).join(' · ') || 'No informado'}</dd></div>
  </dl>{offer.details?.length>0 && <dl className={styles.breakdown}>{offer.details.map(({path,value},i)=><div key={`${path}:${i}`}><dt>{path}</dt><dd>{shown(value)}</dd></div>)}</dl>}</details>;
}

function offerKey({provider, index}) { return `${provider.id}:${index}`; }
export default function ShippingQuoteResults({quote,sort,onSort,onUse,onRetry,busy}) {
  if (!quote) return null;
  const {providers,draft} = quote;
  const entries = providers.flatMap(provider=>(provider.offers ?? []).map((offer,index)=>({provider,offer,index})));
  const orderableTotal = entries.filter(({offer}) => offer.total != null && offer.currency && offer.carrier);
  const totalComparable = orderableTotal.length > 1 && new Set(orderableTotal.map(({offer})=>JSON.stringify([offer.currency,[...(offer.restrictions??[])].sort()]))).size === 1;
  const daysComparable = entries.filter(({offer})=>offer.days!=null).length>1;
  if (sort==='total' && totalComparable) {
    const allowed = new Set(orderableTotal.map(offerKey));
    entries.sort((l,r) => Number(allowed.has(offerKey(r)))-Number(allowed.has(offerKey(l))) || (allowed.has(offerKey(l)) ? l.offer.total-r.offer.total : 0));
  } else if (sort==='days' && daysComparable) entries.sort((l,r)=>(l.offer.days ?? Infinity)-(r.offer.days ?? Infinity) || 0);
  const {parcel,payment,route}=draft;
  return <section className="settings-card" aria-label="Comparación de tarifas" aria-live="polite">
    <h3>Ofertas estimadas · {locationLabel(route.origin)} → {locationLabel(route.destination)}</h3>
    <p>{weightFormat.format(parcel.weightG/1000)} kg · {[parcel.lengthMm,parcel.widthMm,parcel.heightMm].map(size=>number.format(size/10)).join(' × ')} cm · Valor declarado: {shown(payment.declaredMinor/100)} COP · Recaudo: {shown(payment.collectionMinor/100)} COP · Paga: {payment.payer==='sender'?'remitente':'destinatario'}{payment.includeShipping?' · Incluye flete en el recaudo':''}</p>
    <p className="hint">El precio es una estimación para esta solicitud, no un cargo confirmado.</p>
    {providers.filter(provider=>!provider.offers?.length).map(provider=><div className="settings-subform" key={provider.id}><p><strong>{provider.label} · {environmentLabel(provider.environment)}</strong> — {provider.state==='no_coverage'?'Sin cobertura para esta solicitud.':'No se pudo cotizar con esta plataforma.'}</p>{provider.details?.length>0&&<details><summary>Desglose de importes sin identificar</summary><dl className={styles.breakdown}>{provider.details.map(({path,value},index)=><div key={`${path}:${index}`}><dt>{path}</dt><dd>{shown(value)}</dd></div>)}</dl></details>}{provider.state!=='no_coverage'&&<button type="button" className="button subtle" disabled={busy} onClick={()=>onRetry(provider.id)}>Reintentar esta plataforma</button>}</div>)}
    {entries.length>0 && <><label className="field">Orden de las ofertas<select value={sort==='total'&&!totalComparable||sort==='days'&&!daysComparable?'provider':sort} onChange={event=>onSort(event.target.value)}><option value="provider">Orden de plataforma</option>{totalComparable&&<option value="total">Menor total comparable</option>}{daysComparable&&<option value="days">Menor plazo informado</option>}</select></label>
      <table className={styles.quotes}><caption className={styles.srOnly}>Comparación de tarifas estimadas</caption><thead><tr><th scope="col">Plataforma · transportadora</th><th scope="col">Costo informado</th><th scope="col">Plazo estimado</th><th scope="col">Acción</th></tr></thead><tbody>{entries.map(({provider,offer,index})=><tr key={offerKey({provider,index})}>
        <th scope="row">{provider.label} · {offer.carrier ? carrierLabel(offer.carrier) : 'Transportadora no identificada'}<small>{environmentLabel(provider.environment)}{offer.service?` · ${offer.service}`:''}</small></th>
        <td><strong>{offer.total!=null?'Total estimado':offer.amount!=null?'Importe informado':'Costo'}</strong> {shown(offer.total ?? offer.amount)}{offer.total!=null||offer.amount!=null ? ` · ${offer.currency ?? 'moneda no informada'}` : ''}</td>
        <td><strong className={styles.mobileLabel}>Plazo: </strong>{offer.days==null?'No informado':`${offer.days} ${offer.days===1?'día':'días'}`}</td>
        <td><Breakdown offer={offer}/>{offer.canEmit ? <button type="button" className="button subtle" disabled={busy} onClick={()=>onUse(provider,offer)}>Usar esta opción</button> : <small>No disponible para emitir: plataforma o transportadora no confirmada.</small>}</td>
      </tr>)}</tbody></table></>}
  </section>;
}
