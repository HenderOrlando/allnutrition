'use client';
import { useId, useRef } from 'react';
import useDialog from './useDialog';
import Icon from './Icons';
import styles from './OrderExperience.module.css';

export default function ImportDecisionDialog({title,description,items,warning,confirmLabel,onConfirm,onClose}){
 const dialog=useRef(null),settled=useRef(false),titleId=useId(),descriptionId=useId(),warningId=useId();
 function dismiss(){
  if(settled.current)return;
  settled.current=true;
  dialog.current?.close();
  onClose();
 }
 const close=useDialog(dialog,{busy:false,dirty:false,onClose:dismiss});
 function confirm(event){
  event.preventDefault();
  if(settled.current)return;
  settled.current=true;
  dialog.current?.close();
  // The native dialog is closed before the owner can begin the confirmed action.
  onConfirm();
 }
 return <dialog ref={dialog} className={`editor-drawer ${styles.editor}`} aria-labelledby={titleId} aria-describedby={[description&&descriptionId,warning&&warningId].filter(Boolean).join(' ')||undefined}>
  <header>
   <h2 id={titleId} tabIndex={-1} data-dialog-initial-focus>{title}</h2>
   <button className="icon-button" type="button" aria-label="Volver sin cambios" onClick={close}><Icon name="close"/></button>
  </header>
  <form onSubmit={confirm}>
   <div className="drawer-body">
    {description&&<p id={descriptionId}>{description}</p>}
    <section aria-label="Elementos afectados" className={styles.importDecisionList} tabIndex={0}>
     <ul>{items.map(item=><li key={item.key}><strong>{item.label}</strong>{item.detail&&<p>{item.detail}</p>}</li>)}</ul>
    </section>
    {warning&&<p id={warningId} className="notice">{warning}</p>}
   </div>
   <footer className="editor-footer">
    <button className="button subtle" type="button" onClick={close}>Volver sin cambios</button>
    <button className="button primary" type="submit">{confirmLabel}</button>
   </footer>
  </form>
 </dialog>;
}
