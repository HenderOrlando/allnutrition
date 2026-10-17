'use client';

import { useEffect, useRef, useState } from 'react';
import localFont from 'next/font/local';
import Icon from './Icons';
import ImageByUrl from './ImageByUrl';
import StorefrontCart, { QuantityPicker, inquiryWhatsAppLink, useStorefrontCart } from './StorefrontCart';
import { money } from '@/lib/schema.mjs';
import styles from './Storefront.module.css';

const trainingFont = localFont({
  src: '../public/brand/barlow-condensed-extrabold.ttf',
  weight: '800',
  style: 'normal',
  display: 'swap',
  variable: '--font-training',
});

const availabilityLabel = record => record.availability === 'available' ? 'Disponible' :
  record.availability === 'soldout' ? 'Agotado' : 'Consulta disponibilidad';

function PurchaseAction({ record, cart, settings, quantity = 1, kind = 'products', className = 'button product-cta', children }) {
  if (record.availability === 'soldout') {
    return <a className={className} href={inquiryWhatsAppLink(settings, record)} target="_blank" rel="noopener noreferrer"><Icon name="chat"/>Consultar reposición</a>;
  }
  return <button type="button" className={className} disabled={!cart.ready} onClick={() => cart.add(record, quantity, kind)}>
    <Icon name="plus"/>{children || 'Añadir a mi pedido'}
  </button>;
}

function ThemeIcon({ dark }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {dark ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></> :
      <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/>}
  </svg>;
}

export default function Storefront({ data, selected = null, initialCatalog = null }) {
  const { settings: s, products, catalogs, combos, faqs, messages, shipping } = data;
  const [category, setCategory] = useState(initialCatalog || '');
  const [query, setQuery] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [theme, setTheme] = useState(null);
  const cart = useStorefrontCart(products, combos);
  const cartDialog = useRef(null);
  const openCart = () => cartDialog.current.showModal();

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = event => {
      if (event?.type === 'pageshow' && !event.persisted) return;
      let preference;
      try { preference = localStorage.getItem('allnutrition:theme'); } catch { /* Se usa el tema del dispositivo. */ }
      setTheme(['light', 'dark'].includes(preference) ? preference : media.matches ? 'dark' : 'light');
    };
    sync();
    media.addEventListener('change', sync);
    window.addEventListener('pageshow', sync);
    return () => {
      media.removeEventListener('change', sync);
      window.removeEventListener('pageshow', sync);
    };
  }, []);

  useEffect(() => { setQuantity(1); }, [selected?.id]);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem('allnutrition:theme', next); } catch { /* El cambio sigue activo en esta página. */ }
  }

  const hero = messages.find(message => message.placement === 'hero');
  const announcement = messages.find(message => message.placement === 'announcement');
  const social = [{ label: 'Instagram', href: s.instagram }, { label: 'Facebook', href: s.facebook }].filter(item => item.href);
  const matches = record => (!category || record.catalogIds.includes(category)) &&
    `${record.title} ${record.presentation || ''} ${record.flavor || ''} ${record.description || ''}`.toLowerCase().includes(query.trim().toLowerCase());
  const shown = products.filter(matches);
  const visibleCombos = combos.filter(matches);
  const highlighted = products.find(product => product.featured) || products[0];
  const visibleCatalogs = catalogs.filter(catalog => [...products, ...combos].some(record => record.catalogIds.includes(catalog.id)));
  const activeCatalog = catalogs.find(catalog => catalog.id === category);
  const wa = product => inquiryWhatsAppLink(s, product);

  return <div className={`${trainingFont.variable} ${styles.storefront} storefront`} data-theme={theme || undefined}>
    {!s.launchApproved && <div className="review-banner">VISTA DE REVISIÓN · Información y publicación pendientes de aprobación</div>}
    {announcement && <div className="announcement">{announcement.title}{announcement.body && ` · ${announcement.body}`}</div>}
    {!announcement && <div className="store-utility"><div className="wrap"><span>SUPLEMENTOS / ENTRENAMIENTO / CONSTANCIA</span><span><Icon name="chat" size={13}/>Atención directa por WhatsApp</span></div></div>}
    <header className="site-header">
      <div className="header-inner wrap">
        <a href="/" className="wordmark"><ImageByUrl src={s.logo || '/brand/logo.jpg'} width="48" height="48" alt=""/><span><strong>{s.brandName}</strong><small>{s.tagline}</small></span></a>
        <nav aria-label="Navegación principal">
          <a href="/#catalogo">Catálogo</a>
          {combos.length > 0 && <a href="/#combos">Combos</a>}
          <a href="/#como-comprar">Cómo comprar</a>
          <a className="nav-help" href={wa()} target="_blank" rel="noopener noreferrer">Te ayudamos a elegir <Icon name="external" size={12}/></a>
        </nav>
        <div className="header-actions">
          <button type="button" className="icon-button" aria-label={`Cambiar a tema ${theme === 'dark' ? 'claro' : 'oscuro'}`} title={`Tema ${theme === 'dark' ? 'claro' : 'oscuro'}`} onClick={toggleTheme}><ThemeIcon dark={theme === 'dark'}/></button>
          <button type="button" className="cart-button" aria-label={`Ver pedido, ${cart.count} ${cart.count === 1 ? 'unidad' : 'unidades'}`} onClick={openCart}><Icon name="box" size={18}/><span>Mi pedido</span><span className="cart-count">{cart.count}</span></button>
        </div>
      </div>
    </header>
    <main>
      {selected ? <section className="detail wrap">
        <a className="text-link" href="/#catalogo">← Volver al catálogo</a>
        <div className="detail-grid">
          <div className="detail-photo"><span className="detail-photo-label">CONOCE EL PRODUCTO. ELIGE CON CRITERIO.</span>{selected.image ? <ImageByUrl src={selected.image} alt={selected.title}/> : <Icon name="box" size={100}/>}</div>
          <div className="detail-copy">
            <p className="eyebrow">{selected.kind === 'combos' ? 'UNA COMBINACIÓN PARA TU RUTINA' : catalogs.find(catalog => selected.catalogIds.includes(catalog.id))?.title || 'ALL NUTRITION'}</p>
            <h1>{selected.title}</h1>
            <p className="detail-presentation">{[selected.presentation, selected.flavor].filter(Boolean).join(' · ')}</p>
            <span className="detail-availability">{selected.availability === 'available' && <Icon name="check" size={13}/>} {availabilityLabel(selected)}</span>
            <p className="detail-price">{money(selected.price)} <small>COP</small></p>
            <p className="small muted">Revisa la presentación y elige cuántas unidades quieres.</p>
            <div className="detail-buy">
              <p className="purchase-prompt">{selected.availability === 'soldout' ? 'Pregunta por la próxima disponibilidad.' : 'Prepara tu pedido.'}</p>
              <div className="detail-buy-row">
                {selected.availability !== 'soldout' && <QuantityPicker quantity={quantity} label={`Cantidad de ${selected.title}`} onChange={setQuantity}/>}
                <PurchaseAction record={selected} settings={s} cart={cart} quantity={quantity} kind={selected.kind} className="button primary"/>
              </div>
              {selected.availability !== 'soldout' && <a className="text-link detail-inquiry" href={wa(selected)} target="_blank" rel="noopener noreferrer"><Icon name="chat" size={17}/>Preguntar por este producto</a>}
              <span className="purchase-reassurance"><Icon name="check" size={15}/>Confirmamos disponibilidad, pago y envío por WhatsApp. Sin cobros en la web.</span>
            </div>
            {selected.description && <div className="detail-story"><h2>Lo que necesitas saber<span>.</span></h2><p className="detail-description">{selected.description}</p></div>}
            {selected.kind === 'combos' && <div className="combo-list"><h3>Qué incluye</h3>{selected.items.map(item => <p key={item.productId}>{item.quantity} × {products.find(product => product.id === item.productId)?.title}</p>)}</div>}
            {selected.productInfo && <div className="product-notes"><h3>Información del producto</h3><p>{selected.productInfo}</p></div>}
            {selected.conditions && <div className="product-notes"><h3>Condiciones del combo</h3><p>{selected.conditions}</p></div>}
          </div>
        </div>
      </section> : <section className="hero wrap">
        <div className="hero-copy">
          <p className="eyebrow"><span/>TU RUTINA. A TU MANERA.</p>
          <h1>{hero?.title || 'Prepara tu próximo entreno.'}</h1>
          <p className="hero-description">{hero?.body || 'Encuentra tus suplementos, añade los que necesitas y confirma tu pedido por WhatsApp.'}</p>
          <div className="hero-actions">
            <a href="#catalogo" className="button primary">Elegir mis suplementos <Icon name="arrow"/></a>
            <a className="text-link" href={wa()} target="_blank" rel="noopener noreferrer">{hero?.buttonText || 'Ayúdame a elegir'} <Icon name="chat" size={17}/></a>
          </div>
          <div className="hero-caption"><Icon name="check" size={17}/><span>Pedido claro. Atención de persona a persona.</span></div>
        </div>
        <div className="hero-visual">
          <div className="stage-heading"><span>Selección para tu entrenamiento</span><span>{catalogs.find(catalog => highlighted?.catalogIds.includes(catalog.id))?.title || 'ALL NUTRITION'}</span></div>
          {highlighted ? <>
            <a className="hero-product-link" href={`/productos/${highlighted.slug}`}><ImageByUrl className="hero-product" src={highlighted.image} alt={highlighted.title}/></a>
            <div className="hero-product-note">
              <div><span className="eyebrow">{highlighted.presentation || 'SELECCIÓN DEL CATÁLOGO'}</span><strong><a href={`/productos/${highlighted.slug}`}>{highlighted.title}</a></strong><span className="hero-price">{money(highlighted.price)} <small>COP</small></span></div>
              <PurchaseAction record={highlighted} settings={s} cart={cart} className="button primary">Añadir a mi pedido <Icon name="arrow" size={17}/></PurchaseAction>
            </div>
          </> : <ImageByUrl className="hero-product" src={s.logo} alt={s.brandName}/>}
        </div>
      </section>}

      <div className="service-band"><div className="wrap service-inner">
        <span><Icon name="box"/>Elige tu suplemento</span>
        <span><Icon name="plus"/>Ajusta tus cantidades</span>
        <span><Icon name="chat"/>Confirma por WhatsApp</span>
      </div></div>

      <section className="section wrap" id="catalogo">
        <div className="section-heading">
          <div><p className="eyebrow">{selected ? 'SIGUE ARMANDO TU PEDIDO' : 'SUPLEMENTOS PARA TU ENTRENAMIENTO'}</p><h2>Suma a tu entrenamiento<span>.</span></h2></div>
          <div className="section-intro"><p>Presentaciones, precios y detalles a la vista. Elige tus productos y prepara tu pedido.</p><span className="catalog-count" aria-live="polite">{shown.length} {shown.length === 1 ? 'producto para elegir' : 'productos para elegir'}</span></div>
        </div>
        <div className="catalog-tools">
          <div className="filter-tabs" role="group" aria-label="Filtrar por catálogo">
            <button type="button" className={!category ? 'active' : ''} aria-pressed={!category} onClick={() => setCategory('')}>Todos</button>
            {visibleCatalogs.map(catalog => <button type="button" key={catalog.id} className={category === catalog.id ? 'active' : ''} aria-pressed={category === catalog.id} onClick={() => setCategory(catalog.id)}>{catalog.title}</button>)}
          </div>
          <label className="search-box"><Icon name="search" size={18}/><input type="search" aria-label="Buscar productos" placeholder="Producto, presentación o sabor" value={query} onChange={event => setQuery(event.target.value)}/></label>
        </div>
        {activeCatalog && <article className="active-catalog">
          {activeCatalog.image && <ImageByUrl src={activeCatalog.image} alt={activeCatalog.title}/>}
          <div><h3>{activeCatalog.title}</h3>{activeCatalog.description && <p>{activeCatalog.description}</p>}<a href={`/catalogos/${activeCatalog.slug}`} className="text-link">Ver este catálogo <Icon name="arrow" size={16}/></a></div>
        </article>}
        <div className={`products-grid${shown.length >= 2 && shown.length <= 4 ? ' curated-grid' : ''}`}>
          {shown.map(product => <article className="product-card" key={product.id}>
            <a href={`/productos/${product.slug}`} className="product-photo">
              <span className={`product-badge ${product.availability === 'soldout' ? 'unavailable' : ''}`}>{availabilityLabel(product)}</span>
              {product.image ? <ImageByUrl src={product.image} alt={product.title} loading="lazy"/> : <Icon name="box" size={80}/>}
              <span className="photo-arrow"><span>Ver detalle</span><Icon name="arrow" size={17}/></span>
            </a>
            <div className="product-content">
              <span className="eyebrow">{catalogs.find(catalog => product.catalogIds.includes(catalog.id))?.title || 'ALL NUTRITION'}</span>
              <h3><a href={`/productos/${product.slug}`}>{product.title}</a></h3>
              <p>{[product.presentation, product.flavor].filter(Boolean).join(' · ')}</p>
              <div className="product-purchase"><span className="price-label">Precio por unidad</span><div className="price-row"><strong>{money(product.price)}</strong><small>COP</small></div></div>
              <PurchaseAction record={product} settings={s} cart={cart}/>
              {product.availability !== 'soldout' && <a className="text-link product-inquiry" href={wa(product)} target="_blank" rel="noopener noreferrer"><Icon name="chat" size={15}/>Preguntar por este producto</a>}
            </div>
          </article>)}
          {shown.length === 0 && <div className="empty-card"><Icon name="search" size={32}/><h3>No encontramos ese producto.</h3><p>Busca por nombre, presentación o sabor, o vuelve al catálogo.</p><button className="button subtle" onClick={() => { setQuery(''); setCategory(''); }}>Ver todos los productos <Icon name="arrow" size={17}/></button></div>}
        </div>
        <aside className="catalog-note">
          <div><p className="eyebrow">ELIGE CON INFORMACIÓN</p><h3>¿Quieres comparar opciones?</h3><p>Consulta presentaciones y disponibilidad con nuestro equipo.</p></div>
          <a className="button subtle" href={wa()} target="_blank" rel="noopener noreferrer">Preguntar por WhatsApp <Icon name="chat" size={17}/></a>
        </aside>
      </section>

      {visibleCombos.length > 0 && <section className="section combos-section" id="combos"><div className="wrap">
        <p className="eyebrow">TU SELECCIÓN, EN EQUIPO</p><h2>Combos para tu rutina<span>.</span></h2>
        <div className="combos-grid">{visibleCombos.map(combo => <article className="combo-card" key={combo.id}>
          <a className="combo-photo" href={`/combos/${combo.slug}`}>{combo.image ? <ImageByUrl src={combo.image} alt={combo.title} loading="lazy"/> : <Icon name="box" size={80}/>}</a>
          <div className="combo-content"><h3>{combo.title}</h3><p>{combo.description}</p><strong>{money(combo.price)} <small>COP</small></strong><div className="combo-actions"><PurchaseAction record={combo} settings={s} cart={cart} kind="combos" className="button primary"/><a className="text-link" href={`/combos/${combo.slug}`}>Ver qué incluye <Icon name="arrow" size={17}/></a></div></div>
        </article>)}</div>
      </div></section>}

      <section className="section wrap how-to" id="como-comprar">
        <div className="how-to-heading"><div><p className="eyebrow">COMPRA SIN RODEOS</p><h2>Elige aquí.<br/>Confirma por WhatsApp<span>.</span></h2></div><p>Reúne tus productos en un solo pedido. Hablamos contigo para cerrar los detalles.</p></div>
        <div className="steps">{[
          ['01', 'Elige tus productos', 'Revisa la presentación, el sabor y el precio de cada referencia.'],
          ['02', 'Ajusta tu pedido', 'Añade las unidades que necesitas y revisa el subtotal.'],
          ['03', 'Confirma por WhatsApp', 'Abre el mensaje con tu selección. El equipo te confirma disponibilidad, pago y envío.']
        ].map(([number, title, body]) => <div className="step" key={number}><span>{number}</span><div><h3>{title}</h3><p>{body}</p></div></div>)}</div>
      </section>
      {(shipping.length > 0 || s.paymentInfo) && <section className="section info-section"><div className="wrap">
        <div className="info-heading"><p className="eyebrow">ANTES DE CONFIRMAR</p><h2>Pago y envío.<br/>Hablemos claro<span>.</span></h2></div>
        <div className="info-grid">
          {s.paymentInfo && <article><Icon name="check"/><h3>Opciones de pago</h3><p>{s.paymentInfo}</p><small>Confirma las condiciones de tu pedido con el equipo.</small></article>}
          {shipping.map(zone => <article key={zone.id}><Icon name="truck"/><h3>{zone.title}</h3>{[zone.zone, zone.costText, zone.estimatedTime, zone.cashOnDelivery, zone.details].filter(Boolean).map((line, index) => <p key={index}>{line}</p>)}</article>)}
        </div>
      </div></section>}
      {messages.some(message => message.placement === 'feature') && <section className="section wrap feature-grid">
        {messages.filter(message => message.placement === 'feature').map(message => <article key={message.id}><h3>{message.title}</h3><p>{message.body}</p>{message.buttonText && <a className="text-link" href={wa()} target="_blank" rel="noopener noreferrer">{message.buttonText} <Icon name="arrow"/></a>}</article>)}
      </section>}
      {faqs.length > 0 && <section className="section wrap faq-section">
        <div><p className="eyebrow">RESPUESTAS PARA ELEGIR</p><h2>Resuelve tus dudas<span>.</span></h2></div>
        <div>{faqs.map(faq => <details key={faq.id}><summary>{faq.title}<span>+</span></summary><p>{faq.answer}</p></details>)}</div>
      </section>}
      <section className="closing wrap"><div className="closing-copy"><p className="eyebrow">CADA RUTINA TIENE SU ESTILO</p><h2>Tu entreno.<br/>Tu elección<span>.</span></h2><p>Elige tus suplementos y lleva tu selección a WhatsApp.</p></div><div className="closing-actions">{cart.count > 0 ? <button className="button primary" onClick={openCart}>Revisar mi pedido <Icon name="arrow"/></button> : <a className="button primary" href="#catalogo">Elegir mis productos <Icon name="arrow"/></a>}<a className="text-link" href={wa()} target="_blank" rel="noopener noreferrer">Necesito ayuda para elegir <Icon name="chat" size={16}/></a></div></section>
    </main>
    <footer className="site-footer wrap">
      <div className="footer-brand"><strong>{s.brandName}</strong><p>{s.tagline}</p></div>
      <div><span className="eyebrow">CONTACTO</span><a href={wa()} target="_blank" rel="noopener noreferrer">WhatsApp · +{s.whatsapp}</a>{s.email && <a href={`mailto:${s.email}`}>{s.email}</a>}{s.hours && <span>{s.hours}</span>}</div>
      {social.length > 0 && <div><span className="eyebrow">SÍGUENOS</span>{social.map(item => <a key={item.label} href={item.href} target="_blank" rel="noopener noreferrer">{item.label} <Icon name="external" size={13}/></a>)}</div>}
      <div className="footer-bottom"><span>{s.brandName}</span><span>Tu elección en la vitrina. Tu atención en WhatsApp.</span></div>
    </footer>
    <a className="floating-whatsapp" aria-label="Consultar por WhatsApp" href={wa()} target="_blank" rel="noopener noreferrer"><Icon name="chat" size={24}/></a>
    {cart.notice && <div className="cart-status" role="status"><Icon name="check" size={18}/><span>{cart.notice}</span><button type="button" onClick={openCart}>Ver mi pedido <Icon name="arrow" size={15}/></button></div>}
    <StorefrontCart cart={cart} settings={s} dialogRef={cartDialog}/>
  </div>;
}
