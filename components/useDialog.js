'use client';
import { useEffect, useRef } from 'react';
export default function useDialog(ref, { busy, dirty, onClose }) {
  const current = useRef({ busy, dirty, onClose }); current.current = { busy, dirty, onClose };
  const close = () => { const s = current.current; if (!s.busy && (!s.dirty || window.confirm('Hay cambios sin guardar. ¿Descartarlos y cerrar?'))) s.onClose(); };
  useEffect(() => {
    const node = ref.current;
    const prior = document.activeElement, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!node.open) node.showModal();
    node.querySelector('[data-dialog-initial-focus]')?.focus();
    const cancel = event => { event.preventDefault(); close(); };
    const unload = event => { if (current.current.dirty || current.current.busy) { event.preventDefault(); event.returnValue = ''; } };
    node.addEventListener('cancel', cancel);
    window.addEventListener('beforeunload', unload);
    return () => {
      node.removeEventListener('cancel', cancel);
      node.close();
      document.body.style.overflow = overflow;
      window.removeEventListener('beforeunload', unload);
      if (prior?.isConnected && !prior.closest('dialog') && !prior.matches(':disabled') && prior.getClientRects().length) prior.focus?.();
      else document.querySelector('[data-admin-section-heading]')?.focus({preventScroll:true});
    };
  }, [ref]);
  return close;
}
