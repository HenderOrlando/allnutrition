'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icons';
import ImageByUrl from './ImageByUrl';
import { parseMoneyMinor, moneyMinor } from '@/lib/business/money.mjs';
import styles from './CatalogExperience.module.css';

const nativeValidity={
 onInvalid:event=>event.currentTarget.setAttribute('aria-invalid','true'),
 onInput:event=>{if(event.currentTarget.validity.valid)event.currentTarget.removeAttribute('aria-invalid');}
};
export function Field({field:f,value,onChange,all,api,onUploading,onDraftInvalid}) {
 const id=useId(),options=all?.[f.source]||[];
 const describedBy=f.description?`${id}-description`:undefined;
 const description=f.description&&<small id={describedBy} className="muted field-description">{f.description}</small>;
 if(f.type==='checkbox')return <label className="checkbox-field" htmlFor={id}><input id={id} name={f.name} type="checkbox" checked={!!value} onChange={event=>onChange(event.target.checked)} aria-describedby={describedBy}/><span>{f.label}{description}</span></label>;
 if(f.type==='image')return <ImageLink id={id} name={f.name} label={f.label} value={value||''} onChange={onChange} api={api} onUploading={onUploading} allowUpload={f.localUpload===true}/>;
 if(f.type==='multi')return <fieldset className={`field ${styles.catalogChoices}`} aria-describedby={describedBy}><legend>{f.label} <span className={styles.selectionCount}>({(value||[]).length} seleccionados)</span></legend>{description}{options.length===0?<p className="small muted">Todavía no hay catálogos. Puedes guardar la ficha y asignarlos después desde aquí.</p>:<div className="check-grid">{options.map(option=><label key={option.id} htmlFor={`${id}-${option.id}`}><input id={`${id}-${option.id}`} name={f.name} type="checkbox" checked={(value||[]).includes(option.id)} onChange={event=>onChange(event.target.checked?[...(value||[]),option.id]:(value||[]).filter(key=>key!==option.id))}/>{option.title}</label>)}</div>}</fieldset>;
 if(f.type==='comboItems')return <ProductComponents name={f.name} label={f.label} description={f.description} value={value} onChange={onChange} products={options}/>;
 if(f.type==='moneyOptionalMinor')return <OptionalMoneyField field={f} value={value} onChange={onChange} onDraftInvalid={onDraftInvalid}/>;
 if(f.type==='optionalNumber')return <div className="field"><label htmlFor={id}>{f.label}</label><input {...nativeValidity} id={id} name={f.name} type="number" inputMode="numeric" min={f.min||0} max={Number.MAX_SAFE_INTEGER} step={1} value={value??''} required={!!f.required} aria-describedby={describedBy} onChange={event=>onChange(event.target.value===''?null:Number(event.target.value))}/>{description}</div>;
 if(f.type==='date')return <div className="field"><label htmlFor={id}>{f.label}</label><input {...nativeValidity} id={id} name={f.name} type="date" value={value??''} required={!!f.required} aria-describedby={describedBy} onChange={event=>onChange(event.target.value||null)}/>{description}</div>;
 const control={id,name:f.name,'aria-describedby':describedBy,...nativeValidity};
 return <div className="field"><label htmlFor={id}>{f.label}{f.required&&<span className="required"> *</span>}</label>
  {f.type==='textarea'?<textarea {...control} value={value??''} required={!!f.required} maxLength={f.max||5000} onChange={event=>onChange(event.target.value)} rows={4}/>:f.type==='select'?<select {...control} value={value??''} onChange={event=>onChange(event.target.value)}>{f.options.map(option=><option value={option.value} key={option.value}>{option.label}</option>)}</select>:<input {...control} value={value??''} type={f.type==='money'||f.type==='number'?'number':f.type==='url'?'url':f.type==='email'?'email':'text'} required={!!f.required} min={f.type==='money'||f.type==='number'?f.min||0:undefined} step={f.type==='money'||f.type==='number'?1:undefined} maxLength={f.max||2000} onChange={event=>onChange(f.type==='money'||f.type==='number'?Number(event.target.value):event.target.value)}/>}
  {description}
 </div>;
}

const costInputFormatter=new Intl.NumberFormat('es-CO',{minimumFractionDigits:0,maximumFractionDigits:2});
function OptionalMoneyField({field,value,onChange,onDraftInvalid}){
 const id=useId(),focused=useRef(false);
 const [draft,setDraft]=useState(()=>value==null?'':costInputFormatter.format(value/100));
 const [error,setError]=useState('');
 useEffect(()=>{if(!focused.current)setDraft(value==null?'':costInputFormatter.format(value/100));},[value]);
 function input(event){
  const next=event.target.value;setDraft(next);
  try{
   const amount=next.trim()===''?null:moneyMinor(parseMoneyMinor(next),field.label,{signed:field.signed===true});
   event.target.setCustomValidity('');setError('');onDraftInvalid?.(false);onChange(amount);
  }catch(cause){event.target.setCustomValidity(cause.message);setError(cause.message);onDraftInvalid?.(true);}
 }
 return <div className="field"><label htmlFor={id}>{field.label}</label><input {...nativeValidity} id={id} name={field.name} type="text" inputMode="decimal" maxLength={100} value={draft} required={!!field.required} placeholder={field.required?'Ingresa el importe':'Sin importe registrado'} aria-invalid={error?true:undefined} aria-describedby={`${id}-help${error?` ${id}-error`:''}`} onFocus={()=>{focused.current=true;}} onChange={input} onBlur={()=>{focused.current=false;if(!error)setDraft(value==null?'':costInputFormatter.format(value/100));}}/><small id={`${id}-help`} className="muted field-description">{field.description||'Pesos colombianos: punto para miles y coma para centavos. Vacío = sin dato; 0 = importe registrado de cero.'}</small>{error&&<p id={`${id}-error`} className="error" role="alert">{error}</p>}</div>;
}

export function ProductComponents({name='items',label='Productos incluidos',description,value=[],onChange,products=[],excludeId}){
 const id=useId(),root=useRef(null),focusTarget=useRef(null),options=products.filter(product=>(product.productType||'product')==='product'&&product.id!==excludeId);
 const lines=value||[];
 useEffect(()=>{
  if(focusTarget.current===null)return;
  root.current?.querySelector(focusTarget.current)?.focus();
  focusTarget.current=null;
 },[lines.length]);
 function add(){
  focusTarget.current=`[data-component-product="${lines.length}"]`;
  onChange([...lines,{productId:'',quantity:1}]);
 }
 function remove(index){
  focusTarget.current=lines.length>1?`[data-component-product="${Math.min(index,lines.length-2)}"]`:'[data-add-component]';
  onChange(lines.filter((_,i)=>i!==index));
 }
 return <fieldset ref={root} className={`field ${styles.components}`} aria-describedby={`${id}-help`}><legend>{label}</legend><p id={`${id}-help`} className="small muted">{description||'Añade productos normales, sin repetir referencias, con cantidades entre 1 y 999.'}</p>
  <p className={styles.componentCount} role="status">{lines.length?`${lines.length} ${lines.length===1?'referencia incluida':'referencias incluidas'}`:'Aún no hay productos incluidos.'}</p>
  {!options.length&&<p className="hint">Primero crea productos normales para añadir componentes. Puedes cerrar esta ficha y volver después.</p>}
  {lines.map((line,index)=><div className={`combo-line ${styles.componentLine}`} key={index}>
   <label htmlFor={`${id}-product-${index}`}><span className="small">Producto {index+1}</span><select id={`${id}-product-${index}`} data-component-product={index} name={`${name}[${index}].productId`} value={line.productId} onChange={event=>onChange(lines.map((item,i)=>i===index?{...item,productId:event.target.value}:item))} required {...nativeValidity}><option value="">Selecciona un producto</option>{line.productId&&!options.some(product=>product.id===line.productId)&&<option value={line.productId} disabled>Referencia no válida: selecciona un producto normal</option>}{options.map(product=><option value={product.id} key={product.id}>{product.title}{product.presentation?` · ${product.presentation}`:''}</option>)}</select></label>
   <label htmlFor={`${id}-quantity-${index}`}><span className="small">Cantidad {index+1}</span><input id={`${id}-quantity-${index}`} name={`${name}[${index}].quantity`} type="number" min="1" max="999" step="1" required value={line.quantity} onChange={event=>onChange(lines.map((item,i)=>i===index?{...item,quantity:Number(event.target.value)}:item))} {...nativeValidity}/></label>
   <button className="icon-button" aria-label={`Quitar producto ${index+1}`} type="button" onClick={()=>remove(index)}><Icon name="close" size={16}/></button>
  </div>)}
  <button type="button" data-add-component className="button subtle" onClick={add}><Icon name="plus" size={16}/>Agregar producto</button>
 </fieldset>;
}

function ImageLink({id,name,label,value,onChange,api,onUploading,allowUpload}) {
 const localImage=allowUpload&&/^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
 const [tested,setTested]=useState(localImage?value:''),[showUrlInput,setShowUrlInput]=useState(!allowUpload||!!value&&!localImage);
 const [failed,setFailed]=useState(false),[uploading,setUploading]=useState(false),[uploadError,setUploadError]=useState(''),[usage,setUsage]=useState(null),[usageError,setUsageError]=useState('');
 const stagedImages=useRef(new Set());
 const bundled=['/brand/logo.jpg','/brand/creatina-vital-force.jpg'].includes(value);
 let valid=bundled||localImage;
 try {const url=new URL(value);valid ||= url.protocol==='https:'&&!url.username&&!url.password&&/\.[a-z]{2,}$/i.test(url.hostname)&&!/(localhost|\.local|\.internal|\.lan)$/i.test(url.hostname);}catch{}
 const previewSource=localImage?value:tested;
 useEffect(()=>{if(!allowUpload)return;let active=true;api('/api/admin/upload').then(data=>{if(active)setUsage(current=>current&&current.used>data.used?current:data);}).catch(cause=>{if(active)setUsageError(cause.message);});return()=>{active=false;};},[allowUpload,api]);
 useEffect(()=>{if(!allowUpload)return;const staged=stagedImages.current;return()=>{for(const url of staged)void api('/api/admin/upload',{method:'DELETE',body:JSON.stringify({url})}).catch(()=>{});staged.clear();};},[allowUpload,api]);
 async function releaseStaged(keep='') {
  let currentUsage=null;
  for(const url of [...stagedImages.current]){if(url===keep)continue;const data=await api('/api/admin/upload',{method:'DELETE',body:JSON.stringify({url})});stagedImages.current.delete(url);currentUsage=data.usage;}
  return currentUsage;
 }
 async function upload(file) {
  if(file.size>10*1024*1024){setUploadError('La imagen supera el límite de 10 MiB.');return;}
  onUploading?.(true);setUploading(true);setUploadError('');
  try{
   const data=await api('/api/admin/upload',{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});
   stagedImages.current.add(data.url);onChange(data.url);setTested(data.url);setShowUrlInput(false);setFailed(false);setUsage(data.usage);setUsageError('');
   const cleanedUsage=await releaseStaged(data.url);if(cleanedUsage)setUsage(cleanedUsage);
  }catch(cause){setUploadError(cause.message);}finally{setUploading(false);onUploading?.(false);}
 }
 function clearImage(){onChange('');setTested('');setFailed(false);setUploadError('');}
 const mb=bytes=>`${new Intl.NumberFormat('es-CO',{maximumFractionDigits:3}).format(bytes/1_000_000)} MB`;
 return <div className={`field image-field${allowUpload?' product-image-field':''}`} aria-busy={uploading}>
  {allowUpload&&<div className="image-field-heading"><span>{label}</span><span className="image-optional">Opcional en borrador</span></div>}
  {(!allowUpload||showUrlInput)&&<label className="image-url-field" htmlFor={id}>{allowUpload?'URL pública de la fotografía':label}<input id={id} name={name} type="text" inputMode="url" maxLength={2048} value={value} placeholder="https://dominio-publico.com/producto.jpg" aria-invalid={value&&!valid?true:undefined} aria-describedby={value&&!valid?`${id}-url-error`:undefined} onChange={event=>{onChange(event.target.value);setTested('');setFailed(false);}}/></label>}
  {allowUpload&&<div className="image-upload">
   <div className="image-upload-heading"><strong>{localImage?'Imagen seleccionada':'Añade una fotografía'}</strong><span>JPG, PNG o WebP · máx. 10 MiB</span></div>
   <div className="image-upload-picker-row"><label className={`image-file-picker${uploading?' is-loading':''}`} htmlFor={`${id}-file`}><span>{uploading?'Subiendo…':localImage?'Cambiar imagen':'Elegir imagen'}</span><input id={`${id}-file`} name={`${name}File`} aria-label="Archivo de imagen del producto" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg" disabled={uploading} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void upload(file);}}/></label><p>Se optimiza a WebP y se limita a 2400 px por lado.</p></div>
   {usage?<p className="small muted" role="status">Almacenamiento local de imágenes: {mb(usage.used)} de {mb(usage.limit)} (1 GB en total).</p>:usageError&&<p className="error" role="alert">{usageError}</p>}
   {uploading&&<><div className="upload-progress" role="progressbar" aria-label="Subiendo imagen"/><p className="small muted" role="status">Procesando y guardando la imagen…</p></>}
   {uploadError&&<p className="error" role="alert">{uploadError}</p>}
  </div>}
  <div className="image-link-actions">
   {allowUpload&&<button type="button" className="text-button" onClick={()=>setShowUrlInput(open=>!open)}>{showUrlInput?'Ocultar URL':'Ingresar URL HTTPS'}</button>}
   {(!allowUpload||showUrlInput)&&value&&<button type="button" className="button subtle" disabled={!valid} onClick={()=>{setTested(value);setFailed(false);}}>Ver vista previa</button>}
   {value&&<button type="button" className="text-button" onClick={clearImage}>Quitar imagen</button>}
  </div>
  {previewSource&&<div className={`image-picker${localImage?' product-image-preview':''}`}><ImageByUrl key={previewSource} src={previewSource} alt={allowUpload?'Vista previa de la fotografía del producto':'Vista previa'} onError={()=>setFailed(true)}/><div className="image-preview-copy"><strong>{localImage?'Imagen subida':'Vista previa'}</strong><p className="small">{failed?'No se pudo mostrar. Comprueba que el archivo exista o que el enlace sea público.':localImage?'Se guardó en el servidor como WebP optimizado.':previewSource.startsWith('/api/media/')?'La imagen optimizada se sirve desde el almacenamiento local.':'La imagen se carga desde su dirección original; su disponibilidad depende de ese sitio.'}</p></div></div>}
  {value&&!valid&&<p id={`${id}-url-error`} className="error" role="alert">Usa un enlace HTTPS público o una de las imágenes originales incorporadas.</p>}
 </div>;
}
