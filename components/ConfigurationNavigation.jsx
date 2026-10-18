'use client';

import { useId } from 'react';
import { adminTaskGroups, isCurrentAdminTask } from './admin-tasks.mjs';
import Icon from './Icons';
import styles from './ConfigurationExperience.module.css';

const businessTasks = adminTaskGroups.find(group => group.id === 'business').tasks;
const storefrontTasks = adminTaskGroups.find(group => group.id === 'storefront').tasks;
const setupTask = businessTasks.find(task => task.id === 'setup');
const groups = [
  { id: 'business', title: 'Operación del negocio', description: 'Personas, cuentas y reglas internas.', icon: 'settings', tasks: businessTasks.filter(task => !['setup', 'users'].includes(task.id)) },
  { id: 'storefront', title: 'Vitrina pública', description: 'Contenido para clientes, no campañas ni seguimiento de guías.', icon: 'edit', tasks: storefrontTasks },
  { id: 'access', title: 'Acceso al panel', description: 'Usuarios que pueden administrar, distintos de las personas responsables.', icon: 'users', tasks: businessTasks.filter(task => task.id === 'users') },
];
const tasks = [setupTask, ...groups.flatMap(group => group.tasks)];

export default function ConfigurationNavigation({ view, onNavigate, interactionLocked = false }) {
  const id = useId();
  const current = tasks.find(task => isCurrentAdminTask(task, view));
  const home = current?.id === 'setup';
  if (!home) return <nav className={styles.navigation} aria-label="Vistas de configuración">
    <button type="button" className="button subtle" disabled={interactionLocked} onClick={() => onNavigate(setupTask.view)}>
      <span className={styles.backIcon} aria-hidden="true"><Icon name="chevron" size={16}/></span>Volver a Configuración
    </button>
    <label className={styles.taskSwitch} htmlFor={`${id}-task`}>Cambiar de tarea
      <select id={`${id}-task`} value={current?.id || 'setup'} disabled={interactionLocked} onChange={event => onNavigate(tasks.find(task => task.id === event.target.value).view)}>
        <option value="setup">Todas las tareas de Configuración</option>
        {groups.map(group => <optgroup key={group.id} label={group.title}>{group.tasks.map(task => <option key={task.id} value={task.id}>{task.label}</option>)}</optgroup>)}
      </select>
    </label>
  </nav>;

  return <nav className={styles.directory} aria-label="Vistas de configuración">
    <div className={styles.directoryHeading}><h2>¿Qué necesitas configurar?</h2></div>
    <div className={styles.directoryGrid}>
      {groups.map(group => <section className={`${styles.group} ${styles[group.id]}`} key={group.id} aria-labelledby={`${id}-${group.id}`}>
        <header><span className={styles.groupIcon} aria-hidden="true"><Icon name={group.icon}/></span><div><h3 id={`${id}-${group.id}`}>{group.title}</h3><p>{group.description}</p></div></header>
        <ul>{group.tasks.map(task => <li key={task.id}><button type="button" disabled={interactionLocked} data-configuration-task={task.id} aria-labelledby={`${id}-${task.id}-label`} aria-describedby={`${id}-${task.id}-help`} onClick={() => onNavigate(task.view)}>
          <span><strong id={`${id}-${task.id}-label`}>{task.action}</strong><small id={`${id}-${task.id}-help`}>{task.description}</small></span><Icon name="chevron" size={16}/>
        </button></li>)}</ul>
      </section>)}
    </div>
    <div className={styles.getStarted}><div><strong>¿Estás empezando?</strong><p>Revisa responsables, cuentas y reglas iniciales con el asistente. Es opcional.</p></div><button type="button" className="button subtle" disabled={interactionLocked} data-configuration-task="setup" onClick={() => { const heading = document.getElementById('configuration-setup'); heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'start' }); }}>Revisar primeros pasos<Icon name="chevron" size={16}/></button></div>
  </nav>;
}
