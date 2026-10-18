'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Field } from './Fields';
import BusinessActionDialog from './BusinessActionDialog';
import { bogotaDate } from '@/lib/business/dates.mjs';
import { formatMoneyMinor } from '@/lib/business/money.mjs';
import styles from './BusinessOnboarding.module.css';

const ENDPOINT = '/api/admin/business/onboarding';
const STEPS = ['Caja', 'Producto', 'Pedidos', 'Prueba y listo'];
const noop = () => {};
const idle = { busy: false, dirty: false };
const saleLabels = { confirmed: 'Al confirmar el pedido', dispatched: 'Al recoger el envío', delivered: 'Al completar la entrega' };
const earnLabels = { delivered: 'al entregar', customer_paid: 'cuando el cliente paga todo', business_received: 'cuando el negocio recibe todo el bruto' };
function nextStep(readiness) { return !readiness.cash ? 0 : !readiness.product ? 1 : !readiness.orders ? 2 : 3; }
function availableProducts(products) {
  return products.filter(product => (product.productType || 'product') === 'product' && product.orderable && product.status !== 'archived' && product.price > 0 && product.stockQuantity > (product.stockReserved || 0));
}

export default function BusinessOnboarding({ api, onNavigate, onCreateOrder, onInteractionStateChange = noop, onMutation = noop, revision }) {
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [step, setStep] = useState(null), [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [epoch, setEpoch] = useState(0);
  const [formInteraction, setFormInteraction] = useState(idle), [dialogInteraction, setDialogInteraction] = useState(idle), [accountEditor, setAccountEditor] = useState(null);
  const sequence = useRef(0), request = useRef({ key: '', id: '' }), errorRef = useRef(null), headingRef = useRef(null), focusStep = useRef(false);
  const interactionCallback = useRef(onInteractionStateChange); interactionCallback.current = onInteractionStateChange;
  const locked = !!busy || dialogInteraction.busy;
  const dirty = formInteraction.dirty || dialogInteraction.dirty;
  useEffect(() => { interactionCallback.current({ busy: locked, dirty }); }, [locked, dirty]);
  useEffect(() => () => interactionCallback.current(idle), []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const load = useCallback(async () => {
    const seq = ++sequence.current; setLoading(true); setError('');
    try { const result = await api(ENDPOINT); if (seq === sequence.current) setData(result); }
    catch (cause) { if (seq === sequence.current) { setError(cause.message); throw cause; } }
    finally { if (seq === sequence.current) setLoading(false); }
  }, [api]);
  useEffect(() => { void load().catch(noop); return () => { sequence.current++; }; }, [load, revision]);
  const activeStep = step ?? (data ? nextStep(data.readiness) : 0);
  useEffect(() => {
    if (focusStep.current) { headingRef.current?.focus(); focusStep.current = false; }
  }, [activeStep, epoch]);
  function move(next) {
    if (locked || accountEditor || next === activeStep) return;
    if (dirty && !window.confirm('Hay cambios sin guardar. ¿Descartarlos y continuar?')) return;
    setFormInteraction(idle); setError(''); setNotice(''); focusStep.current = true; setStep(next); setEpoch(value => value + 1);
  }
  async function save(action, fields = {}) {
    if (busy) return;
    setBusy(action); setError(''); setNotice('');
    const key = JSON.stringify({ action, ...fields });
    if (request.current.key !== key) request.current = { key, id: crypto.randomUUID() };
    try {
      const result = await api(ENDPOINT, { method: 'POST', body: JSON.stringify({ action, ...fields, requestId: request.current.id }) });
      request.current = { key: '', id: '' };
      sequence.current++; setLoading(false); setData(result); setFormInteraction(idle);
      setNotice(action === 'trial' ? 'Pedido de prueba recibido y guardado.' : action === 'complete' ? 'Puesta en marcha completada y guardada.' : 'Guardado. Puedes continuar o volver más tarde.');
      focusStep.current = true; setStep(action === 'complete' || action === 'trial' ? 3 : nextStep(result.readiness)); setEpoch(value => value + 1);
      if (action !== 'trial') onMutation();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(''); }
  }
  async function accountSaved() {
    setAccountEditor(null); setDialogInteraction(idle); onMutation();
    try { await load(); setNotice('Cuenta guardada.'); }
    catch (cause) { setError('Cuenta guardada; no pudimos actualizar la guía. ' + cause.message); }
  }
  const ready = data?.readiness;
  const finished = ready?.completed;
  return <section className={styles.workspace} data-onboarding aria-label="Puesta en marcha del negocio" aria-busy={!!busy}>
    <header className={styles.intro}><p className="eyebrow">Guía de inicio</p><h2 id="configuration-setup" tabIndex={-1}>{finished ? 'Tu negocio está listo para recibir pedidos' : 'Pon tu negocio en marcha'}</h2><p>Caja, un producto y pedidos: lo imprescindible, paso a paso. Cada etapa se guarda en el servidor para que puedas retomarla después.</p></header>
    {error && <div ref={errorRef} tabIndex={-1} role="alert" className="error" data-onboarding-error><p>{error}</p><button type="button" className="button subtle" disabled={locked || loading} onClick={() => load().catch(noop)}>{data ? 'Actualizar datos guardados' : 'Reintentar carga'}</button></div>}
    <div role="status" aria-live="polite">{busy ? <p>Guardando… No cierres esta pantalla.</p> : loading ? <p>{data ? 'Actualizando datos guardados…' : 'Cargando tus primeros pasos…'}</p> : notice ? <p className={styles.saved}>{notice}</p> : data && <p className={styles.saved}>Mostrando datos guardados. {finished ? 'Configuración completada.' : 'Puedes reanudar esta guía cuando quieras.'}</p>}</div>
    {data && <>
      <ol className={styles.steps} aria-label="Progreso de puesta en marcha">{STEPS.map((label, index) => {
        const done = index === 0 ? ready.cash : index === 1 ? ready.product : index === 2 ? ready.orders : ready.completed;
        return <li key={label}><button type="button" data-onboarding-step={index} aria-current={activeStep === index ? 'step' : undefined} disabled={locked || loading || index > nextStep(ready)} onClick={() => move(index)}><span>{index + 1}. {label}</span><small>{done ? 'Guardado' : index === 3 ? 'Prueba opcional' : 'Pendiente'}</small></button></li>;
      })}</ol>
      <section className={styles.card} aria-labelledby="onboarding-step-heading" data-onboarding-stage={activeStep}>
        <h3 id="onboarding-step-heading" ref={headingRef} tabIndex={-1}>{activeStep + 1}. {STEPS[activeStep]}</h3>
        {activeStep === 0 && <CashStep key={`cash:${epoch}`} data={data} disabled={locked || loading} onSave={save} onContinue={() => move(1)} onEdit={account => setAccountEditor(account)} onInteraction={setFormInteraction}/>}
        {activeStep === 1 && <ProductStep key={`product:${epoch}`} data={data} disabled={locked || loading} onSave={save} onContinue={() => move(2)} onInteraction={setFormInteraction}/>}
        {activeStep === 2 && <OrdersStep key={`orders:${epoch}`} data={data} disabled={locked || loading} onSave={save} onContinue={() => move(3)} onNavigate={onNavigate} onInteraction={setFormInteraction}/>}
        {activeStep === 3 && <>
          {finished ? <><p className={styles.saved}>Caja operativa, producto disponible y reglas de pedidos confirmadas.</p><p>Ya puedes crear un pedido real desde el panel. Su cobro se registra por separado cuando recibas el dinero.</p><button type="button" className="button primary" data-onboarding-new-order disabled={locked || loading} onClick={onCreateOrder}>Nuevo pedido</button></> : <><p>Lo esencial está guardado. Puedes practicar sin riesgo o terminar ahora; la prueba no es un requisito para vender.</p><button type="button" className="button primary" data-onboarding-complete disabled={locked || loading || !ready.cash || !ready.product || !ready.orders} onClick={() => save('complete')}>Finalizar puesta en marcha</button></>}
          <section className={styles.trial} aria-labelledby="onboarding-trial-heading"><h4 id="onboarding-trial-heading">{data.trialOrder ? 'Pedido de prueba recibido' : 'Prueba opcional: recibe un pedido'}</h4><p><strong>Sin cobro real.</strong> No afecta informes, caja ni existencias, ni utiliza la numeración de ventas.</p>{data.trialOrder ? <TrialSummary trial={data.trialOrder}/> : <><p>Usaremos una unidad de tu catálogo con un destinatario ficticio y recogida. La práctica se guarda, pero nunca se convierte en una venta.</p><button type="button" className="button subtle" data-onboarding-trial disabled={locked || loading || !ready.cash || !ready.product || !ready.orders} onClick={() => save('trial')}>Recibir pedido de prueba</button></>}</section>
        </>}
      </section>
      <details className={styles.advanced}><summary>Más opciones, cuando las necesites</summary><p>No necesitas configurar sueldos, bancos, importaciones ni publicar la vitrina para registrar pedidos desde el panel.</p><div className={styles.links}>{[['Personas y sueldos', { section: 'business', tab: 'people' }], ['Caja y bancos', { section: 'business', tab: 'accounts' }], ['Reglas y preferencias', { section: 'business', tab: 'rules' }], ['Importar pedidos', { section: 'orders', tab: 'imports' }], ['Catálogo completo', { section: 'products' }], ['Datos y publicación de la vitrina', { section: 'settings' }]].map(([label, view]) => <button type="button" className="text-button" disabled={locked || loading} key={label} onClick={() => onNavigate(view)}>{label}</button>)}</div><p>La vitrina deriva consultas por WhatsApp; no tiene checkout ni crea pedidos automáticamente. Tú registras y atiendes los pedidos en el panel.</p></details>
    </>}
    {accountEditor && <BusinessActionDialog action="account-save" context={{ account: accountEditor }} api={api} onClose={() => { setAccountEditor(null); setDialogInteraction(idle); }} onSaved={accountSaved} onInteractionStateChange={setDialogInteraction} configuration/>}
  </section>;
}

function useDraft(form, invalid, onInteraction, active = true) {
  const baseline = useRef(JSON.stringify(form)), callback = useRef(onInteraction); callback.current = onInteraction;
  const dirty = active && (JSON.stringify(form) !== baseline.current || invalid);
  useEffect(() => { callback.current({ busy: false, dirty }); }, [dirty]);
  useEffect(() => () => callback.current(idle), []);
  return dirty;
}
function DraftStatus({ dirty }) { return <p className={styles.draft} role="status">{dirty ? 'Cambios sin guardar. Confirma con el botón de esta etapa.' : 'Los cambios se guardan al confirmar esta etapa.'}</p>; }
function CashStep({ data, disabled, onSave, onContinue, onEdit, onInteraction }) {
  const accounts = data.accounts.filter(account => account.active), people = data.people.filter(person => person.active);
  const initialAccount = accounts.find(account => account.id === data.settings.defaultReceiptAccountId) || accounts[0];
  const [form, setForm] = useState(() => ({ accountId: initialAccount?.id || '', responsibleId: initialAccount?.responsibleId || '', responsibleName: data.defaults.responsibleName, accountName: data.defaults.accountName, openingOn: data.defaults.openingOn, openingBalanceMinor: data.defaults.openingBalanceMinor, openingConfirmed: false }));
  const [invalid, setInvalid] = useState(false);
  const dirty = useDraft(form, invalid, onInteraction, !data.readiness.cash);
  const set = (key, value) => setForm(old => ({ ...old, [key]: value }));
  const account = accounts.find(row => row.id === form.accountId) || initialAccount, responsible = people.find(person => person.id === (account ? account.responsibleId : form.responsibleId));
  const accountId = account?.id || null, confirmedAccountId = useRef(accountId);
  const openingConfirmed = form.openingConfirmed && confirmedAccountId.current === accountId;
  useEffect(() => {
    if (confirmedAccountId.current === accountId) return;
    confirmedAccountId.current = accountId;
    setForm(old => ({ ...old, accountId: accountId || '', openingConfirmed: false }));
  }, [accountId]);
  function editAccount() { onEdit(account); }
  if (data.readiness.cash) return <><p className={styles.saved}>Tu caja y las cuentas predeterminadas están guardadas.</p><p><strong>{initialAccount?.name}</strong> · Responsable: {people.find(person => person.id === initialAccount?.responsibleId)?.name || 'Asignado'}.</p><p>La apertura guardada se conserva. No hemos registrado una venta ni un cobro.</p><div className={styles.actions}><button type="button" className="button primary" disabled={disabled} data-onboarding-continue="cash" onClick={onContinue}>Continuar a producto</button>{initialAccount && <button type="button" className="button subtle" disabled={disabled} data-onboarding-edit-account onClick={() => onEdit(initialAccount)}>Editar caja</button>}</div></>;
  return <form onSubmit={event => { event.preventDefault(); if (!disabled && !invalid && openingConfirmed) onSave('prepare', account ? { accountId: account.id, responsibleId: account.responsibleId, openingConfirmed } : { ...form, openingConfirmed, accountId: undefined, responsibleId: form.responsibleId || undefined }); }}>
    <fieldset className={styles.fields} disabled={disabled}>
      {account ? <><p>Usaremos <strong>{account.name}</strong>, con su apertura ya guardada. No se cambia su saldo inicial.</p><p>Responsable: {responsible?.name || 'Falta un responsable activo; edita esta cuenta antes de continuar.'}</p><button type="button" className="button subtle" data-onboarding-edit-account onClick={editAccount}>Editar caja</button></> : <><p>Prepararemos <strong>{form.accountName}</strong> a nombre de <strong>{people.find(person => person.id === form.responsibleId)?.name || form.responsibleName}</strong>. No se crean sueldos ni comisiones.</p><Field field={{ name: 'openingBalanceMinor', label: 'Dinero real con el que abres la caja (COP)', type: 'moneyOptionalMinor', required: true, signed: true, description: 'El cero es editable: confirma cuánto dinero hay realmente. No es una venta ni un cobro.' }} value={form.openingBalanceMinor} onChange={value => set('openingBalanceMinor', value)} onDraftInvalid={setInvalid}/></>}
      <label className="checkbox-field"><input name="openingConfirmed" type="checkbox" required checked={openingConfirmed} onChange={event => set('openingConfirmed', event.target.checked)}/>{account ? 'Confirmo que usaré esta cuenta con su apertura guardada.' : 'Confirmo que este es el saldo real de apertura, incluso si es cero.'}</label>
      <details className={styles.optional}><summary>Cambiar los datos propuestos (opcional)</summary>{accounts.length > 0 && <label className="field">Cuenta que quieres usar<select name="accountId" value={account?.id || ''} onChange={event => { const row = accounts.find(item => item.id === event.target.value); setForm(old => ({ ...old, accountId: event.target.value, responsibleId: row?.responsibleId || '', openingConfirmed: false })); }}>{accounts.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}{!account && <><Field field={{ name: 'accountName', label: 'Nombre de la caja', required: true, max: 150 }} value={form.accountName} onChange={value => set('accountName', value)}/>{people.length > 0 && <label className="field">Responsable<select name="responsibleId" value={form.responsibleId} onChange={event => set('responsibleId', event.target.value)}><option value="">Usar mi nombre de administrador</option>{people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>}{!form.responsibleId && <Field field={{ name: 'responsibleName', label: 'Mi nombre como responsable', required: true, max: 150 }} value={form.responsibleName} onChange={value => set('responsibleName', value)}/>}<Field field={{ name: 'openingOn', label: 'Fecha de apertura (Bogotá)', type: 'date', required: true }} value={form.openingOn} onChange={value => set('openingOn', value)}/></>}</details>
      <DraftStatus dirty={dirty}/><button type="submit" className="button primary" data-onboarding-prepare disabled={invalid || (account && !responsible)}>Guardar caja y continuar</button>
    </fieldset>
  </form>;
}
function ProductStep({ data, disabled, onSave, onContinue, onInteraction }) {
  const [form, setForm] = useState({ title: '', price: '', stockQuantity: '', presentation: '', sku: '', unitCostMinor: null });
  const [invalid, setInvalid] = useState(false), dirty = useDraft(form, invalid, onInteraction, !data.readiness.product);
  const set = (key, value) => setForm(old => ({ ...old, [key]: value }));
  const products = availableProducts(data.products);
  if (data.readiness.product) return <><p className={styles.saved}>Ya tienes un producto disponible para pedidos.</p><ul className={styles.records}>{products.slice(0, 3).map(product => <li key={product.id}><strong>{product.title}</strong><span>{formatMoneyMinor(product.price * 100)} · {product.stockQuantity - (product.stockReserved || 0)} unidades disponibles</span></li>)}</ul><p>No necesitas crear otro ni publicarlo en la vitrina para continuar.</p><button type="button" className="button primary" data-onboarding-continue="product" disabled={disabled} onClick={onContinue}>Continuar a pedidos</button></>;
  return <form onSubmit={event => { event.preventDefault(); if (!disabled && !invalid) onSave('product', { ...form, stockQuantity: Number(form.stockQuantity) }); }}><fieldset className={styles.fields} disabled={disabled}><p>Crea tu primer producto aquí. Quedará disponible para pedidos administrativos, en borrador y sin publicarse en la vitrina.</p><Field field={{ name: 'title', label: 'Nombre del producto', required: true, max: 160 }} value={form.title} onChange={value => set('title', value)}/><div className={styles.grid}><Field field={{ name: 'price', label: 'Precio de venta (COP, pesos enteros)', type: 'money', min: 1, required: true }} value={form.price} onChange={value => set('price', value)}/><label className="field">Unidades reales que tienes<input name="stockQuantity" type="number" inputMode="numeric" min="1" max={Number.MAX_SAFE_INTEGER} step="1" required value={form.stockQuantity} onChange={event => set('stockQuantity', event.target.value)}/></label></div><p className="hint">Cuenta las existencias reales. No se inventa inventario, imagen ni costo.</p><details className={styles.optional}><summary>Presentación, referencia y costo (opcional)</summary><Field field={{ name: 'presentation', label: 'Presentación' }} value={form.presentation} onChange={value => set('presentation', value)}/><Field field={{ name: 'sku', label: 'Referencia / SKU' }} value={form.sku} onChange={value => set('sku', value)}/><Field field={{ name: 'unitCostMinor', label: 'Costo unitario conocido (COP)', type: 'moneyOptionalMinor', description: 'Déjalo vacío si aún no conoces el costo. Vacío no significa cero.' }} value={form.unitCostMinor} onChange={value => set('unitCostMinor', value)} onDraftInvalid={setInvalid}/></details><DraftStatus dirty={dirty}/><button type="submit" className="button primary" data-onboarding-product disabled={invalid}>Guardar producto y continuar</button></fieldset></form>;
}
function OrdersStep({ data, disabled, onSave, onContinue, onNavigate, onInteraction }) {
  const [confirmed, setConfirmed] = useState(false), dirty = useDraft(confirmed, false, onInteraction, !data.readiness.orders);
  const rule = [...data.settings.rulesVersions].reverse().find(row => row.effectiveOn <= bogotaDate());
  return <><p>Registra los pedidos manualmente en el panel, también los que acuerdes por WhatsApp. La vitrina envía consultas por WhatsApp: no tiene checkout ni crea pedidos automáticamente.</p><p>No se activa ninguna pasarela de pago ni servicio logístico, y no hace falta publicar la vitrina para vender desde el panel.</p>{rule ? <div className={styles.policy}><h4>Reglas guardadas vigentes desde {rule.effectiveOn}</h4><p><strong>La venta se reconoce:</strong> {saleLabels[rule.saleRecognition]}.</p><p>{rule.commission.enabled ? `Comisión: ${rule.commission.mode === 'percent' ? `${rule.commission.rateBps / 100} %` : formatMoneyMinor(rule.commission.fixedMinor)} ${earnLabels[rule.commission.earnWhen]}.` : 'Comisiones deshabilitadas.'} No se crean sueldos ni nuevas comisiones al confirmar.</p><details><summary>Ver fechas de gastos y alcance</summary><p>Flete de ida: {rule.shippingExpenseDate === 'charge_date' ? 'fecha del cargo' : 'recogida real'}. Retorno: {rule.returnExpenseDate === 'returned_date' ? 'retorno recibido' : 'fecha del cargo'}. Cargo de plataforma: {rule.platformFeeExpenseDate === 'settlement_date' ? 'primer recibo que paga el cargo' : 'fecha del cargo'}.</p><p>Confirmar conserva estas reglas y la historia existente; no recalcula pedidos anteriores. Los cobros se registran aparte de la venta.</p></details></div> : <p role="alert">No hay reglas vigentes para hoy. Revisa las reglas del negocio antes de confirmar.</p>}{data.readiness.orders ? <><p className={styles.saved}>Reglas revisadas y pedidos listos.</p><button type="button" className="button primary" data-onboarding-continue="orders" disabled={disabled} onClick={onContinue}>Continuar a prueba y listo</button></> : <form onSubmit={event => { event.preventDefault(); if (!disabled && confirmed && rule) onSave('orders', { policyConfirmed: true }); }}><fieldset className={styles.fields} disabled={disabled}><label className="checkbox-field"><input name="policyConfirmed" type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>Revisé las reglas vigentes y entiendo cómo registrar pedidos y cobros en el panel.</label><DraftStatus dirty={dirty}/><button type="submit" className="button primary" data-onboarding-orders disabled={!rule}>Confirmar pedidos y continuar</button></fieldset></form>}<p><button type="button" className="text-button" disabled={disabled} onClick={() => onNavigate({ section: 'business', tab: 'rules' })}>Cambiar reglas y preferencias (opcional)</button></p></>;
}
function TrialSummary({ trial }) {
  return <div data-onboarding-trial-receipt><p className={styles.saved}>Práctica guardada · Estado: recibido</p><p>Destinatario ficticio: {trial.customerName}. Modalidad: recogida.</p><ul className={styles.records}>{trial.items.map(item => <li key={item.lineId}><strong>{item.title}</strong><span>{item.quantity} unidad · importe de práctica: {formatMoneyMinor(item.unitPriceMinor * item.quantity - item.discountMinor)}</span></li>)}</ul><p><strong>Total de práctica: {formatMoneyMinor(trial.totalMinor)}</strong> · No cobrado.</p><p>Este recibo aislado no aparece en ventas ni se puede usar para cobrar. Puedes recargar esta página: la práctica seguirá guardada.</p></div>;
}
