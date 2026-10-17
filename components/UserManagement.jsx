'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import Icon from './Icons';
import styles from './UserAccess.module.css';

export default function UserManagement({api,onInteractionStateChange}) {
 const [users,setUsers]=useState(null),[loading,setLoading]=useState(true),[listError,setListError]=useState('');
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState('');
 const [visible,setVisible]=useState(false),[confirmationVisible,setConfirmationVisible]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const errorSummary=useRef(null),sequence=useRef(0),formHeading=useRef(null),listHeading=useRef(null);
 const dirty=Boolean(email||password||confirmation);
 useEffect(()=>{onInteractionStateChange({dirty,busy});},[dirty,busy,onInteractionStateChange]);
 useEffect(()=>()=>onInteractionStateChange({dirty:false,busy:false}),[onInteractionStateChange]);
 useEffect(()=>{if(error)errorSummary.current?.focus();},[error]);
 const load=useCallback(async(afterSave=false)=>{
  const request=++sequence.current;setLoading(true);setListError('');
  try{const result=await api('/api/admin/users');if(request===sequence.current)setUsers(result.users);}
  catch(cause){if(request===sequence.current)setListError(afterSave?'La cuenta se creó, pero no pudimos actualizar esta lista. '+cause.message:cause.message);}
  finally{if(request===sequence.current)setLoading(false);}
 },[api]);
 useEffect(()=>{void load();return()=>{sequence.current++;};},[load]);
 async function submit(event){
  event.preventDefault();if(busy)return;setError('');setNotice('');
  if(password!==confirmation){setError('Las contraseñas no coinciden.');return;}
  setBusy(true);
  let result;
  try{result=await api('/api/admin/users',{method:'POST',body:JSON.stringify({email,password,role:'administrator'})});}
  catch(cause){setError(cause.message);return;}
  finally{setBusy(false);}
  setEmail('');setPassword('');setConfirmation('');setVisible(false);setConfirmationVisible(false);
  setNotice(`Cuenta ${result.user.email} creada con rol Administrador.`);
  void load(true);
 }
 function invalid(event){event.target.setAttribute('aria-invalid','true');}
 function valid(event){if(event.target.validity?.valid)event.target.removeAttribute('aria-invalid');}
 return <div className={styles.users}>
  <section className="user-management-card" aria-labelledby="users-list-heading" aria-busy={loading}>
   <div className={styles.sectionHeading}>
    <div><p className="eyebrow">Acceso al panel</p><h2 id="users-list-heading" ref={listHeading} tabIndex="-1">Usuarios registrados{users?` (${users.length})`:''}</h2></div>
    <button type="button" className="button primary" onClick={()=>formHeading.current?.focus()} aria-controls="add-user-heading"><Icon name="plus" size={16}/>Preparar nuevo acceso</button>
   </div>
   <p>Consulta quién tiene acceso y el estado de cada cuenta. Todas tienen el mismo perfil de administrador.</p>
   {loading&&<p className="small" role="status">{users?'Actualizando…':'Cargando usuarios…'}</p>}
   {!users&&loading&&<div className="static-skeleton" aria-hidden="true"/>}
   {listError&&<div className="error" role="alert">{listError}<button type="button" className="text-button" onClick={()=>load()}>Reintentar carga de usuarios</button></div>}
   {users?.length>0&&<><div className="user-table"><table className="user-management-table"><caption className="sr-only">Cuentas administrativas registradas</caption><thead><tr><th scope="col">Correo</th><th scope="col">Perfil</th><th scope="col">Estado</th></tr></thead><tbody>{users.map(user=><tr key={user.id}><td>{user.email}</td><td>Administrador</td><td>{user.active?'Activo':'Desactivado'}</td></tr>)}</tbody></table></div><ul className="user-cards">{users.map(user=><li key={user.id}><strong>{user.email}</strong><div><span className="pill">Administrador</span><span className={`pill ${user.active?'published':'archived'}`}>{user.active?'Activo':'Desactivado'}</span></div></li>)}</ul></>}
   {users&&users.length===0&&!listError&&<p>No hay usuarios registrados.</p>}
  </section>
  <section className="user-management-card" aria-labelledby="add-user-heading">
   <div className={styles.sectionHeading}>
    <div><p className="eyebrow">Nuevo acceso</p><h2 id="add-user-heading" ref={formHeading} tabIndex="-1">Crear usuario</h2></div>
    <button type="button" className="text-button" onClick={()=>listHeading.current?.focus()} aria-controls="users-list-heading">Consultar usuarios</button>
   </div>
   <p>Crea un acceso individual para otra persona del equipo, sin compartir tu propia cuenta.</p>
   <div className={styles.roleNotice}><span>Perfil de la cuenta</span><strong>Administrador</strong><p>Podrá administrar la vitrina y el registro del negocio. No hay permisos reducidos por tarea.</p><p>No se envía una invitación automática ni un correo al crear la cuenta. Comparte las credenciales por un canal seguro.</p></div>
   <form className="user-management-form" onSubmit={submit} onInvalidCapture={invalid} onInputCapture={valid} aria-busy={busy}>
    {error&&<div ref={errorSummary} className="error" role="alert" tabIndex="-1">{error}</div>}
    {notice&&<div className="success alert" role="status">{notice}<button type="button" className="icon-button" aria-label="Cerrar aviso de usuario" onClick={()=>setNotice('')}><Icon name="close"/></button></div>}
    <fieldset className="auth-fieldset" disabled={busy}>
     <fieldset className={styles.userGroup}>
      <legend><span className={styles.sectionNumber} aria-hidden="true">1</span>Identifica a la persona</legend>
      <label className="field" htmlFor="user-email">Correo electrónico <span className="required">*</span><input id="user-email" name="email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={event=>setEmail(event.target.value)} aria-describedby="user-email-help"/></label>
      <p id="user-email-help" className="small muted">Este correo se usará para entrar al panel. Revisa que pertenezca a la persona correcta.</p>
     </fieldset>
     <fieldset className={styles.userGroup}>
      <legend><span className={styles.sectionNumber} aria-hidden="true">2</span>Prepara el acceso</legend>
      <label className="password-label" htmlFor="user-password">Contraseña inicial <span className="required">*</span></label><div className={`password-control ${styles.passwordControl}`}><input id="user-password" name="password" type={visible?'text':'password'} autoComplete="new-password" minLength={14} maxLength={200} required value={password} onChange={event=>setPassword(event.target.value)} aria-describedby="user-password-help"/><button type="button" className="button subtle" aria-label={visible?'Ocultar contraseña inicial':'Mostrar contraseña inicial'} aria-controls="user-password" aria-pressed={visible} onClick={()=>setVisible(value=>!value)}>{visible?'Ocultar contraseña':'Mostrar contraseña'}</button></div>
      <p id="user-password-help" className="small muted">Usa entre 14 y 200 caracteres. Compártela con la persona por un canal seguro.</p>
      <label className="password-label" htmlFor="user-confirmation">Confirmar contraseña <span className="required">*</span></label><div className={`password-control ${styles.passwordControl}`}><input id="user-confirmation" name="confirmation" type={confirmationVisible?'text':'password'} autoComplete="new-password" minLength={14} maxLength={200} required value={confirmation} onChange={event=>setConfirmation(event.target.value)} aria-describedby="user-confirmation-help"/><button type="button" className="button subtle" aria-label={confirmationVisible?'Ocultar confirmación de contraseña':'Mostrar confirmación de contraseña'} aria-controls="user-confirmation" aria-pressed={confirmationVisible} onClick={()=>setConfirmationVisible(value=>!value)}>{confirmationVisible?'Ocultar confirmación':'Mostrar confirmación'}</button></div>
      <p id="user-confirmation-help" className="small muted" role="status">{confirmation?(password===confirmation?'Las contraseñas coinciden.':'Las contraseñas todavía no coinciden.'):'Repite la contraseña inicial para evitar errores al compartir el acceso.'}</p>
     </fieldset>
     <div className={styles.userReview}>
      <h3>Antes de crear la cuenta</h3>
      <p>{email?<>Se creará el acceso para <strong>{email}</strong> con perfil Administrador.</>:'Completa el correo y ambas contraseñas. La cuenta solo se crea al confirmar con el botón.'}</p>
      <p className="unsaved-flag" role="status">{dirty?'Datos sin guardar':'Sin datos pendientes'}</p>
      <button type="submit" className="button primary">{busy?'Creando…':'Crear usuario'}<Icon name="plus" size={16}/></button>
     </div>
    </fieldset>
   </form>
  </section>
 </div>;
}
