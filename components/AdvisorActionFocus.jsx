'use client';

import { useEffect } from 'react';

const controls = '[data-advisor-control],button,a[href],summary,input,select,textarea';
const normalize = value => value?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').replace(/\s+/g, ' ').trim() || '';
const visible = node => Boolean(node.getClientRects().length && !node.closest('[aria-hidden=true],[aria-busy=true],[hidden],[inert]') && !node.matches(':disabled,[aria-disabled=true]'));

function accessibleName(node) {
  const label = node.getAttribute('aria-label');
  if (label) return label;
  const ids = node.getAttribute('aria-labelledby');
  if (ids) return ids.split(/\s+/).map(id => node.ownerDocument.getElementById(id)?.textContent || '').join(' ');
  if (node.labels?.length) return [...node.labels].map(label => label.textContent).join(' ');
  return node.textContent;
}

export default function AdvisorActionFocus({ root, request, onSettled }) {
  useEffect(() => {
    if (!request || !root.current) return;
    const scope = root.current, shell = scope.closest('.admin-shell') || scope, key = normalize(request.focus);
    let complete = false, frame = 0, timer;
    const observer = new MutationObserver(schedule);
    function settle(found) {
      if (complete) return;
      complete = true;
      observer.disconnect();
      clearTimeout(timer);
      onSettled(request.id, found);
    }
    function check() {
      frame = 0;
      if (complete || !key) return;
      const drawer = shell.querySelector('dialog[open].editor-drawer');
      const candidates = Array.from((drawer || scope).querySelectorAll(controls));
      let marked = key === 'assistant-bound-proposal-native-save'
        ? candidates.filter(node => node.hasAttribute('data-assistant-bound-save'))
        : candidates.filter(node => normalize(node.dataset.advisorControl) === key);
      // A marked top-bar control can be focused from the workspace, never through an open editor.
      if (!drawer && !marked.length && shell !== scope) {
        marked = Array.from(shell.querySelectorAll('[data-advisor-control]')).filter(node => normalize(node.dataset.advisorControl) === key);
      }
      if (marked.length === 1) {
        const target = marked[0], disclosures = [];
        for (let parent = target.parentElement; parent && parent !== shell; parent = parent.parentElement) {
          if (parent.matches('details[data-advisor-disclosure]:not([open])') &&
              (parent.dataset.advisorDisclosure === 'open-on-summary' || !parent.querySelector(':scope > summary')?.contains(target))) disclosures.push(parent);
        }
        for (let index = disclosures.length - 1; index >= 0; index--) {
          if (visible(disclosures[index])) disclosures[index].open = true;
        }
      }
      const visibleMarked = marked.filter(visible);
      const matching = visibleMarked.length ? visibleMarked : candidates.filter(node => visible(node) && normalize(accessibleName(node)) === key);
      if (matching.length !== 1) return;
      const [target] = matching;
      target.focus({ preventScroll: true });
      if (document.activeElement !== target) return;
      if (!target.hasAttribute('data-advisor-arrival')) {
        target.setAttribute('data-advisor-arrival', '');
        target.addEventListener('blur', () => target.removeAttribute('data-advisor-arrival'), { once: true });
      }
      const tall = target.offsetHeight > document.documentElement.clientHeight / 2;
      target.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest', behavior: 'instant' });
      settle(true);
    }
    function schedule() {
      if (!complete && !frame) frame = requestAnimationFrame(check);
    }
    observer.observe(shell, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-advisor-control', 'data-assistant-bound-save', 'aria-label', 'aria-busy', 'disabled', 'aria-disabled', 'hidden', 'open'] });
    timer = setTimeout(() => settle(false), 4500);
    schedule();
    return () => {
      complete = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [root, request, onSettled]);
  return null;
}
