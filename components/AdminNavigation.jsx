'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { adminAreas, adminSections } from '@/lib/admin-view.mjs';
import { adminTaskGroups, adminTasks, adminLocationLabel, isCurrentAdminTask } from './admin-tasks.mjs';
import { schemas } from '@/lib/schema.mjs';
import Icon from './Icons';
import ImageByUrl from './ImageByUrl';
import useDialog from './useDialog';
import WorkspaceTabs from './WorkspaceTabs';

const quickSections = adminAreas.filter(section => ['home', 'orders', 'cash'].includes(section.id));
const createActions = [
  ...Object.entries(schemas).map(([kind, schema]) => ({ kind, label: `Crear ${schema.singular}`, icon: 'plus' })),
  { kind: 'orders', label: 'Nuevo pedido', icon: 'plus' },
];
const productDestinations = adminTaskGroups.find(group => group.id === 'products').tasks;
const productViews = productDestinations.map(task => ({ id: task.id, label: task.id === 'products' ? 'Productos' : task.label }));
const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim();
const taskSearchText = new Map(adminTasks.map(task => {
  const section = adminSections.find(section => section.id === task.view.section);
  return [task.id, normalize(`${task.label} ${task.action || ''} ${task.group} ${section?.label || ''} ${section?.group || ''} ${task.description} ${task.view.section}`)];
}));

export function TaskDirectory({ view, onNavigate, interactionLocked = false }) {
  const id = useId();
  return <div className="task-directory-grid">
    {adminTaskGroups.map(group => <section className="task-directory-group" key={group.id} aria-labelledby={`${id}-${group.id}`}>
      <header><span className="task-group-icon" aria-hidden="true"><Icon name={group.icon} /></span><div>
        <h3 id={`${id}-${group.id}`}>{group.label}</h3><p>{group.description}</p>
      </div></header>
      <ul>{group.tasks.map(task => <li key={task.id}><button type="button" disabled={interactionLocked}
        aria-label={task.label} aria-describedby={`${id}-${task.id}-help`} data-admin-task={task.id}
        aria-current={isCurrentAdminTask(task, view) ? 'page' : undefined}
        onClick={() => onNavigate(task.view)}>
        <span><strong>{task.label}</strong><small id={`${id}-${task.id}-help`}>{task.description}</small></span><Icon name="chevron" size={16} />
      </button></li>)}</ul>
    </section>)}
  </div>;
}

function GroupedNavigation({ view, onNavigate, interactionLocked }) {
  const area = adminSections.find(section => section.id === view.section)?.area;
  return <nav aria-label="Administración" className="primary-navigation">
    {adminAreas.map(section => <button
      type="button" key={section.id} disabled={interactionLocked}
      aria-current={area === section.id ? 'page' : undefined}
      onClick={() => onNavigate({ section: section.id })}
    ><Icon name={section.icon} size={20} /><span>{section.label}</span></button>)}
  </nav>;
}

// AreaNavigation({view,onNavigate,interactionLocked}): real section destinations;
// onNavigate receives a new view, using the same guarded navigation as the sidebar.
export function AreaNavigation({ view, onNavigate, interactionLocked = false }) {
  const area = adminSections.find(section => section.id === view.section)?.area;
  if (area !== 'products') return null;
  const value = view.section === 'products' && view.productType === 'gift' ? 'gifts' : view.section;
  return <WorkspaceTabs label="Vistas de productos" items={productViews} value={value} disabled={interactionLocked}
    onChange={id => {
      if (!interactionLocked) onNavigate(productDestinations.find(task => task.id === id).view);
    }} />;
}

function Account({ user, onSignOut, interactionLocked }) {
  return <div className="sidebar-bottom">
    <div className="user-avatar" aria-hidden="true">AN</div>
    <div><strong>Administrador</strong><span>{user.email}</span></div>
    <button type="button" className="icon-button" disabled={interactionLocked}
      aria-label="Cerrar sesión" title="Cerrar sesión" onClick={onSignOut}>
      <Icon name="logout" size={20} />
    </button>
  </div>;
}

function NavigationMenu({ view, user, onNavigate, onSignOut, onClose, interactionLocked }) {
  const ref = useRef(null);
  const titleId = useId();
  function dismiss() {
    ref.current?.close();
    onClose();
  }
  const close = useDialog(ref, { busy: false, dirty: false, onClose: dismiss });
  function select(nextView) {
    if (interactionLocked) return;
    dismiss();
    onNavigate(nextView);
  }
  function signOut() {
    if (interactionLocked) return;
    dismiss();
    onSignOut();
  }
  return <dialog ref={ref} className="navigation-dialog" aria-labelledby={titleId}>
    <header>
      <h2 id={titleId} tabIndex={-1} data-dialog-initial-focus>Todas tus secciones</h2>
      <button type="button" className="icon-button" aria-label="Cerrar menú" onClick={close}>
        <Icon name="close" />
      </button>
    </header>
    <div className="navigation-dialog-body">
      <GroupedNavigation view={view} onNavigate={select} interactionLocked={interactionLocked} />
      <details className="navigation-task-directory">
        <summary>Todas las tareas</summary>
        <TaskDirectory view={view} onNavigate={select} interactionLocked={interactionLocked} />
      </details>
      <Account user={user} onSignOut={signOut} interactionLocked={interactionLocked} />
    </div>
  </dialog>;
}

function NavigationLauncher({ view, onNavigate, onCreate, onClose, interactionLocked }) {
  const ref = useRef(null);
  const titleId = useId();
  const inputId = useId();
  const helpId = useId();
  const inputRef = useRef(null);
  const resultsRef = useRef(null);
  const [query, setQuery] = useState('');
  function dismiss() {
    ref.current?.close();
    onClose();
  }
  const close = useDialog(ref, { busy: false, dirty: false, onClose: dismiss });
  const search = normalize(query);
  const destinations = adminTasks.filter(task => taskSearchText.get(task.id).includes(search));
  const actions = createActions.filter(action => normalize(action.label).includes(search));
  function select(callback, value) {
    if (interactionLocked) return;
    dismiss();
    callback(value);
  }
  function enabledResults() {
    return resultsRef.current?.querySelectorAll('button:not(:disabled)') || [];
  }
  function focusResult(button) {
    button?.focus();
    button?.scrollIntoView({ block: 'nearest' });
  }
  function inputKeyDown(event) {
    if (event.nativeEvent.isComposing || interactionLocked) return;
    const results = enabledResults();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusResult(results[event.key === 'ArrowDown' ? 0 : results.length - 1]);
    } else if (event.key === 'Enter' && search && results.length) {
      event.preventDefault();
      results[0].click();
    }
  }
  function resultKeyDown(event) {
    if (event.nativeEvent.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const button = event.target.closest('button');
    if (!button) return;
    const results = enabledResults();
    const index = Array.prototype.indexOf.call(results, button);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && index === 0) inputRef.current?.focus();
    else {
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? results.length - 1
        : event.key === 'ArrowUp' ? index - 1 : Math.min(index + 1, results.length - 1);
      focusResult(results[nextIndex]);
    }
  }
  return <dialog ref={ref} className="navigation-dialog launcher-dialog" aria-labelledby={titleId}>
    <header>
      <h2 id={titleId} tabIndex={-1}>Ir a…</h2>
      <button type="button" className="icon-button" aria-label="Cerrar lanzador" onClick={close}>
        <Icon name="close" />
      </button>
    </header>
    <div className="navigation-dialog-body">
      <label className="field" htmlFor={inputId}>Buscar sección o acción
        <input ref={inputRef} id={inputId} name="admin-destination" type="text" value={query}
          data-dialog-initial-focus autoComplete="off" aria-describedby={helpId}
          onKeyDown={inputKeyDown} onChange={event => setQuery(event.target.value)} />
      </label>
      <p className="launcher-help" id={helpId}>Usa las flechas para recorrer resultados, Enter para abrir y Esc para cerrar.</p>
      <p className="launcher-count" role="status">{destinations.length + actions.length} resultados</p>
      <div ref={resultsRef} className="launcher-results" onKeyDown={resultKeyDown}>
        {destinations.length > 0 && <section className="nav-group" aria-label="Tareas">
          <h3>Tareas · {destinations.length}</h3>
          {destinations.map(task => <button type="button" key={task.id} disabled={interactionLocked}
            aria-label={task.label} data-admin-task={task.id}
            aria-current={isCurrentAdminTask(task, view) ? 'page' : undefined}
            onClick={() => select(onNavigate, task.view)}>
            <Icon name={task.icon} /><span><strong>{task.label}</strong><small>{task.group} · {task.description}</small></span>
          </button>)}
        </section>}
        {actions.length > 0 && <section className="nav-group" aria-label="Acciones">
          <h3>Acciones</h3>
          {actions.map(action => <button type="button" key={action.kind} disabled={interactionLocked}
            onClick={() => select(onCreate, action.kind)}>
            <Icon name={action.icon} /><span>{action.label}</span>
          </button>)}
        </section>}
        {!destinations.length && !actions.length && <p>No encontramos esa sección o acción. Prueba con otro nombre.</p>}
      </div>
    </div>
  </dialog>;
}

function KeyboardShortcuts({ shortcut, onClose }) {
  const ref = useRef(null);
  const titleId = useId();
  function dismiss() {
    ref.current?.close();
    onClose();
  }
  const close = useDialog(ref, { busy: false, dirty: false, onClose: dismiss });
  return <dialog ref={ref} className="navigation-dialog shortcuts-dialog" aria-labelledby={titleId}>
    <header>
      <h2 id={titleId} tabIndex={-1} data-dialog-initial-focus>Atajos de teclado</h2>
      <button type="button" className="icon-button" aria-label="Cerrar atajos" onClick={close}><Icon name="close" /></button>
    </header>
    <div className="navigation-dialog-body">
      <dl className="shortcuts-list">
        <div><dt><kbd>{shortcut === '⌘ K' ? '⌘' : 'Ctrl'}</kbd> + <kbd>K</kbd></dt><dd>Abrir «Ir a…» fuera de campos editables y diálogos.</dd></div>
        <div><dt><kbd>Tab</kbd> / <kbd>Mayús</kbd> + <kbd>Tab</kbd></dt><dd>Recorrer los controles hacia delante o atrás.</dd></div>
        <div><dt><kbd>↑</kbd> / <kbd>↓</kbd></dt><dd>Recorrer los resultados del buscador.</dd></div>
        <div><dt><kbd>Inicio</kbd> / <kbd>Fin</kbd></dt><dd>Ir al primer o último resultado desde la lista.</dd></div>
        <div><dt><kbd>Enter</kbd></dt><dd>Abrir el resultado enfocado o el primero si has escrito una búsqueda.</dd></div>
        <div><dt><kbd>Espacio</kbd></dt><dd>Activar el botón enfocado.</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Cerrar el diálogo cuando no hay una operación en curso.</dd></div>
      </dl>
      <p>Si hay cambios sin guardar, se pide confirmación antes de descartarlos al cerrar o cambiar de vista.</p>
    </div>
  </dialog>;
}

export default function AdminNavigation({ view, user, onNavigate, onCreate, onSignOut, interactionLocked }) {
  const [dialog, setDialog] = useState(null);
  const [shortcut, setShortcut] = useState('Ctrl K');
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform)) setShortcut('⌘ K');
  }, []);
  useEffect(() => {
    function openShortcut(event) {
      if (event.isComposing || event.repeat || event.altKey || event.shiftKey
        || !(event.ctrlKey || event.metaKey) || (event.ctrlKey && event.metaKey) || event.key.toLowerCase() !== 'k') return;
      if (interactionLocked || document.querySelector('dialog[open]')) return;
      const target = document.activeElement;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
      event.preventDefault();
      setDialog('launcher');
    }
    document.addEventListener('keydown', openShortcut);
    return () => document.removeEventListener('keydown', openShortcut);
  }, [interactionLocked]);
  function openDialog(nextDialog) {
    if (!interactionLocked && !dialog && !document.querySelector('dialog[open]')) setDialog(nextDialog);
  }
  function navigate(nextView) {
    if (!interactionLocked) onNavigate(nextView);
  }
  const closeDialog = () => setDialog(null);
  const activeArea = adminSections.find(section => section.id === view.section)?.area;
  const secondarySection = !quickSections.some(section => section.id === activeArea);
  return <>
    <a className="admin-skip-link" href="#admin-workspace">Saltar al contenido</a>
    <aside className="admin-sidebar">
      <button type="button" className="admin-brand" disabled={interactionLocked}
        aria-label="All Nutrition, ir al Inicio" onClick={() => navigate({ section: 'home' })}>
        <ImageByUrl src="/brand/logo.jpg" alt="" width={44} height={44} />
        <span>ALL NUTRITION<small>Mesa de trabajo</small></span>
      </button>
      <GroupedNavigation view={view} onNavigate={navigate} interactionLocked={interactionLocked} />
      <Account user={user} onSignOut={onSignOut} interactionLocked={interactionLocked} />
    </aside>
    <header className="admin-topbar">
      <button type="button" className="admin-brand" disabled={interactionLocked}
        aria-label="All Nutrition, ir al Inicio" onClick={() => navigate({ section: 'home' })}>
        <ImageByUrl src="/brand/logo.jpg" alt="" width={44} height={44} />
      </button>
      <p className="topbar-location"><span>Administración</span><Icon name="chevron" size={14} /><strong>{view.section === 'business' && (!view.tab || view.tab === 'setup') ? 'Configuración' : adminLocationLabel(view)}</strong></p>
      <div className="topbar-actions">
        <button type="button" className="button subtle launcher-trigger" disabled={interactionLocked}
          aria-haspopup="dialog" aria-expanded={dialog === 'launcher'} aria-keyshortcuts={shortcut === '⌘ K' ? 'Meta+K' : 'Control+K'}
          onClick={() => openDialog('launcher')}>
          <Icon name="search" size={18} /><span>Ir a…</span><kbd className="launcher-shortcut">{shortcut}</kbd>
        </button>
        <button type="button" className="button subtle shortcuts-trigger" disabled={interactionLocked}
          aria-haspopup="dialog" aria-expanded={dialog === 'shortcuts'} onClick={() => openDialog('shortcuts')}>Atajos</button>
        <a className="button subtle preview-link" href="/?preview=1" target="_blank" rel="noopener noreferrer"
          aria-label="Ver mi página (abre en otra pestaña)">
          <span className="preview-link-label">Ver mi página</span><Icon name="external" size={18} />
        </a>
      </div>
    </header>
    <nav className="admin-bottom-nav" aria-label="Administración">
      {quickSections.map(section => <button type="button" key={section.id} disabled={interactionLocked}
        aria-current={activeArea === section.id ? 'page' : undefined}
        onClick={() => navigate({ section: section.id })}>
        <Icon name={section.icon} /><span>{section.label}</span>
      </button>)}
      <button type="button" className={secondarySection ? 'active' : undefined} disabled={interactionLocked}
        aria-haspopup="dialog" aria-expanded={dialog === 'menu'} onClick={() => openDialog('menu')}>
        <Icon name="menu" /><span>Más</span>
      </button>
    </nav>
    {dialog === 'menu' && <NavigationMenu view={view} user={user} onNavigate={onNavigate}
      onSignOut={onSignOut} onClose={closeDialog} interactionLocked={interactionLocked} />}
    {dialog === 'launcher' && <NavigationLauncher view={view} onNavigate={onNavigate} onCreate={onCreate}
      onClose={closeDialog} interactionLocked={interactionLocked} />}
    {dialog === 'shortcuts' && <KeyboardShortcuts shortcut={shortcut} onClose={closeDialog} />}
  </>;
}
