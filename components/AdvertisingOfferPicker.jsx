'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social/offers';
const labels = { product: 'Producto', gift: 'Obsequio', combo: 'Combo' };
const availability = { available: 'Disponible', consult: 'Consultar disponibilidad', soldout: 'Agotado', unavailable: 'Referencia no seleccionable' };
const price = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
export const offerLabel = item => [item.title, item.presentation, item.flavor].filter(Boolean).join(' · ');
export function OfferSummary({ item, gift = false }) {
  if (!item) return null;
  return <article className={styles.offerCard}>
    {item.image && <img src={item.image} alt="" width={72} height={72} loading="lazy"/>}
    <div><p><strong>{gift ? 'Obsequio adicional: ' : ''}{offerLabel(item)}</strong> · {labels[item.kind]}</p>
      <p>{item.price !== null ? `COP ${price.format(item.price)}` : 'Precio sin confirmar'}{item.availability ? ` · ${availability[item.availability]}` : ''}</p>
      {item.components?.length > 0 && <ul aria-label={gift ? 'Composición del obsequio' : 'Composición de la oferta'}>{item.components.map((part, index) => <li key={`${part.id}:${index}`}>{part.quantity} × {offerLabel(part)}</li>)}</ul>}
      {item.conditions && <p><strong>Condiciones del combo:</strong> {item.conditions}</p>}
      {gift && <p><strong>Para qué compra aplica:</strong> {item.condition || 'Condición pendiente'}</p>}
    </div>
  </article>;
}
export const readAdvertisingOffer = async (api, { kind, id }, options) => (await api(`${ROOT}?${new URLSearchParams({ kind, id })}`, options)).offer;

export default function AdvertisingOfferPicker({ api, giftOnly = false, selected, onSelect, onClose }) {
  const [kind, setKind] = useState(giftOnly ? 'gift' : 'product'), [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0), [page, setPage] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0), [picking, setPicking] = useState(false);
  const input = useRef(null), inFlight = useRef(null);
  useEffect(() => { input.current?.focus(); return () => inFlight.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const result = await api(`${ROOT}?${new URLSearchParams({ kind, query, offset: String(offset) })}`, { signal: controller.signal });
        if (!controller.signal.aborted) setPage(result);
      } catch (cause) { if (!controller.signal.aborted) setError(cause.message); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, kind, query, offset, retry]);
  function change(setter, value) { setter(value); setPage(null); setError(''); }
  async function select(result) {
    if (inFlight.current) return;
    const controller = new AbortController(); inFlight.current = controller; setPicking(true); setError('');
    try {
      const offer = await readAdvertisingOffer(api, result, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!offer.selectable) throw new Error('La disponibilidad cambió. Elige otra referencia.');
      onSelect(offer);
    } catch (cause) { if (!controller.signal.aborted) setError(cause.message); }
    finally { if (!controller.signal.aborted) setPicking(false); inFlight.current = null; }
  }
  return <div className={styles.stack} role="group" aria-label={giftOnly ? 'Elegir obsequio adicional' : 'Elegir oferta del catálogo'}>
    {!giftOnly && <label>Tipo de oferta<select disabled={picking} value={kind} onChange={event => { change(setKind, event.target.value); setOffset(0); }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
    <label>{giftOnly ? 'Buscar obsequios' : 'Buscar oferta por nombre, presentación, sabor o SKU'}<input type="search" ref={input} disabled={picking} value={query} maxLength={100} onChange={event => { change(setQuery, event.target.value); setOffset(0); }}/></label>
    {error && <div role="alert"><p>{error}</p><button type="button" className="button subtle" onClick={() => change(setRetry, retry + 1)}>Reintentar</button></div>}
    {!page && !error && <p role="status">Buscando ofertas…</p>}
    {page && !page.offers.length && <p role="status">No hay coincidencias. Prueba otro sabor, nombre o tipo.</p>}
    {picking && <p role="status">Leyendo los datos de la oferta…</p>}
    <ul className={styles.offerList}>{page?.offers.map(item => <li key={item.id}>
      <button type="button" className={styles.offerChoice} disabled={picking || !item.selectable} aria-pressed={selected?.id === item.id && selected?.kind === item.kind} onClick={() => select(item)}>
        {item.image && <img src={item.image} alt="" width={48} height={48} loading="lazy"/>}<span><strong>{offerLabel(item)}</strong><small>{item.sku ? `SKU ${item.sku}` : `Ref. ${item.id.slice(0, 8)}`} · {item.price !== null ? `COP ${price.format(item.price)}` : 'Precio sin confirmar'} · {availability[item.availability]}</small></span>
      </button>
    </li>)}</ul>
    <div className={styles.actions}>
      {offset > 0 && <button type="button" className="button subtle" disabled={picking} onClick={() => change(setOffset, Math.max(0, offset - 12))}>Ofertas anteriores</button>}
      {page?.nextOffset != null && <button type="button" className="button subtle" disabled={picking} onClick={() => change(setOffset, page.nextOffset)}>Más ofertas</button>}
      <button type="button" className="button ghost" onClick={onClose}>Cerrar búsqueda</button>
    </div>
  </div>;
}
