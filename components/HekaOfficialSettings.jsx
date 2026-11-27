'use client';

import { useEffect, useRef, useState } from 'react';
import { HEKA_ROOT, HekaAlert, HekaConfirmation, HekaEnvironment, hekaEnvironment, hekaOperation, useHekaInteraction, useHekaRequest } from './HekaPanel';

const WEBHOOK_SETTINGS = `${HEKA_ROOT}/webhook`;

export default function HekaOfficialSettings({ api, onNavigate, onInteractionStateChange }) {
  const [saved, setSaved] = useState(null), [environment, setEnvironment] = useState('test'), [hasKeyInput, setHasKeyInput] = useState(false);
  const [notice, setNotice] = useState(''), [confirmation, setConfirmation] = useState('');
  const key = useRef(null), form = useRef(null);
  const secret = useRef(null);
  const [webhook,setWebhook] = useState(null), [hasSecret,setHasSecret] = useState(false);
  const { busy, error, setError, run } = useHekaRequest(api);
  const dirty = hasKeyInput || Boolean(saved && environment !== saved.environment);
  useHekaInteraction(onInteractionStateChange, dirty || hasSecret, busy);

  function apply(settings) {
    setSaved(settings);
    setEnvironment(settings.environment);
  }
  function read() {
    void run(async request => {
      const [settings,webhookSettings]=await Promise.all([request(HEKA_ROOT),request(WEBHOOK_SETTINGS)]);
      apply(settings); setWebhook(webhookSettings);
    });
  }
  useEffect(read, [api]);

  function save(event) {
    event.preventDefault();
    if (!dirty) return;
    if (environment === 'production') {
      setError(''); setConfirmation('production');
    } else write();
  }
  function write() {
    void run(async request => {
      const apiKey = key.current.value.trim();
      key.current.value = '';
      setHasKeyInput(false); setNotice(''); setConfirmation('');
      const result = await request(HEKA_ROOT, { method: 'PUT', body: JSON.stringify({ environment, version: saved.version, ...(apiKey ? { apiKey } : {}) }) });
      apply(result);
      setWebhook({environment:result.environment,generation:result.version,revision:null,connected:result.configured});
      setNotice('Clave guardada en el servidor. Comprueba la conexión para verificar el acceso.');
    });
  }
  function check() {
    void run(async request => {
      await hekaOperation(request, saved, 'check', {});
      setNotice(`Heka respondió en ${hekaEnvironment(saved.environment)} y permitió consultar bodegas. Esta comprobación no verifica permisos de escritura ni el rol seller.`);
    });
  }
  function disconnect() {
    void run(async request => {
      apply(await request(HEKA_ROOT, { method: 'DELETE', body: JSON.stringify({ version: saved.version }) }));
      setWebhook(null);
      setConfirmation(''); setNotice('Clave retirada de este panel. No se revocó en Heka.');
    });
  }
  function discard() {
    form.current.reset(); setEnvironment(saved.environment); setHasKeyInput(false); setError(''); setNotice('');
  }
  function writeWebhook(event,clear=false) {
    event?.preventDefault();
    void run(async request => {
      const value = clear ? null : secret.current.value.trim();
      if(secret.current)secret.current.value='';
      setHasSecret(false); setNotice('');
      const {environment,generation,revision}=webhook;
      const result=await request(WEBHOOK_SETTINGS,{method:clear?'DELETE':'PUT',body:JSON.stringify({environment,generation,revision,...(!clear?{secret:value}:{})})});
      setWebhook(result); setConfirmation('');
      setNotice(clear?'Secreto retirado del receptor. El sondeo sigue activo.':'Secreto guardado. No se modificó el destino en Heka ni se interrumpió el sondeo.');
    });
  }


  return <section className="settings-card" aria-label="Conexión oficial de Heka">
    <h3>Heka · API oficial</h3>
    <p>Genera una llave API desde tu cuenta Heka para configurar la conexión. Los despachos diarios no requieren abrir el portal, usar Electron ni compartir tu contraseña. La llave solo se envía al servidor al guardar y no vuelve a mostrarse.</p>
    <p><a href="https://new.hekaentrega.co/api/docs" target="_blank" rel="noreferrer" data-advisor-control="heka-official-documentation-link">Documentación oficial de Heka</a></p>
    {!saved && (busy ? <p role="status">Consultando configuración Heka…</p> : <button type="button" className="button subtle" onClick={read}>Consultar configuración Heka</button>)}
    {!confirmation && <HekaAlert error={error}/>}
    {notice && <p role="status">{notice}</p>}
    {saved && <>
      <section aria-label="Estado guardado de Heka oficial" tabIndex={-1} data-advisor-control="heka-official-connection-status">
        <HekaEnvironment environment={saved.environment}/>
        <p>{saved.configured ? 'Hay una llave guardada. El acceso depende de las autorizaciones de la cuenta en Heka.' : 'No hay una llave guardada. Las operaciones oficiales están deshabilitadas.'} Para gestionar novedades, usa una llave vinculada a una cuenta seller.</p>
      </section>
      <form ref={form} aria-label="Configurar API oficial de Heka" onSubmit={save} autoComplete="off">
        <fieldset className="editor-fieldset" disabled={busy}>
          <div className="product-form-grid">
            <label className="field">Entorno<select data-advisor-control="heka-official-environment" value={environment} onChange={event => setEnvironment(event.target.value)}><option value="test">Pruebas</option><option value="production">Producción</option></select></label>
            <label className="field">Llave API de Heka<input ref={key} type="password" data-advisor-control={environment==='test'?'heka-official-test-key-form':'heka-official-production-confirmation'} autoComplete="new-password" required={!saved.configured || saved.environment !== environment} maxLength={4096} onInput={event => setHasKeyInput(Boolean(event.target.value.trim()))}/></label>
          </div>
          {saved.configured && saved.environment === environment && <p className="hint">Deja la llave en blanco para conservar la guardada. Para reemplazarla, genera otra en Heka y guárdala aquí.</p>}
          {saved.environment !== environment && <p className="hint">Cambiar de entorno requiere una llave para el nuevo entorno. No se reutilizará la llave anterior.</p>}
          <div className="admin-actions">
            <button type="submit" className="button primary" disabled={!dirty}>Guardar conexión Heka</button>
            {dirty && <button type="button" className="button subtle" onClick={discard}>Descartar cambios</button>}
            {saved.configured && <>
              <button type="button" className="button subtle" data-advisor-control="heka-official-check-access" disabled={dirty} onClick={check}>Comprobar acceso</button>
              <button type="button" className="button subtle" data-advisor-control="heka-official-withdraw-key" disabled={dirty} onClick={() => { setError(''); setConfirmation('disconnect'); }}>Retirar llave del panel</button>
              <button type="button" className="button subtle" disabled={dirty} onClick={() => onNavigate({ section: 'orders', tab: 'heka', panel: 'journal' })}>Abrir Centro de envíos</button>
            </>}
          </div>
        </fieldset>
      </form>
      <section aria-label="Webhook de Heka">
        <h4>Webhook de Heka</h4>
        <p>{webhook?.revision ? 'Secreto guardado en el servidor.' : 'Webhook inactivo: no hay secreto de firma configurado.'} El sondeo de novedades sigue activo con la API oficial conectada.</p>
        <p className="hint">Guardar el secreto o enviar una prueba no cambia la frecuencia. La bandeja indica la conciliación diaria solo después de verificar un evento real de guía.</p>
        {webhook?.connected ? <>
          <p className="hint">Pega el secreto vigente de {hekaEnvironment(webhook.environment)} solo con autorización de All Nutrition. Guardarlo no rota el secreto ni cambia la URL en Heka.</p>
          <p>Ruta de este entorno: <code>/api/shipping/heka/webhook/{webhook.environment}</code></p>
          <form aria-label="Configurar webhook de Heka" autoComplete="off" onSubmit={writeWebhook}>
            <fieldset className="editor-fieldset" disabled={busy || dirty}>
              <label className="field">Secreto de firma de Heka<input ref={secret} type="password" autoComplete="new-password" required maxLength={255} onInput={event=>setHasSecret(Boolean(event.target.value.trim()))}/></label>
              <div className="admin-actions">
                <button type="submit" className="button primary" disabled={!hasSecret}>Guardar secreto del webhook</button>
                {hasSecret && <button type="button" className="button subtle" onClick={()=>{secret.current.value='';setHasSecret(false);setError('');}}>Descartar secreto</button>}
                {webhook.revision && <button type="button" className="button subtle" disabled={hasSecret} onClick={()=>{setError('');setConfirmation('webhook');}}>Retirar secreto del webhook</button>}
              </div>
            </fieldset>
          </form>
        </> : <p>Configura la conexión oficial antes de guardar el secreto.</p>}
      </section>
      {busy && !confirmation && <p role="status">Procesando configuración Heka…</p>}
    </>}
    {confirmation === 'production' && <HekaConfirmation title="Conectar Heka en producción" action="Guardar en producción" acknowledgement="Confirmo que esta llave corresponde a la cuenta real de Heka." busy={busy} error={error} onClose={() => { setConfirmation(''); setError(''); }} onConfirm={write}><p>Al operar en este entorno, emitir una guía o enviar una solución puede afectar envíos reales.</p></HekaConfirmation>}
    {confirmation === 'disconnect' && <HekaConfirmation title="Retirar la llave de Heka" action="Retirar llave del panel" busy={busy} error={error} onClose={() => { setConfirmation(''); setError(''); }} onConfirm={disconnect}><p>Las operaciones de la API oficial quedarán deshabilitadas en el panel. Esto no revoca la llave en Heka ni modifica las conexiones de Heka clásico.</p></HekaConfirmation>}
    {confirmation === 'webhook' && <HekaConfirmation title="Retirar el secreto del webhook de Heka" action="Retirar secreto" busy={busy} error={error} onClose={()=>{setConfirmation('');setError('');}} onConfirm={()=>writeWebhook(null,true)}><p>Se deshabilitará el receptor de este panel. El sondeo sigue activo y no se cambia la URL en Heka.</p></HekaConfirmation>}
  </section>;
}
