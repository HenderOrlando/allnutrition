'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import Icon from './Icons';
import ImageByUrl from './ImageByUrl';
import {adminReturnTo} from '@/lib/admin-view.mjs';

export default function Login({returnTo}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[visible,setVisible]=useState(false);
 const errorSummary=useRef(null);
 useEffect(()=>{if(error)errorSummary.current?.focus();},[error]);
 async function submit(event) {
  event.preventDefault();if(busy)return;setBusy(true);setError('');
  const form=new FormData(event.currentTarget);
  try{
   const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.get('email'),password:form.get('password')})});
   const data=await response.json();if(!response.ok)throw new Error(data.error||'No se pudo ingresar.');
   window.location.assign(adminReturnTo(returnTo));
  }catch(cause){setError(cause.message);}finally{setBusy(false);}
 }
 function nativeInvalid(event){event.target.setAttribute('aria-invalid','true');}
 function nativeInput(event){if(event.target.validity?.valid)event.target.removeAttribute('aria-invalid');}
 return <main className="login-page">
  <div className="login-brand"><div className="login-brand-mark"><ImageByUrl src="/brand/logo.jpg" alt="" width={56} height={56}/><strong>All Nutrition</strong></div><h1>Tu mesa te espera.</h1><p>Un lugar para cuidar tu vitrina y registrar lo acordado con tus compradores.</p><Link href="/">Ir a la vitrina<Icon name="arrow"/></Link></div>
  <section className="login-card" aria-labelledby="login-title"><p className="eyebrow">Tu espacio privado</p><h2 id="login-title">Bienvenido de nuevo</h2><p>Entra y continúa donde lo dejaste.</p>
   <form onSubmit={submit} onInvalidCapture={nativeInvalid} onInputCapture={nativeInput} aria-busy={busy}>
    {error&&<div className="error" role="alert" tabIndex="-1" ref={errorSummary}>{error}</div>}
    <fieldset className="auth-fieldset" disabled={busy}>
     <label className="field" htmlFor="login-email">Correo de administrador<input id="login-email" name="email" type="email" autoComplete="username" required maxLength={254} placeholder="tu@correo.com"/></label>
     <label className="password-label" htmlFor="login-password">Contraseña</label><div className="password-control"><input id="login-password" name="password" type={visible?'text':'password'} autoComplete="current-password" required minLength={14} maxLength={200}/><button type="button" className="button subtle" aria-label={visible?'Ocultar contraseña':'Mostrar contraseña'} aria-controls="login-password" aria-pressed={visible} onClick={()=>setVisible(value=>!value)}>{visible?'Ocultar':'Mostrar'}</button></div>
     <button type="submit" className="button primary full">{busy?'Ingresando…':'Entrar al panel'}<Icon name="arrow"/></button>
    </fieldset>
   </form>
   <p className="small muted login-help">El acceso lo configura el responsable del negocio. No hay registro público de administradores.</p>
  </section>
 </main>;
}
