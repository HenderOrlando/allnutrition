'use client';
import { useState,useRef } from 'react';
import { schemas,slugify } from '@/lib/schema.mjs';
import { Field } from './Fields';
import Icon from './Icons';
import useDialog from './useDialog';
const productSections=[
 {title:'Información básica',description:'El nombre y la dirección corta identifican el producto en la tienda.',fields:['title','slug']},
 {title:'Imagen del producto',description:'Sube una imagen optimizada o ingresa una URL pública.',fields:['image'],singleColumn:true},
 {title:'Presentación y descripción',description:'Describe el contenido y los datos aprobados para mostrar al cliente.',fields:['presentation','flavor','description','productInfo']},
 {title:'Precio y disponibilidad',description:'Cada presentación puede tener un precio y una disponibilidad propios.',fields:['price','availability']},
 {title:'Organización y publicación',description:'Asigna catálogos y decide si se publica, se destaca o queda como borrador.',fields:['status','sort','featured','catalogIds']}
];
export default function RecordEditor({kind,record,all,csrf,onClose,onSaved}){
 const [form,setForm]=useState({...record}),[busy,setBusy]=useState(false),[uploadingImage,setUploadingImage]=useState(false),[error,setError]=useState('');
 const schema=schemas[kind];
 const dialog=useRef(null),close=useDialog(dialog,{busy:busy||uploadingImage,dirty:JSON.stringify(form)!==JSON.stringify(record),onClose});
 const change=(field,value)=>setForm(old=>({...old,[field]:value,...(field==='title'&&!record.id&&(!old.slug||old.slug===slugify(old.title))?{slug:slugify(value)}:{})}));
 async function save(e){e.preventDefault();if(uploadingImage)return;setBusy(true);setError('');try{const r=await fetch(`/api/admin/${kind}${record.id?`/${record.id}`:''}`,{method:record.id?'PUT':'POST',headers:{'Content-Type':'application/json','x-csrf-token':csrf},body:JSON.stringify(form)});const d=await r.json();if(!r.ok)throw new Error(d.error);await onSaved();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function remove(){if(!window.confirm(`¿Eliminar este ${schema.singular}? Esta acción no se puede deshacer.`))return;setBusy(true);setError('');try{const r=await fetch(`/api/admin/${kind}/${record.id}`,{method:'DELETE',headers:{'Content-Type':'application/json','x-csrf-token':csrf},body:JSON.stringify({version:record.version})});const d=await r.json();if(!r.ok)throw new Error(d.error);await onSaved();}catch(e){setError(e.message);}finally{setBusy(false);}}
 const fieldByName=new Map(schema.fields.map(field=>[field.name,field]));
 const renderField=field=><Field key={field.name} field={field} value={form[field.name]} onChange={value=>change(field.name,value)} all={all} csrf={csrf} onUploading={setUploadingImage}/>;
 return (
  <div className="drawer-backdrop">
   <section ref={dialog} className={`editor-drawer${kind==='products'?' product-editor':''}`} role="dialog" aria-modal="true" aria-labelledby="editor-title">
    <header>
     <div><p className="eyebrow">{schema.label.toUpperCase()}</p><h2 id="editor-title">{record.id?'Editar':'Crear'} {schema.singular}</h2></div>
     <button type="button" className="icon-button" aria-label="Cerrar editor" onClick={close} disabled={busy||uploadingImage}><Icon name="close"/></button>
    </header>
    <form onSubmit={save}>
     <fieldset className="editor-fieldset" disabled={busy||uploadingImage}>
      <div className="drawer-body">
       {kind==='products'?<>
        <div className="product-form-intro">
         <p className="hint">{schema.help}</p>
         <p className="small muted">Los campos con <span className="required">*</span> son obligatorios. Puedes guardar como borrador y completar la publicación después.</p>
        </div>
        <div className="product-form-sections">
         {productSections.map(section=><section className="product-form-section" key={section.title}>
          <div className="product-form-section-heading"><h3>{section.title}</h3><p>{section.description}</p></div>
          <div className={`product-form-grid${section.singleColumn?' product-form-grid--single':''}`}>
           {section.fields.map(name=><div className={`product-form-field product-form-field--${name}`} key={name}>{renderField(fieldByName.get(name))}</div>)}
          </div>
         </section>)}
        </div>
       </>:<>
        <p className="hint">{schema.help}</p>
        {schema.fields.map(renderField)}
       </>}
       {error&&<p className="error" role="alert">{error}</p>}
      </div>
      <footer>
       <div>{record.id&&<button className="text-button danger" type="button" onClick={remove} disabled={busy||uploadingImage}>Eliminar</button>}</div>
       <button type="button" className="button subtle" onClick={close} disabled={busy||uploadingImage}>Cancelar</button>
       <button className="button primary" disabled={busy||uploadingImage}>{busy?(record.id?'Guardando…':'Creando…'):uploadingImage?'Subiendo imagen…':record.id?'Guardar cambios':'Crear producto'}<Icon name="check" size={16}/></button>
      </footer>
     </fieldset>
    </form>
   </section>
  </div>
 );
}
