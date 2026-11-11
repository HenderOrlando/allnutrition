'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { validateAssistantSettings } from '../lib/assistant/contracts.mjs';

const statusLabels = {
  unconfigured: 'Sin configurar', unverified: 'Pendiente de verificar', ready: 'Conexión verificada',
  invalid: 'Credencial rechazada', unavailable: 'Proveedor no disponible',
};
const requestId = () => globalThis.crypto?.randomUUID?.() || `assistant-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const formFrom = value => ({
  enabled: value.enabled, provider: value.provider || '', baseUrl: value.baseUrl || '', model: value.model || '',
  allowPrivateNetwork: value.allowPrivateNetwork,
});

export default function AssistantSettings({ api, assistantBusy = false, onInteractionStateChange = () => {} }) {
  const [settings, setSettings] = useState(null), [form, setForm] = useState(null);
  const [apiKey, setApiKey] = useState(''), [clearApiKey, setClearApiKey] = useState(false);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const baseline = useRef(null);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const current = validateAssistantSettings(await api('/api/admin/assistant/settings'));
      const nextForm = formFrom(current);
      baseline.current = JSON.stringify({ form: nextForm, apiKey: '', clearApiKey: false });
      setSettings(current); setForm(nextForm); setApiKey(''); setClearApiKey(false);
    } catch (cause) { setError(cause.message || 'No se pudo cargar la configuración de Ali.'); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);
  const dirty = Boolean(form && baseline.current !== JSON.stringify({ form, apiKey, clearApiKey }));
  useEffect(() => { onInteractionStateChange({ busy:saving, dirty }); }, [onInteractionStateChange,saving,dirty]);
  useEffect(() => () => onInteractionStateChange({ busy:false, dirty:false }), [onInteractionStateChange]);

  const nextBaseUrl = form?.provider === 'openai' || !form?.provider ? null : form?.baseUrl.trim() || null;
  const destinationChanged = Boolean(settings && (settings.provider !== (form?.provider || null) || settings.baseUrl !== nextBaseUrl));
  const keyRequired = Boolean(settings && !clearApiKey && (destinationChanged || form?.enabled && !settings.hasApiKey));

  async function submit(event) {
    event.preventDefault();
    if (!settings || !form || saving || assistantBusy) return;
    setSaving(true); setError('');
    try {
      const updated = validateAssistantSettings(await api('/api/admin/assistant/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...form, provider: form.provider || null, baseUrl: nextBaseUrl, version: settings.version,
          requestId: requestId(), apiKey: clearApiKey ? '' : apiKey, clearApiKey,
          enabled: clearApiKey ? false : form.enabled,
        }),
      }));
      const nextForm = formFrom(updated);
      baseline.current = JSON.stringify({ form: nextForm, apiKey: '', clearApiKey: false });
      setSettings(updated); setForm(nextForm); setApiKey(''); setClearApiKey(false);
    } catch (cause) { setError(cause.message || 'No se pudo guardar la configuración de Ali.'); }
    finally { setSaving(false); }
  }

  const locked = loading || saving || assistantBusy;
  return <section className="settings-card" aria-labelledby="assistant-settings-title" aria-busy={locked}>
    <div className="settings-card-heading"><div><h2 id="assistant-settings-title">Ali · asistente conversacional</h2><p>Configura un proveedor compatible con llamadas de función. Habilitar Ali verifica la conexión antes de guardar.</p></div></div>
    <p>Ali consulta datos autorizados y ayuda con los formularios. Puede guardar textos descriptivos en borradores existentes si se lo pides explícitamente; los demás cambios comerciales requieren revisión y confirmación. Cada guardado genera un comprobante.</p>
    <p className="hint">El mensaje, la memoria y los campos asistibles pueden enviarse al proveedor configurado. Evita incluir datos sensibles innecesarios. Verificar la conexión puede consumir una solicitud del proveedor. La clave se cifra con la custodia local del servidor; no se devuelve a esta pantalla ni forma parte del prompt.</p>
    {loading && <p role="status">Cargando configuración…</p>}
    {assistantBusy && <p role="status">Espera a que termine el guardado en curso antes de cambiar la configuración o eliminar la clave.</p>}
    {error && <div className="error" role="alert"><span>{error}</span><button type="button" className="text-button" disabled={locked} onClick={() => { if(settings&&dirty&&!window.confirm('Descartar los cambios y volver a cargar la configuración?'))return; void load(); }}>{settings?(dirty?'Descartar cambios y recargar':'Recargar configuración'):'Reintentar'}</button></div>}
    {settings && form && <>
      <dl className="summary-values"><div><dt>Estado</dt><dd>{form.enabled ? 'Habilitado' : 'Deshabilitado'} · {statusLabels[settings.connectionStatus] || settings.connectionStatus}</dd></div><div><dt>Clave</dt><dd>{settings.hasApiKey ? 'Guardada; no se muestra' : 'No guardada'}</dd></div>{settings.verifiedAt&&<div><dt>Verificada</dt><dd><time dateTime={settings.verifiedAt}>{new Date(settings.verifiedAt).toLocaleString('es')}</time></dd></div>}</dl>
      <form method="post" onSubmit={submit}>
        <fieldset className="editor-fieldset" disabled={locked}>
          <div className="product-form-grid">
            <label className="field">Proveedor<select name="provider" value={form.provider} onChange={event=>setForm(current=>({...current,provider:event.target.value,baseUrl:event.target.value==='openai'||!event.target.value?'':current.baseUrl,allowPrivateNetwork:event.target.value==='openai'?false:current.allowPrivateNetwork}))}>
              <option value="" disabled={settings.hasApiKey&&!clearApiKey}>Sin proveedor</option><option value="openai">OpenAI</option><option value="openai-compatible">OpenAI compatible</option>
            </select><small className="field-description">El proveedor y la URL forman parte de la clave de destino. Cambiarlos requiere una clave nueva.</small></label>
            {form.provider==='openai'&&<p className="field-description">Endpoint fijo: https://api.openai.com/v1</p>}
            {form.provider==='openai-compatible'&&<label className="field">URL raíz de API<input name="baseUrl" type="url" inputMode="url" autoComplete="url" maxLength={2048} value={form.baseUrl} required={form.enabled} placeholder="https://proveedor.example/v1" onChange={event=>setForm(current=>({...current,baseUrl:event.target.value}))}/><small className="field-description">Usa HTTPS y la raíz de la API; no incluyas credenciales, parámetros ni /chat/completions. HTTP solo para loopback y con permiso explícito.</small></label>}
            <label className="field">Modelo<input name="model" type="text" autoComplete="off" maxLength={200} value={form.model} required={form.enabled} onChange={event=>setForm(current=>({...current,model:event.target.value}))}/><small className="field-description">Debe admitir llamadas de función; el servidor lo verifica al habilitar.</small></label>
            <label className="field">Clave API<input name="apiKey" type="password" autoComplete="new-password" maxLength={4096} value={apiKey} required={keyRequired} placeholder={settings.hasApiKey?'Clave guardada; deja vacío para conservarla':'Pega una clave nueva'} onChange={event=>{setApiKey(event.target.value);if(event.target.value)setClearApiKey(false);}}/><small className="field-description">Solo se envía al servidor al guardar. Nunca se muestra después de guardarla.</small></label>
          </div>
          <label className="checkbox-field"><input name="enabled" type="checkbox" checked={form.enabled&&!clearApiKey} onChange={event=>setForm(current=>({...current,enabled:event.target.checked}))}/>Habilitar Ali y verificar la conexión al guardar</label>
          {form.provider==='openai-compatible'&&<label className="checkbox-field"><input name="allowPrivateNetwork" type="checkbox" checked={form.allowPrivateNetwork} onChange={event=>setForm(current=>({...current,allowPrivateNetwork:event.target.checked}))}/>Permitir destinos de red privada explícitamente</label>}
          {settings.hasApiKey&&<label className="checkbox-field"><input name="clearApiKey" type="checkbox" checked={clearApiKey} onChange={event=>{setClearApiKey(event.target.checked);if(event.target.checked)setApiKey('');}}/>Eliminar la clave guardada y deshabilitar Ali</label>}
          <p className="hint">Deshabilitar no elimina la clave. Para cambiar de proveedor o URL, guarda una clave nueva; para borrar la custodia, usa «Eliminar la clave guardada».</p>
          <div className="settings-save-bar"><span role="status">{saving?'Guardando y verificando…':settings.connectionStatus==='ready'?'Conexión verificada':settings.hasApiKey?'Clave protegida':'Ali sin configurar'}</span><button type="submit" className="button primary" disabled={locked||(!form.provider&&Boolean(apiKey))||(!form.provider&&settings.hasApiKey&&!clearApiKey)}>{saving?'Verificando…':form.enabled&&!clearApiKey?'Guardar y verificar':'Guardar configuración'}</button></div>
        </fieldset>
      </form>
    </>}
  </section>;
}
