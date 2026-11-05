'use client';

import styles from './OrderExperience.module.css';

const STATES = {
  uploaded: 'Archivo recibido',
  previewing: 'Preparando revisión',
  review: 'Por revisar',
  queued: 'Importación en cola',
  applying: 'Importando',
  completed: 'Importación completada',
  completed_with_errors: 'Importación parcial: quedan pendientes',
  failed: 'Requiere corrección',
  expired: 'Archivo vencido',
  cancelled: 'Importación cancelada',
};
const dateFormat = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' });
function dateLabel(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? dateFormat.format(date) : 'Fecha no disponible';
}
function actionLabel(state) {
  if (state === 'queued' || state === 'applying') return 'Ver progreso';
  if (state === 'failed' || state === 'completed_with_errors') return 'Revisar pendientes';
  if (['completed', 'cancelled', 'expired'].includes(state)) return 'Ver resultado';
  return 'Continuar';
}

export default function ImportHistory({resource, options, view, onFilter, onPage, onOpen, onNew, onRetry, onRetryOptions, onManageSources}) {
  const {data, loading, error} = resource;
  const {platforms = [], sources = []} = options;
  const source = view.source || '';
  const status = view.status || '';
  const filtered = !!(source || status);
  const records = data?.records || [];
  const page = data?.page || Number(view.page) || 1;
  const pages = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || 1)));
  const stale = !!data && !!(loading || error);
  const clear = () => onFilter({source: '', status: ''});

  return <section aria-label="Importaciones" aria-busy={loading}>
    <header className={styles.taskHeading}>
      <div><h2 data-import-history-heading tabIndex={-1}>Importaciones</h2><p>Continúa una importación guardada o consulta su progreso y resultado.</p></div>
      <div className="admin-actions">
        <button type="button" className="button primary" onClick={onNew}>Nueva importación</button>
        <button type="button" className="button subtle" onClick={onManageSources}>Administrar orígenes y configuraciones</button>
      </div>
    </header>
    <div className="form-grid" role="group" aria-label="Filtros de importaciones">
      <label className="field">Origen<select value={source} onChange={event => onFilter({source: event.target.value, status})}>
        <option value="">Todos</option>
        {source && !sources.some(item => item.id === source) && <option value={source}>Origen no disponible</option>}
        {sources.map(item => <option key={item.id} value={item.id}>{platforms.find(platform => platform.id === item.platformId)?.name || 'Plataforma no disponible'} · {item.name}{item.active === false ? ' · Archivado' : ''}</option>)}
      </select></label>
      <label className="field">Estado<select value={status} onChange={event => onFilter({source, status: event.target.value})}>
        <option value="">Todos</option>
        {Object.entries(STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
    {filtered && <button type="button" className="button subtle" onClick={clear}>Limpiar filtros</button>}
    {options.loading && <p role="status">Actualizando nombres de orígenes y plataformas…</p>}
    {options.error && <div className="error" role="alert"><p>No se pudieron actualizar los orígenes y plataformas. Los nombres anteriores, si los hay, se conservan.</p><p>{options.error.message || String(options.error)}</p><button type="button" className="button subtle" onClick={onRetryOptions}>Reintentar opciones</button></div>}
    {loading && <p role="status">{data ? 'Actualizando importaciones…' : 'Cargando importaciones…'}</p>}
    {error && <div className="error" role="alert"><p>No se pudieron cargar las importaciones.</p><p>{error.message || String(error)}</p><button type="button" className="button subtle" onClick={onRetry}>Volver a cargar importaciones</button></div>}
    {stale && <p role="status">Los resultados visibles son de la consulta anterior; no representan una respuesta actualizada de los filtros seleccionados.</p>}
    {!loading && !error && data && !records.length && <div className={styles.importProposal}>
      <h3>{data.total > 0 ? 'Esta página ya no tiene importaciones' : filtered ? 'No hay importaciones con estos filtros' : 'Todavía no has importado archivos'}</h3>
      {data.total > 0 ? <p>Usa la paginación para volver a las importaciones disponibles.</p> : filtered ? <button type="button" className="button subtle" onClick={clear}>Limpiar filtros</button> : <><p>Empieza con tu archivo Excel. También puedes descargar la plantilla desde las acciones de importación.</p><button type="button" className="button primary" onClick={onNew}>Nueva importación</button></>}
    </div>}
    <div aria-label={stale ? 'Importaciones de la consulta anterior' : 'Importaciones guardadas'}>
      {records.map(item => {
        const origin = sources.find(candidate => candidate.id === item.sourceId);
        const platform = platforms.find(candidate => candidate.id === (item.platformId || origin?.platformId));
        return <article className={styles.importProposal} key={item.id}>
          <h3>{item.filename || 'Sin archivo guardado'}</h3>
          <p>{platform?.name || 'Plataforma no disponible'} · {origin?.name || 'Origen no disponible'}</p>
          <p><time dateTime={item.createdAt || undefined}>{dateLabel(item.createdAt)}</time> · Hora de Bogotá</p>
          <p><strong>{STATES[item.state] || 'Estado no disponible'}</strong></p>
          <button type="button" className="button subtle" onClick={() => onOpen(item.id)}>{actionLabel(item.state)}</button>
          <details><summary>Detalles técnicos y retención</summary>
            <p>ID: {item.id}</p>
            <p>{item.fileDiscarded ? 'Archivo original descartado.' : item.fileExpired || item.state === 'expired' ? 'El archivo original ya no está disponible por vencimiento.' : item.expiresAt ? `Retención hasta ${dateLabel(item.expiresAt)} (hora de Bogotá).` : 'Fecha de retención no disponible.'}</p>
          </details>
        </article>;
      })}
    </div>
    {data && <nav className="admin-actions" aria-label="Páginas de importaciones">
      <button type="button" className="button subtle" disabled={page <= 1 || loading || !!error} onClick={() => onPage(page - 1)}>Anterior</button>
      <span>Página {page} de {pages} · {data.total} importaciones{stale ? ' · Consulta anterior' : ''}</span>
      <button type="button" className="button subtle" disabled={page >= pages || loading || !!error} onClick={() => onPage(page + 1)}>Siguiente</button>
    </nav>}
  </section>;
}
