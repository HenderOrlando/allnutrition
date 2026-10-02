'use client';
import { useEffect, useRef } from 'react';
export default function useDialog(ref, { busy, dirty, onClose }) {
  const current = useRef({ busy, dirty, onClose }); current.current = { busy, dirty, onClose };
  const close = () => { const s = current.current; if (!s.busy && (!s.dirty || window.confirm('Hay cambios sin guardar. ¿Descartarlos y cerrar?'))) s.onClose(); };
  useEffect(() => {
    const prior = document.activeElement, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => [...(ref.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]') || [])].filter(node => node.getClientRects().length);
    focusable()[0]?.focus();
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const nodes = focusable(), first = nodes[0], last = nodes.at(-1); if (!first) return;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const unload = event => { if (current.current.dirty || current.current.busy) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('keydown', key); window.addEventListener('beforeunload', unload);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key); window.removeEventListener('beforeunload', unload); prior?.focus?.(); };
  }, [ref]);
  return close;
}
