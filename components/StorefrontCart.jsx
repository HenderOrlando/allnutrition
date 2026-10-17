'use client';

import { useEffect, useState } from 'react';
import Icon from './Icons';
import ImageByUrl from './ImageByUrl';
import { money, whatsAppLink } from '@/lib/schema.mjs';

const storageKey = 'allnutrition:order';
const maxQuantity = 99;

const normalizedLabel = value => value.toLocaleLowerCase('es-CO').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function productLabel(product) {
  const parts = [product.title];
  let included = ` ${normalizedLabel(product.title)} `;
  for (const detail of [product.presentation, product.flavor]) {
    if (!detail) continue;
    const normalized = normalizedLabel(detail);
    if (normalized && included.includes(` ${normalized} `)) continue;
    parts.push(detail);
    included += `${normalized} `;
  }
  return parts.join(' · ');
}

export function inquiryWhatsAppLink(settings, product) {
  return whatsAppLink(settings, product ? productLabel(product) : undefined);
}

export function orderWhatsAppLink(settings, lines) {
  const destination = new URL(whatsAppLink(settings, 'este pedido'));
  const totalMinor = lines.reduce((sum, line) => sum + Math.round(line.price * 100) * line.quantity, 0);
  const summary = lines.map(line => `${line.quantity} × ${productLabel(line)}`).join('\n');
  destination.searchParams.set('text', `${destination.searchParams.get('text')}\n\n${summary}\n\nTotal de productos: ${money(totalMinor / 100)} COP`);
  return destination.href;
}

export function useStorefrontCart(products, combos) {
  const [entries, setEntries] = useState([]);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const restore = event => {
      if (event && !event.persisted) return;
      try {
        const stored = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
        if (Array.isArray(stored)) {
          setEntries(stored.filter(entry => entry && typeof entry.id === 'string' &&
            ['products', 'combos'].includes(entry.kind) && Number.isInteger(entry.quantity) &&
            entry.quantity >= 1 && entry.quantity <= maxQuantity));
        }
      } catch { /* El pedido sigue disponible si el navegador no permite almacenamiento. */ }
      setReady(true);
      if (event) setNotice('');
    };
    restore();
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);

  useEffect(() => {
    if (ready) {
      try { sessionStorage.setItem(storageKey, JSON.stringify(entries)); } catch { /* Sesión sin persistencia. */ }
    }
  }, [entries, ready]);

  const lines = entries.flatMap(entry => {
    const record = (entry.kind === 'combos' ? combos : products).find(item => item.id === entry.id);
    return record && record.availability !== 'soldout' ? [{ ...record, kind: entry.kind, quantity: entry.quantity }] : [];
  });
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const totalMinor = lines.reduce((sum, line) => sum + Math.round(line.price * 100) * line.quantity, 0);

  function add(record, quantity = 1, kind = 'products') {
    if (record.availability === 'soldout' || !ready) return;
    setEntries(current => {
      const existing = current.find(entry => entry.id === record.id && entry.kind === kind);
      return existing
        ? current.map(entry => entry === existing ? { ...entry, quantity: Math.min(maxQuantity, entry.quantity + quantity) } : entry)
        : [...current, { id: record.id, kind, quantity: Math.min(maxQuantity, quantity) }];
    });
    setNotice(`${record.title} ya está en tu pedido`);
  }

  function setQuantity(id, kind, quantity) {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity) return;
    setEntries(current => current.map(entry => entry.id === id && entry.kind === kind ? { ...entry, quantity } : entry));
  }

  function remove(id, kind) {
    setEntries(current => current.filter(entry => entry.id !== id || entry.kind !== kind));
    setNotice('');
  }

  return { lines, count, total: totalMinor / 100, add, setQuantity, remove, notice, ready };
}

export function QuantityPicker({ quantity, onChange, label }) {
  return <div className="quantity-picker" role="group" aria-label={label}>
    <button type="button" aria-label="Reducir cantidad" disabled={quantity <= 1} onClick={() => onChange(quantity - 1)}>−</button>
    <output aria-live="polite">{quantity}</output>
    <button type="button" aria-label="Aumentar cantidad" disabled={quantity >= maxQuantity} onClick={() => onChange(quantity + 1)}>+</button>
  </div>;
}

export default function StorefrontCart({ cart, settings, dialogRef }) {
  return <dialog className="store-cart" ref={dialogRef} aria-labelledby="cart-title"
    onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="cart-heading">
      <div><p className="eyebrow">{cart.lines.length ? 'REVISA TU SELECCIÓN' : 'PREPARA TU PEDIDO'}</p><h2 id="cart-title">Mi pedido<span>.</span></h2></div>
      <button type="button" className="icon-button" aria-label="Cerrar pedido" onClick={() => dialogRef.current.close()}><Icon name="close" size={24}/></button>
    </div>
    <div className="cart-lines">
      {cart.lines.length === 0 ? <div className="cart-empty"><Icon name="box" size={48}/><h3>Tu pedido empieza aquí.</h3><p>Elige productos del catálogo y ajusta las unidades antes de continuar.</p><button className="button primary" onClick={() => dialogRef.current.close()}>Elegir productos <Icon name="arrow"/></button></div> : cart.lines.map(line =>
        <article className="cart-line" key={`${line.kind}:${line.id}`}>
          <ImageByUrl src={line.image} alt={line.title} width="82" height="100"/>
          <div className="cart-line-info"><h3>{line.title}</h3><p>{[line.presentation, line.flavor].filter(Boolean).join(' · ')}</p><strong>{money(Math.round(line.price * 100) * line.quantity / 100)} <small>COP</small></strong>
            <div className="cart-line-controls"><QuantityPicker quantity={line.quantity} label={`Cantidad de ${line.title}`} onChange={quantity => cart.setQuantity(line.id, line.kind, quantity)}/><button className="text-button" aria-label={`Quitar ${line.title}`} onClick={() => cart.remove(line.id, line.kind)}>Quitar</button></div>
          </div>
        </article>)}
    </div>
    {cart.lines.length > 0 && <div className="cart-summary">
      <div className="cart-total"><span>Subtotal · {cart.count} {cart.count === 1 ? 'unidad' : 'unidades'}</span><strong data-cart-total>{money(cart.total)} <small>COP</small></strong></div>
      <p>Abre WhatsApp con este resumen para confirmar disponibilidad y envío.</p>
      <a className="button primary full" href={orderWhatsAppLink(settings, cart.lines)} target="_blank" rel="noopener noreferrer"><Icon name="chat"/>Continuar por WhatsApp <Icon name="arrow"/></a>
      <span className="cart-reassurance"><Icon name="check" size={13}/>Sin cobros en la web.</span>
      <button className="text-link cart-continue" onClick={() => dialogRef.current.close()}>Seguir eligiendo</button>
    </div>}
  </dialog>;
}
