'use client';
import { useState,useRef } from 'react';
import { schemas,slugify } from '@/lib/schema.mjs';
import { Field } from './Fields';
import Icon from './Icons';
import useDialog from './useDialog';
export default function RecordEditor({kind,record,all,csrf,onClose,onSaved}){
 const [form,setForm]=useState({...record}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const schema=schemas[kind];
 const dialog=useRef(null),close=useDialog(dialog,{busy,dirty:JSON.stringify(form)!==JSON.stringify(record),onClose});
 const change=(field,value)=>setForm(old=>({...old,[field]:value,...(field==='title'&&!record.id&&(!old.slug||old.slug===slugify(old.title))?{slug:slugify(value)}:{})}));
 async function save(e){e.preventDefault();setBusy(true);setError('');try{const r=await fetch(`/api/admin/${kind}${record.id?`/${record.id}`:''}`,{method:record.id?'PUT':'POST',headers:{'Content-Type':'application/json','x-csrf-token':csrf},body:JSON.stringify(form)});const d=await r.json();if(!r.ok)throw new Error(d.error);await onSaved();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function remove(){if(!window.confirm(`¿Eliminar este ${schema.singular}? Esta acción no se puede deshacer.`))return;setBusy(true);setError('');try{const r=await fetch(`/api/admin/${kind}/${record.id}`,{method:'DELETE',headers:{'Content-Type':'application/json','x-csrf-token':csrf},body:JSON.stringify({version:record.version})});const d=await r.json();if(!r.ok)throw new Error(d.error);await onSaved();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <div className="drawer-backdrop"><section ref={dialog} className="editor-drawer" role="dialog" aria-modal="true" aria-labelledby="editor-title"><header><div><p className="eyebrow">{schema.label.toUpperCase()}</p><h2 id="editor-title">{record.id?'Editar':'Crear'} {schema.singular}</h2></div><button type="button" className="icon-button" aria-label="Cerrar editor" onClick={close} disabled={busy}><Icon name="close"/></button></header><form onSubmit={save}><fieldset className="editor-fieldset" disabled={busy}><div className="drawer-body"><p className="hint">{schema.help}</p>{schema.fields.map(f=><Field key={f.name} field={f} value={form[f.name]} onChange={v=>change(f.name,v)} all={all} csrf={csrf}/>)}{error&&<p className="error" role="alert">{error}</p>}</div><footer><div>{record.id&&<button className="text-button danger" type="button" onClick={remove} disabled={busy}>Eliminar</button>}</div><button type="button" className="button subtle" onClick={close} disabled={busy}>Cancelar</button><button className="button primary" disabled={busy}>{busy?'Guardando…':'Guardar cambios'}<Icon name="check" size={16}/></button></footer></fieldset></form></section></div>;
}
