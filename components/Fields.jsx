'use client';
import { useEffect, useRef, useState } from 'react';
import Icon from './Icons';
import ImageByUrl from './ImageByUrl';
export function Field({field:f,value,onChange,all,csrf,onUploading}){
 const options=all?.[f.source]||[];
 if(f.type==='checkbox')return <label className="checkbox-field"><input type="checkbox" checked={!!value} onChange={e=>onChange(e.target.checked)}/><span>{f.label}</span></label>;
 if(f.type==='image')return <ImageLink label={f.label} value={value||''} onChange={onChange} csrf={csrf} onUploading={onUploading} allowUpload={f.localUpload===true}/>;
 if(f.type==='multi')return <fieldset className="field"><legend>{f.label}</legend>{options.length===0?<p className="small muted">Primero crea un catálogo.</p>:<div className="check-grid">{options.map(o=><label key={o.id}><input type="checkbox" checked={(value||[]).includes(o.id)} onChange={e=>onChange(e.target.checked?[...(value||[]),o.id]:(value||[]).filter(x=>x!==o.id))}/>{o.title}</label>)}</div>}</fieldset>;
 if(f.type==='comboItems')return <fieldset className="field"><legend>{f.label}</legend>{(value||[]).map((line,i)=><div className="combo-line" key={i}><select aria-label={`Producto ${i+1} del combo`} value={line.productId} onChange={e=>onChange(value.map((x,j)=>j===i?{...x,productId:e.target.value}:x))} required><option value="">Selecciona un producto</option>{options.map(p=><option value={p.id} key={p.id}>{p.title} · {p.presentation}</option>)}</select><input aria-label={`Cantidad ${i+1}`} type="number" min="1" max="999" value={line.quantity} onChange={e=>onChange(value.map((x,j)=>j===i?{...x,quantity:Number(e.target.value)}:x))}/><button className="icon-button" aria-label="Quitar producto" type="button" onClick={()=>onChange(value.filter((_,j)=>j!==i))}><Icon name="close" size={16}/></button></div>)}<button type="button" className="button subtle compact" onClick={()=>onChange([...(value||[]),{productId:'',quantity:1}])}><Icon name="plus" size={15}/>Agregar producto</button></fieldset>;
 return <label className="field">{f.label}{f.required&&<span className="required"> *</span>}{f.type==='textarea'?<textarea value={value??''} required={!!f.required} maxLength={f.max||5000} onChange={e=>onChange(e.target.value)} rows={4}/>:f.type==='select'?<select value={value??''} onChange={e=>onChange(e.target.value)}>{f.options.map(o=><option value={o.value} key={o.value}>{o.label}</option>)}</select>:<input value={value??''} type={f.type==='money'||f.type==='number'?'number':f.type==='url'?'url':f.type==='email'?'email':'text'} required={!!f.required} min={f.type==='money'||f.type==='number'?f.min||0:undefined} step={f.type==='money'||f.type==='number'?1:undefined} maxLength={f.max||2000} onChange={e=>onChange(f.type==='money'||f.type==='number'?Number(e.target.value):e.target.value)}/>}</label>;
}

function ImageLink({label,value,onChange,csrf,onUploading,allowUpload}) {
 const localImage=allowUpload&&/^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
 const [tested,setTested]=useState(localImage?value:''),[showUrlInput,setShowUrlInput]=useState(!allowUpload||!!value&&!localImage);
 const [failed,setFailed]=useState(false),[uploading,setUploading]=useState(false),[uploadError,setUploadError]=useState(''),[usage,setUsage]=useState(null),[usageError,setUsageError]=useState('');
 const stagedImages=useRef(new Set());
 const bundled=['/brand/logo.jpg','/brand/creatina-vital-force.jpg'].includes(value);
 let valid=bundled||localImage;
 try { const u=new URL(value);valid ||= u.protocol==='https:'&&!u.username&&!u.password&&/\.[a-z]{2,}$/i.test(u.hostname)&&!/(localhost|\.local|\.internal|\.lan)$/i.test(u.hostname); }catch{}
 const previewSource=localImage?value:tested;
 useEffect(()=>{if(!allowUpload)return;let active=true;fetch('/api/admin/upload',{cache:'no-store'}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo consultar el almacenamiento.');if(active)setUsage(current=>current&&current.used>d.used?current:d);}).catch(e=>{if(active)setUsageError(e.message);});return()=>{active=false;};},[allowUpload]);
 useEffect(()=>{if(!allowUpload)return;return()=>{for(const url of stagedImages.current)fetch('/api/admin/upload',{method:'DELETE',headers:{'x-csrf-token':csrf,'Content-Type':'application/json'},body:JSON.stringify({url})}).catch(()=>{});stagedImages.current.clear();};},[allowUpload,csrf]);
 async function releaseStaged(keep=''){let currentUsage=null;for(const url of [...stagedImages.current]){if(url===keep)continue;const r=await fetch('/api/admin/upload',{method:'DELETE',headers:{'x-csrf-token':csrf,'Content-Type':'application/json'},body:JSON.stringify({url})});const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo liberar la imagen temporal.');stagedImages.current.delete(url);currentUsage=d.usage;}return currentUsage;}
 async function upload(file){onUploading?.(true);setUploading(true);setUploadError('');try{const r=await fetch('/api/admin/upload',{method:'POST',headers:{'x-csrf-token':csrf,'Content-Type':file.type||'application/octet-stream'},body:file});const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo subir la imagen.');stagedImages.current.add(d.url);onChange(d.url);setTested(d.url);setShowUrlInput(false);setFailed(false);setUsage(d.usage);setUsageError('');const cleanedUsage=await releaseStaged(d.url);if(cleanedUsage)setUsage(cleanedUsage);}catch(e){setUploadError(e.message);}finally{setUploading(false);onUploading?.(false);}}
 function clearImage(){onChange('');setTested('');setFailed(false);setUploadError('');}
 const mb=bytes=>`${new Intl.NumberFormat('es-CO',{maximumFractionDigits:3}).format(bytes/1_000_000)} MB`;
 return <div className={`field image-field${allowUpload?' product-image-field':''}`}>
  {allowUpload&&<div className="image-field-heading"><span>{label}</span><span className="image-optional">Opcional</span></div>}
  {(!allowUpload||showUrlInput)&&<label className="image-url-field">{allowUpload?'URL pública de la fotografía':label}<input aria-label={allowUpload?'URL pública de la fotografía':label} type="text" inputMode="url" maxLength={2048} value={value} placeholder="https://dominio-publico.com/producto.jpg" onChange={e=>{onChange(e.target.value);setTested('');setFailed(false);}}/></label>}
  {allowUpload&&<div className="image-upload">
   <div className="image-upload-heading"><strong>{localImage?'Imagen seleccionada':'Añade una fotografía'}</strong><span>JPG, PNG o WebP · máx. 10 MiB</span></div>
   <div className="image-upload-picker-row"><label className={`image-file-picker${uploading?' is-loading':''}`}><span>{uploading?'Subiendo…':localImage?'Cambiar imagen':'Elegir imagen'}</span><input aria-label="Archivo de imagen del producto" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg" disabled={uploading} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)upload(file);}}/></label><p>Se optimiza a WebP y se limita a 2400 px por lado.</p></div>
   {usage?<p className="small muted" role="status">Almacenamiento local de imágenes: {mb(usage.used)} de {mb(usage.limit)} (1 GB en total).</p>:usageError&&<p className="error">{usageError}</p>}
   {uploading&&<p className="small muted" role="status">Procesando y guardando la imagen…</p>}
   {uploadError&&<p className="error" role="alert">{uploadError}</p>}
  </div>}
  <div className="image-link-actions">
   {allowUpload&&<button type="button" className="text-button" onClick={()=>setShowUrlInput(open=>!open)}>{showUrlInput?'Ocultar URL':'Ingresar URL HTTPS'}</button>}
   {(!allowUpload||showUrlInput)&&value&&<button type="button" className="button subtle compact" disabled={!valid} onClick={()=>{setTested(value);setFailed(false);}}>Ver vista previa</button>}
   {value&&<button type="button" className="text-button" onClick={clearImage}>Quitar imagen</button>}
  </div>
  {previewSource&&<div className={`image-picker${localImage?' product-image-preview':''}`}><ImageByUrl key={previewSource} src={previewSource} alt={allowUpload?'Vista previa de la fotografía del producto':'Vista previa'} onError={()=>setFailed(true)}/><div className="image-preview-copy"><strong>{localImage?'Imagen subida':'Vista previa'}</strong><p className="small">{failed?'No se pudo mostrar. Comprueba que el archivo exista o que el enlace sea público.':localImage?'Se guardó en el servidor como WebP optimizado.':previewSource.startsWith('/api/media/')?'La imagen optimizada se sirve desde el almacenamiento local.':'La imagen se carga desde su dirección original; su disponibilidad depende de ese sitio.'}</p></div></div>}
  {value&&!valid&&<p className="error">Usa un enlace HTTPS público o una de las imágenes originales incorporadas.</p>}
 </div>;
}
