'use client';
import { useEffect, useRef } from 'react';

const scrollLocks = new Set();
let originalOverflow = '';
let pagePosition = null;

export default function useDialog(ref, { busy = false, dirty = false, onClose, open = true }) {
  const current = useRef({ busy, dirty, onClose });
  current.current = { busy, dirty, onClose };
  const close = () => {
    const state = current.current;
    if (!state.busy && (!state.dirty || window.confirm('Hay cambios sin guardar. ¿Descartarlos y cerrar?'))) state.onClose?.();
  };
  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;
    const prior = document.activeElement;
    const priorScroll = [];
    for (let ancestor = prior?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.scrollHeight > ancestor.clientHeight || ancestor.scrollWidth > ancestor.clientWidth) {
        priorScroll.push([ancestor, ancestor.scrollLeft, ancestor.scrollTop]);
      }
    }
    const lock = { node };
    if (!scrollLocks.size) {
      originalOverflow = document.body.style.overflow;
      pagePosition = [window.scrollX, window.scrollY];
      document.body.style.overflow = 'hidden';
    }
    scrollLocks.add(lock);
    if (!node.open) node.showModal();
    node.querySelector('[data-dialog-initial-focus]')?.focus({ preventScroll: true });
    const cancel = event => { event.preventDefault(); close(); };
    const unload = event => {
      if (current.current.dirty || current.current.busy) { event.preventDefault(); event.returnValue = ''; }
    };
    node.addEventListener('cancel', cancel);
    window.addEventListener('beforeunload', unload);
    return () => {
      node.removeEventListener('cancel', cancel);
      window.removeEventListener('beforeunload', unload);
      if (node.open) node.close();
      scrollLocks.delete(lock);
      if (!scrollLocks.size) {
        document.body.style.overflow = originalOverflow;
        if (pagePosition) window.scrollTo(...pagePosition);
        pagePosition = null;
      }
      for (const [ancestor, left, top] of priorScroll) {
        if (ancestor.isConnected) { ancestor.scrollLeft = left; ancestor.scrollTop = top; }
      }
      const priorDialog = prior?.closest?.('dialog');
      const openDialogs = [...document.querySelectorAll('dialog[open]')];
      const topDialog = [...scrollLocks].map(item=>item.node).filter(item=>item.open).at(-1) || openDialogs.at(-1);
      const canRestore = prior?.isConnected && (!priorDialog || priorDialog.open)
        && (!topDialog || topDialog.contains(prior)) && !prior.matches?.(':disabled') && prior.getClientRects().length;
      if (canRestore) prior.focus?.({ preventScroll: true });
      else (topDialog?.querySelector('[data-dialog-initial-focus], button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')
        || document.querySelector('[data-admin-section-heading]'))?.focus({ preventScroll: true });
    };
  }, [ref, open]);
  return close;
}
