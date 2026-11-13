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
  authMethod: value.authMethod || 'api-key', projectId: value.projectId || '',
  allowPrivateNetwork: value.allowPrivateNetwork,
});

export default function AssistantSettings({ api, assistantBusy = false, onInteractionStateChange = () => {} }) {
  const [settings, setSettings] = useState(null), [form, setForm] = useState(null);
  const [apiKey, setApiKey] = useState(''), [clearApiKey, setClearApiKey] = useState(false);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [oauthConfigured, setOAuthConfigured] = useState(null), [notice, setNotice] = useState('');
  const [operation, setOperation] = useState('');
  const baseline = useRef(null);
  const acceptSettings = useCallback(current => {
    const nextForm = formFrom(current);
    baseline.current = JSON.stringify({ form: nextForm, apiKey: '', clearApiKey: false });
    setSettings(current); setForm(nextForm); setApiKey(''); setClearApiKey(false);
  }, []);
  const load = useCallback(async () => {
    setLoading(true); setError(''); setNotice(''); setOAuthConfigured(null);
    try {
      const [current, oauth] = await Promise.all([
        api('/api/admin/assistant/settings'),
        api('/api/admin/assistant/oauth').catch(() => null),
      ]);
      acceptSettings(validateAssistantSettings(current));
      setOAuthConfigured(typeof oauth?.configured === 'boolean' ? oauth.configured : null);
    } catch (cause) { setError(cause.message || 'No se pudo cargar la configuración de Ali.'); }
    finally { setLoading(false); }
  }, [api, acceptSettings]);
  useEffect(() => { void load(); }, [load]);
  const dirty = Boolean(form && baseline.current !== JSON.stringify({ form, apiKey, clearApiKey }));
  useEffect(() => { onInteractionStateChange({ busy:saving, dirty }); }, [onInteractionStateChange,saving,dirty]);
  useEffect(() => () => onInteractionStateChange({ busy:false, dirty:false }), [onInteractionStateChange]);

  const usesOAuth = form?.provider === 'gemini' && form?.authMethod === 'oauth';
  const nextBaseUrl = form?.provider === 'openai-compatible' ? form.baseUrl.trim() || null : null;
  const destinationChanged = Boolean(settings && (settings.provider !== (form?.provider || null) || settings.baseUrl !== nextBaseUrl));
  const keyRequired = Boolean(settings && !usesOAuth && !clearApiKey && (destinationChanged || settings.authMethod === 'oauth' || form?.enabled && !settings.hasApiKey));
  const pendingKeyChange = Boolean(apiKey || clearApiKey);

  async function submit(event) {
    event.preventDefault();
    if (!settings || !form || saving || assistantBusy || loading || usesOAuth && (pendingKeyChange || !settings.hasOAuthConnection)) return;
    setSaving(true); setOperation('save'); setError(''); setNotice('');
    try {
      const updated = validateAssistantSettings(await api('/api/admin/assistant/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...form, provider: form.provider || null, baseUrl: nextBaseUrl, version: settings.version,
          requestId: requestId(), apiKey: usesOAuth ? '' : clearApiKey ? '' : apiKey, clearApiKey: !usesOAuth && clearApiKey,
          projectId: usesOAuth ? form.projectId.trim() : null,
          enabled: !usesOAuth && clearApiKey ? false : form.enabled,
        }),
      }));
      acceptSettings(updated);
    } catch (cause) { setError(cause.message || 'No se pudo guardar la configuración de Ali.'); }
    finally { setSaving(false); setOperation(''); }
  }

  async function connectGoogle() {
    if (!settings || !usesOAuth || loading || saving || assistantBusy || pendingKeyChange || !oauthConfigured) return;
    if (!form.model.trim() || !form.projectId.trim()) {
      setError('Indica el modelo Gemini y el proyecto de Google Cloud antes de conectar.'); return;
    }
    if (dirty && !window.confirm('La conexión usará el modelo y proyecto indicados. Los demás cambios sin guardar no se conservarán al salir. ¿Continuar?')) return;
    setSaving(true); setOperation('connect'); setError(''); setNotice('');
    try {
      const result = await api('/api/admin/assistant/oauth/start', {
        method: 'POST',
        body: JSON.stringify({ version: settings.version, provider: 'gemini', model: form.model.trim(), projectId: form.projectId.trim() }),
      });
      const target = new URL(result.authorizationUrl);
      if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth') throw new Error('No se recibió una URL oficial de autorización de Google.');
      window.location.assign(target.href);
    } catch (cause) {
      setError(cause.message || 'No se pudo iniciar la conexión con Google.');
      setSaving(false); setOperation('');
    }
  }

  async function disconnectGoogle() {
    if (!settings?.hasOAuthConnection || loading || saving || assistantBusy || dirty) return;
    if (!window.confirm('¿Desconectar Google? Se eliminará la conexión local y Ali se deshabilitará si usa OAuth.')) return;
    setSaving(true); setOperation('disconnect'); setError(''); setNotice('');
    try {
      const result = await api('/api/admin/assistant/oauth', { method: 'DELETE', body: JSON.stringify({ version: settings.version }) });
      acceptSettings(validateAssistantSettings(result.settings));
      setNotice(result.revoked
        ? 'Conexión de Google eliminada localmente y autorización remota revocada.'
        : 'Conexión de Google eliminada localmente. No se pudo confirmar la revocación remota; revisa el acceso de la aplicación en tu cuenta de Google.');
    } catch (cause) { setError(cause.message || 'No se pudo desconectar Google.'); }
    finally { setSaving(false); setOperation(''); }
  }

  const locked = loading || saving || assistantBusy;
  return <section className="settings-card" aria-labelledby="assistant-settings-title" aria-busy={locked}>
    <div className="settings-card-heading"><div><h2 id="assistant-settings-title">Ali · asistente conversacional</h2><p>Configura un proveedor compatible con llamadas de función. Habilitar Ali verifica la conexión antes de guardar.</p></div></div>
    <p>Ali consulta datos autorizados y ayuda con los formularios. Puede guardar textos descriptivos en borradores existentes si se lo pides explícitamente; los demás cambios comerciales requieren revisión y confirmación. Cada guardado genera un comprobante.</p>
    <p className="hint">El mensaje, la memoria y los campos asistibles pueden enviarse al proveedor configurado. Evita incluir datos sensibles innecesarios. Verificar la conexión puede consumir una solicitud del proveedor. Las credenciales se cifran con la custodia local del servidor; no se devuelven a esta pantalla ni forman parte del prompt.</p>
    {loading && <p role="status">Cargando configuración…</p>}
    {assistantBusy && <p role="status">Espera a que termine el guardado en curso antes de cambiar la configuración o eliminar la clave.</p>}
    {error && <div className="error" role="alert"><span>{error}</span><button type="button" className="text-button" disabled={locked} onClick={() => { if(settings&&dirty&&!window.confirm('Descartar los cambios y volver a cargar la configuración?'))return; void load(); }}>{settings?(dirty?'Descartar cambios y recargar':'Recargar configuración'):'Reintentar'}</button></div>}
    {notice && <p role="status">{notice}</p>}
    {settings && form && <>
      <dl className="summary-values"><div><dt>Estado</dt><dd>{settings.enabled ? 'Habilitado' : 'Deshabilitado'} · {statusLabels[settings.connectionStatus] || settings.connectionStatus}</dd></div><div><dt>Clave</dt><dd>{settings.hasApiKey ? 'Guardada; no se muestra' : 'No guardada'}</dd></div><div><dt>Cuenta de Google</dt><dd>{settings.hasOAuthConnection ? 'Conectada; credenciales protegidas' : 'Sin conexión OAuth'}</dd></div>{settings.verifiedAt&&<div><dt>Verificada</dt><dd><time dateTime={settings.verifiedAt}>{new Date(settings.verifiedAt).toLocaleString('es')}</time></dd></div>}</dl>
      <form method="post" onSubmit={submit}>
        <fieldset className="editor-fieldset" disabled={locked}>
          <div className="product-form-grid">
            <label className="field">Proveedor<select name="provider" value={form.provider} onChange={event=>setForm(current=>({...current,provider:event.target.value,authMethod:event.target.value==='gemini'?current.authMethod:'api-key',baseUrl:event.target.value==='openai-compatible'?current.baseUrl:'',allowPrivateNetwork:event.target.value==='openai-compatible'?current.allowPrivateNetwork:false}))}>
              <option value="" disabled={(settings.hasApiKey&&!clearApiKey)||settings.hasOAuthConnection}>Sin proveedor</option><option value="openai">OpenAI</option><option value="openai-compatible">OpenAI compatible</option><option value="gemini">Google Gemini</option>
            </select><small className="field-description">Con APIKey, cambiar de proveedor o URL requiere una clave nueva. OAuth solo está disponible para Google Gemini.</small></label>
            <label className="field">Método de autenticación<select name="authMethod" value={form.authMethod} disabled={pendingKeyChange} onChange={event=>setForm(current=>({...current,authMethod:event.target.value}))}>
              <option value="api-key">Clave API (APIKey)</option><option value="oauth" disabled={form.provider!=='gemini'}>Cuenta de Google (OAuth · solo Gemini)</option>
            </select><small className="field-description">{pendingKeyChange?'Guarda o descarta los cambios de la clave antes de cambiar el método.':'En Ali, OpenAI y los proveedores compatibles se conectan con APIKey. No se ofrece OAuth web de OpenAI sin autorización comercial ni inicio de sesión de Anthropic.'}</small></label>
            {form.provider==='openai'&&<p className="field-description">Endpoint fijo: https://api.openai.com/v1</p>}
            {form.provider==='gemini'&&<p className="field-description">Endpoint fijo de Gemini: https://generativelanguage.googleapis.com/v1beta · API nativa de Google.</p>}
            {form.provider==='openai-compatible'&&<label className="field">URL raíz de API<input name="baseUrl" type="url" inputMode="url" autoComplete="url" maxLength={2048} value={form.baseUrl} required={form.enabled} placeholder="https://proveedor.example/v1" onChange={event=>setForm(current=>({...current,baseUrl:event.target.value}))}/><small className="field-description">Usa HTTPS y la raíz de la API; no incluyas credenciales, parámetros ni /chat/completions. HTTP solo para loopback y con permiso explícito.</small></label>}
            <label className="field">Modelo<input name="model" type="text" autoComplete="off" maxLength={form.provider==='gemini'?128:200} value={form.model} required={form.enabled||usesOAuth} onChange={event=>setForm(current=>({...current,model:event.target.value}))}/><small className="field-description">Debe admitir llamadas de función; el servidor lo verifica antes de habilitar.</small></label>
            {!usesOAuth&&<label className="field">Clave API<input name="apiKey" type="password" autoComplete="new-password" maxLength={4096} value={apiKey} required={keyRequired} placeholder={settings.hasApiKey&&!destinationChanged?'Clave guardada; deja vacío para conservarla':'Pega una clave nueva'} onChange={event=>{setApiKey(event.target.value);if(event.target.value)setClearApiKey(false);}}/><small className="field-description">Solo se envía al servidor al guardar. Nunca se muestra después de guardarla.{settings.authMethod==='oauth'?' Cambiar a APIKey requiere una clave nueva; la conexión OAuth se elimina solo si el guardado se completa.':''}</small></label>}
            {usesOAuth&&<label className="field">Proyecto de Google Cloud<input name="projectId" type="text" autoComplete="off" maxLength={30} required value={form.projectId} onChange={event=>setForm(current=>({...current,projectId:event.target.value}))}/><small className="field-description">ID del proyecto (6–30 caracteres) o número de proyecto con la API de Gemini habilitada, cuota, permisos y facturación correspondientes. No es el nombre de tu cuenta de Google.</small></label>}
          </div>
          {usesOAuth&&<div>
            <p className="hint">{oauthConfigured===true?'La aplicación OAuth de Google está configurada en el servidor.':oauthConfigured===false?'OAuth de Google no está configurado en el servidor. Un administrador debe configurar la aplicación antes de conectar.':'No se pudo consultar la configuración OAuth de Google. Recarga la configuración para reintentar.'}</p>
            <p className="hint">Conectar Google no garantiza acceso por una suscripción de consumo a Gemini ni incluye su cuota. El servidor prueba el modelo y el proyecto antes de habilitar Ali. La conexión utiliza el modelo y proyecto actuales y no envía ninguna clave API a Google.</p>
            <div className="admin-actions">
              <button type="button" className="button" disabled={locked||oauthConfigured!==true||pendingKeyChange||!form.model.trim()||!form.projectId.trim()} onClick={connectGoogle}>{operation==='connect'?'Abriendo Google…':settings.hasOAuthConnection?'Volver a conectar cuenta de Google':'Conectar cuenta de Google'}</button>
              {settings.hasOAuthConnection&&<button type="button" className="button" disabled={locked||dirty} onClick={disconnectGoogle}>{operation==='disconnect'?'Desconectando…':'Desconectar cuenta de Google'}</button>}
            </div>
            {settings.hasOAuthConnection&&dirty&&<p className="hint">Guarda o descarta los cambios antes de desconectar Google.</p>}
            {!settings.hasOAuthConnection&&<p className="hint">Conecta una cuenta de Google antes de guardar ajustes OAuth. Una APIKey activa se conserva si se rechaza o falla la conexión.</p>}
          </div>}
          <label className="checkbox-field"><input name="enabled" type="checkbox" checked={form.enabled&&!clearApiKey} onChange={event=>setForm(current=>({...current,enabled:event.target.checked}))}/>Habilitar Ali y verificar la conexión al guardar</label>
          {form.provider==='openai-compatible'&&<label className="checkbox-field"><input name="allowPrivateNetwork" type="checkbox" checked={form.allowPrivateNetwork} onChange={event=>setForm(current=>({...current,allowPrivateNetwork:event.target.checked}))}/>Permitir destinos de red privada explícitamente</label>}
          {!usesOAuth&&settings.authMethod!=='oauth'&&settings.hasApiKey&&<label className="checkbox-field"><input name="clearApiKey" type="checkbox" checked={clearApiKey} onChange={event=>{setClearApiKey(event.target.checked);if(event.target.checked)setApiKey('');}}/>Eliminar la clave guardada y deshabilitar Ali</label>}
          <p className="hint">{usesOAuth?'Deshabilitar no desconecta Google. Usa «Desconectar cuenta de Google» para eliminar la conexión local.':'Deshabilitar no elimina la clave. Para cambiar de proveedor o URL, guarda una clave nueva; para borrar la custodia, usa «Eliminar la clave guardada».'}</p>
          <div className="settings-save-bar"><span role="status">{saving?(operation==='connect'?'Abriendo autorización de Google…':operation==='disconnect'?'Eliminando conexión de Google…':'Guardando y verificando…'):settings.connectionStatus==='ready'?'Conexión verificada':settings.hasOAuthConnection?'Conexión de Google protegida':settings.hasApiKey?'Clave protegida':'Ali sin configurar'}</span>
            {dirty&&<button type="button" className="text-button" disabled={locked} onClick={()=>{if(window.confirm('¿Descartar los cambios sin guardar?')){acceptSettings(settings);setError('');setNotice('');}}}>Descartar cambios</button>}
            <button type="submit" className="button primary" disabled={locked||(usesOAuth&&(!settings.hasOAuthConnection||pendingKeyChange))||(!form.provider&&Boolean(apiKey))||(!form.provider&&settings.hasApiKey&&!clearApiKey)}>{saving&&operation==='save'?'Verificando…':form.enabled&&!clearApiKey?'Guardar y verificar':'Guardar configuración'}</button>
          </div>
        </fieldset>
      </form>
    </>}
  </section>;
}
