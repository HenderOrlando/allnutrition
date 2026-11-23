'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { validateAssistantSettings } from '../lib/assistant/contracts.mjs';

const statusLabels = {
  unconfigured: 'Sin configurar', unverified: 'Pendiente de verificar', ready: 'Conexión verificada',
  invalid: 'Credencial rechazada', unavailable: 'Proveedor no disponible',
};
const providerLabels = { openai: 'OpenAI', 'openai-compatible': 'OpenAI compatible', gemini: 'Google Gemini' };
const saveDisabledControl = 'assistant-provider-disabled-save';
const verifyControl = 'assistant-verify-connection';
const requestId = () => globalThis.crypto?.randomUUID?.() || `assistant-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const formFrom = value => ({
  enabled: value.enabled, provider: value.provider || '', baseUrl: value.baseUrl || '', model: value.model || '',
  authMethod: value.authMethod || 'api-key', projectId: value.projectId || '',
  allowPrivateNetwork: value.allowPrivateNetwork,
});

export default function AssistantSettings({ api, assistantBusy = false, onInteractionStateChange = () => {}, onMutation, onAdvisorDirectory }) {
  const id = useId();
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
  const willVerify = Boolean(form?.enabled && !clearApiKey);

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
          enabled: willVerify,
        }),
      }));
      acceptSettings(updated);
      setNotice(clearApiKey
        ? 'Clave eliminada de la custodia local. Ali está deshabilitado; no se revocó la clave en el proveedor.'
        : updated.enabled
          ? 'Configuración guardada y conexión verificada.'
          : 'Configuración guardada con Ali deshabilitado.');
      onMutation?.();
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
      onMutation?.();
      setNotice(result.revoked
        ? 'Conexión de Google eliminada localmente y autorización remota revocada.'
        : 'Conexión de Google eliminada localmente. No se pudo confirmar la revocación remota; revisa el acceso de la aplicación en tu cuenta de Google.');
    } catch (cause) { setError(cause.message || 'No se pudo desconectar Google.'); }
    finally { setSaving(false); setOperation(''); }
  }

  const locked = loading || saving || assistantBusy;
  return <section className="settings-card" aria-labelledby="assistant-settings-title" aria-busy={locked}>
    <div className="settings-card-heading">
      <div><h2 id="assistant-settings-title">Ali · asistente conversacional</h2><p>Configura un proveedor compatible con llamadas de función. Habilitar Ali verifica la conexión antes de guardar.</p></div>
      {onAdvisorDirectory&&<button type="button" className="button subtle" disabled={locked} onClick={onAdvisorDirectory}>¿Qué quieres hacer?</button>}
    </div>
    <p>Ali consulta datos autorizados y ayuda con los formularios. Puede guardar textos descriptivos en borradores existentes si se lo pides explícitamente; los demás cambios comerciales requieren revisión y confirmación. Cada guardado genera un comprobante.</p>
    <p className="hint">El mensaje, la memoria y los campos asistibles pueden enviarse al proveedor configurado. Evita incluir datos sensibles innecesarios. Verificar la conexión puede consumir una solicitud del proveedor. Las credenciales se cifran con la custodia local del servidor; no se devuelven a esta pantalla ni forman parte del prompt.</p>
    {loading && <p role="status">Cargando configuración…</p>}
    {assistantBusy && <p role="status">Espera a que termine el guardado en curso antes de cambiar la configuración o eliminar la clave.</p>}
    {error && <div className="error" role="alert"><span>{error}</span><button type="button" className="text-button" disabled={locked} onClick={() => { if(settings&&dirty&&!window.confirm('Descartar los cambios y volver a cargar la configuración?'))return; void load(); }}>{settings?(dirty?'Descartar cambios y recargar':'Recargar configuración'):'Reintentar'}</button></div>}
    {notice && <p role="status">{notice}</p>}
    {settings && form && <>
      <h3>Configuración guardada</h3>
      <dl className="summary-values" aria-label="Estado de conexión de Ali" tabIndex={-1} data-advisor-control="assistant-provider-status">
        <div><dt>Proveedor</dt><dd>{providerLabels[settings.provider] || 'Sin configurar'}</dd></div>
        <div><dt>Modelo</dt><dd>{settings.model || 'Sin configurar'}</dd></div>
        <div><dt>Método</dt><dd>{!settings.provider ? 'Sin configurar' : settings.authMethod === 'oauth' ? 'Autorización de Google' : 'Clave API'}</dd></div>
        <div><dt>Estado</dt><dd>{settings.enabled ? 'Habilitado' : 'Deshabilitado'} · {statusLabels[settings.connectionStatus] || settings.connectionStatus}</dd></div>
        <div><dt>Clave</dt><dd>{settings.hasApiKey ? 'Guardada; no se muestra' : 'No guardada'}</dd></div>
        <div><dt>Cuenta de Google</dt><dd>{settings.hasOAuthConnection ? 'Conectada; credenciales protegidas' : 'Sin conexión OAuth'}</dd></div>
        {settings.verifiedAt&&<div><dt>Verificada</dt><dd><time dateTime={settings.verifiedAt}>{new Date(settings.verifiedAt).toLocaleString('es')}</time></dd></div>}
      </dl>
      <form method="post" onSubmit={submit}>
        <fieldset className="editor-fieldset" disabled={locked}>
          <legend>Editar configuración de Ali</legend>
          <div className="product-form-grid">
            <label className="field"><span id={`${id}-provider`}>Proveedor</span><select name="provider" aria-labelledby={`${id}-provider`} aria-describedby={`${id}-provider-hint`} value={form.provider} onChange={event=>{
              const provider = event.currentTarget.value;
              setForm(current=>({...current,provider,authMethod:provider==='gemini'?current.authMethod:'api-key',baseUrl:provider==='openai-compatible'?current.baseUrl:'',allowPrivateNetwork:provider==='openai-compatible'?current.allowPrivateNetwork:false}));
            }}>
              <option value="" disabled={(settings.hasApiKey&&!clearApiKey)||settings.hasOAuthConnection}>Sin proveedor</option><option value="openai">{providerLabels.openai}</option><option value="openai-compatible">{providerLabels['openai-compatible']}</option><option value="gemini">{providerLabels.gemini}</option>
            </select><small id={`${id}-provider-hint`} className="field-description">Con APIKey, cambiar de proveedor o URL requiere una clave nueva. OAuth solo está disponible para Google Gemini.</small></label>
            <label className="field"><span id={`${id}-method`}>Método de autenticación</span><select name="authMethod" aria-labelledby={`${id}-method`} aria-describedby={`${id}-method-hint`} value={form.authMethod} disabled={pendingKeyChange} onChange={event=>{
              const authMethod = event.currentTarget.value;
              setForm(current=>({...current,authMethod}));
            }}>
              <option value="api-key">Clave API</option><option value="oauth" disabled={form.provider!=='gemini'}>Cuenta de Google</option>
            </select><small id={`${id}-method-hint`} className="field-description">{pendingKeyChange?'Guarda o descarta los cambios de la clave antes de cambiar el método.':'En Ali, OpenAI y los proveedores compatibles se conectan con APIKey. No se ofrece OAuth web de OpenAI sin autorización comercial ni inicio de sesión de Anthropic.'}</small></label>
            {form.provider==='openai'&&<p className="field-description">Endpoint fijo: https://api.openai.com/v1</p>}
            {form.provider==='gemini'&&<p className="field-description">Endpoint fijo de Gemini: https://generativelanguage.googleapis.com/v1beta · API nativa de Google.</p>}
            {form.provider==='openai-compatible'&&<label className="field"><span id={`${id}-url`}>URL raíz de API</span><input name="baseUrl" type="url" inputMode="url" autoComplete="url" aria-labelledby={`${id}-url`} aria-describedby={`${id}-url-hint`} maxLength={2048} value={form.baseUrl} required={form.enabled} placeholder="https://proveedor.example/v1" onChange={event=>setForm(current=>({...current,baseUrl:event.target.value}))}/><small id={`${id}-url-hint`} className="field-description">Usa HTTPS y la raíz de la API; no incluyas credenciales, parámetros ni /chat/completions. HTTP solo para loopback y con permiso explícito.</small></label>}
            <label className="field"><span id={`${id}-model`}>Modelo</span><input name="model" type="text" autoComplete="off" aria-labelledby={`${id}-model`} aria-describedby={`${id}-model-hint`} maxLength={form.provider==='gemini'?128:200} value={form.model} required={form.enabled||usesOAuth} onChange={event=>setForm(current=>({...current,model:event.target.value}))}/><small id={`${id}-model-hint`} className="field-description">Debe admitir llamadas de función; el servidor lo verifica antes de habilitar.</small></label>
            {!usesOAuth&&<label className="field"><span id={`${id}-key`}>Clave API</span><input name="apiKey" data-advisor-control="assistant-api-key-input" type="password" autoComplete="new-password" aria-labelledby={`${id}-key`} aria-describedby={`${id}-key-hint`} maxLength={4096} value={apiKey} required={keyRequired} placeholder={settings.hasApiKey&&!destinationChanged?'Clave guardada; deja vacío para conservarla':'Pega una clave nueva'} onChange={event=>{setApiKey(event.target.value);if(event.target.value)setClearApiKey(false);}}/><small id={`${id}-key-hint`} className="field-description">Solo se envía al servidor al guardar. Nunca se muestra después de guardarla.{settings.authMethod==='oauth'?' Cambiar a APIKey requiere una clave nueva; la conexión OAuth se elimina solo si el guardado se completa.':''}</small></label>}
            {usesOAuth&&<label className="field"><span id={`${id}-project`}>Proyecto de Google Cloud</span><input name="projectId" type="text" autoComplete="off" aria-labelledby={`${id}-project`} aria-describedby={`${id}-project-hint`} maxLength={30} required value={form.projectId} onChange={event=>setForm(current=>({...current,projectId:event.target.value}))}/><small id={`${id}-project-hint`} className="field-description">ID del proyecto (6–30 caracteres) o número de proyecto con la API de Gemini habilitada, cuota, permisos y facturación correspondientes. No es el nombre de tu cuenta de Google.</small></label>}
          </div>
          {usesOAuth&&<div>
            <p className="hint">{oauthConfigured===true?'La aplicación OAuth de Google está configurada en el servidor.':oauthConfigured===false?'OAuth de Google no está configurado en el servidor. Un administrador debe configurar la aplicación antes de conectar.':'No se pudo consultar la configuración OAuth de Google. Recarga la configuración para reintentar.'}</p>
            <p className="hint">Conectar Google no garantiza acceso por una suscripción de consumo a Gemini ni incluye su cuota. El servidor prueba el modelo y el proyecto antes de habilitar Ali. La conexión utiliza el modelo y proyecto actuales y no envía ninguna clave API a Google.</p>
            <div className="admin-actions">
              <button type="button" className="button" data-advisor-control="assistant-google-oauth-connect" disabled={locked||oauthConfigured!==true||pendingKeyChange||!form.model.trim()||!form.projectId.trim()} onClick={connectGoogle}>{operation==='connect'?'Abriendo Google…':settings.hasOAuthConnection?'Volver a conectar cuenta de Google':'Conectar cuenta de Google'}</button>
              {settings.hasOAuthConnection&&<button type="button" className="button" data-advisor-control="assistant-google-oauth-disconnect" disabled={locked||dirty} onClick={disconnectGoogle}>{operation==='disconnect'?'Desconectando…':'Desconectar cuenta de Google'}</button>}
            </div>
            {settings.hasOAuthConnection&&dirty&&<p className="hint">Guarda o descarta los cambios antes de desconectar Google.</p>}
            {!settings.hasOAuthConnection&&<p className="hint">Conecta una cuenta de Google antes de guardar ajustes OAuth. Una APIKey activa se conserva si se rechaza o falla la conexión.</p>}
          </div>}
          <label className="checkbox-field"><input name="enabled" type="checkbox" data-advisor-control={clearApiKey?undefined:willVerify?saveDisabledControl:verifyControl} checked={willVerify} disabled={clearApiKey} onChange={event=>setForm(current=>({...current,enabled:event.target.checked}))}/>Habilitar Ali y verificar la conexión al guardar</label>
          {form.provider==='openai-compatible'&&<label className="checkbox-field"><input name="allowPrivateNetwork" type="checkbox" checked={form.allowPrivateNetwork} onChange={event=>setForm(current=>({...current,allowPrivateNetwork:event.target.checked}))}/>Permitir destinos de red privada explícitamente</label>}
          {!usesOAuth&&settings.authMethod!=='oauth'&&settings.hasApiKey&&<label className="checkbox-field"><input name="clearApiKey" type="checkbox" data-advisor-control="assistant-remove-api-key-control" checked={clearApiKey} onChange={event=>{setClearApiKey(event.target.checked);if(event.target.checked)setApiKey('');}}/>Eliminar la clave guardada y deshabilitar Ali</label>}
          <p className="hint">{usesOAuth?'Deshabilitar no desconecta Google. Usa «Desconectar cuenta de Google» para eliminar la conexión local.':'Deshabilitar no elimina la clave. Para cambiar de proveedor o URL, guarda una clave nueva. «Eliminar la clave guardada» retira solo la custodia local, sin revocarla en el proveedor.'}</p>
          <div className="settings-save-bar"><span role="status">{operation==='connect'?'Abriendo autorización de Google…':operation==='disconnect'?'Eliminando conexión de Google…':operation==='save'?(willVerify?'Guardando y verificando…':'Guardando configuración…'):dirty?'Cambios sin guardar':settings.connectionStatus==='ready'?'Conexión verificada':settings.hasOAuthConnection?'Conexión de Google protegida':settings.hasApiKey?'Clave protegida':'Ali sin configurar'}</span>
            {dirty&&<button type="button" className="text-button" data-advisor-control="assistant-settings-discard-changes" disabled={locked} onClick={()=>{if(window.confirm('¿Descartar los cambios sin guardar?')){acceptSettings(settings);setError('');setNotice('Cambios descartados. La configuración guardada no cambió.');}}}>Descartar cambios</button>}
            <button type="submit" className="button primary" data-advisor-control={clearApiKey?undefined:willVerify?verifyControl:saveDisabledControl} disabled={locked||(usesOAuth&&(!settings.hasOAuthConnection||pendingKeyChange))||(!form.provider&&Boolean(apiKey))||(!form.provider&&settings.hasApiKey&&!clearApiKey)}>{operation==='save'?(willVerify?'Verificando…':'Guardando…'):willVerify?'Guardar y verificar':'Guardar configuración'}</button>
          </div>
        </fieldset>
      </form>
    </>}
  </section>;
}
