'use client';
import { useState } from 'react';
import Icon from './Icons';
import ImageByUrl from './ImageByUrl';
export function Field({field:f,value,onChange,all,csrf}){
 const options=all?.[f.source]||[];
 if(f.type==='checkbox')return <label className="checkbox-field"><input type="checkbox" checked={!!value} onChange={e=>onChange(e.target.checked)}/><span>{f.label}</span></label>;
 if(f.type==='image')return <ImageLink label={f.label} value={value||''} onChange={onChange}/>;
 if(f.type==='multi')return <fieldset className="field"><legend>{f.label}</legend>{options.length===0?<p className="small muted">Primero crea un catálogo.</p>:<div className="check-grid">{options.map(o=><label key={o.id}><input type="checkbox" checked={(value||[]).includes(o.id)} onChange={e=>onChange(e.target.checked?[...(value||[]),o.id]:(value||[]).filter(x=>x!==o.id))}/>{o.title}</label>)}</div>}</fieldset>;
 if(f.type==='comboItems')return <fieldset className="field"><legend>{f.label}</legend>{(value||[]).map((line,i)=><div className="combo-line" key={i}><select aria-label={`Producto ${i+1} del combo`} value={line.productId} onChange={e=>onChange(value.map((x,j)=>j===i?{...x,productId:e.target.value}:x))} required><option value="">Selecciona un producto</option>{options.map(p=><option value={p.id} key={p.id}>{p.title} · {p.presentation}</option>)}</select><input aria-label={`Cantidad ${i+1}`} type="number" min="1" max="999" value={line.quantity} onChange={e=>onChange(value.map((x,j)=>j===i?{...x,quantity:Number(e.target.value)}:x))}/><button className="icon-button" aria-label="Quitar producto" type="button" onClick={()=>onChange(value.filter((_,j)=>j!==i))}><Icon name="close" size={16}/></button></div>)}<button type="button" className="button subtle compact" onClick={()=>onChange([...(value||[]),{productId:'',quantity:1}])}><Icon name="plus" size={15}/>Agregar producto</button></fieldset>;
 return <label className="field">{f.label}{f.required&&<span className="required"> *</span>}{f.type==='textarea'?<textarea value={value??''} required={!!f.required} maxLength={f.max||5000} onChange={e=>onChange(e.target.value)} rows={4}/>:f.type==='select'?<select value={value??''} onChange={e=>onChange(e.target.value)}>{f.options.map(o=><option value={o.value} key={o.value}>{o.label}</option>)}</select>:<input value={value??''} type={f.type==='money'||f.type==='number'?'number':f.type==='url'?'url':f.type==='email'?'email':'text'} required={!!f.required} min={f.type==='money'||f.type==='number'?f.min||0:undefined} step={f.type==='money'||f.type==='number'?1:undefined} maxLength={f.max||2000} onChange={e=>onChange(f.type==='money'||f.type==='number'?Number(e.target.value):e.target.value)}/>}</label>;
}

function ImageLink({label,value,onChange}) {
 const [tested,setTested]=useState(''),[failed,setFailed]=useState(false);
 const bundled=['/brand/logo.jpg','/brand/creatina-vital-force.jpg'].includes(value);
 let valid=bundled;
 try { const u=new URL(value);valid=u.protocol==='https:'&&!u.username&&!u.password&&/\.[a-z]{2,}$/i.test(u.hostname)&&!/(localhost|\.local|\.internal|\.lan)$/i.test(u.hostname); }catch{}
 return <div className="field"><label>{label}<input aria-label={label} type="text" inputMode="url" maxLength={2048} value={value} placeholder="https://dominio-publico.com/producto.jpg" onChange={e=>{onChange(e.target.value);setTested('');setFailed(false);}}/></label>
 <p className="small muted">Pega el enlace directo de una imagen pública. No se sube ni se copia ningún archivo. Los enlaces de publicaciones o carpetas no son imágenes directas.</p>
 <div className="image-link-actions"><button type="button" className="button subtle compact" disabled={!valid} onClick={()=>{setTested(value);setFailed(false);}}>Verificar vista previa</button>{value&&<button type="button" className="text-button" onClick={()=>{onChange('');setTested('');}}>Quitar imagen</button>}</div>
 {tested&&<div className="image-picker"><ImageByUrl key={tested} src={tested} alt="Vista previa" onError={()=>setFailed(true)}/><p className="small">{failed?'El navegador no pudo mostrarla. Comprueba que el enlace sea público, directo y no haya caducado.':'La imagen se carga desde su dirección original. Su disponibilidad depende de ese sitio.'}</p></div>}
 {value&&!valid&&<p className="error">Usa un enlace HTTPS público o una de las imágenes originales incorporadas.</p>}
 </div>;
}
