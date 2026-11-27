'use client';

import { useEffect, useRef, useState } from 'react';
import { HekaField, HekaValues, carrierLabel, isHekaId, noveltyLabel } from './HekaForms';
import { hekaEnvironment, useHekaInteraction } from './HekaPanel';
import styles from './HekaPanel.module.css';

const ROOT = '/api/admin/shipping/novelties';
const dateFormat = new Intl.DateTimeFormat('es-CO',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Bogota'});
const syncMessages = {
  disconnected: 'Heka oficial no está conectada. Los datos guardados quedan disponibles para consulta.',
  forbidden: 'Sin permiso para sincronizar novedades. Comprueba la llave oficial, el entorno y que la cuenta de Heka tenga el rol vendedor (seller).',
  rate_limited: 'Sondeo en pausa por límite de consultas. La bandeja conserva la última información disponible.',
  unavailable: 'No se pudo consultar Heka. Se conserva la última información disponible y se volverá a intentar.',
  scheduler_unavailable: 'El servicio de trabajos no está activo o no informa su estado. No se están recibiendo nuevas confirmaciones.',
  initializing: 'Se está cargando el historial inicial de Heka. Esta primera lectura no envía avisos antiguos.',
  stale: 'Sincronización atrasada. La bandeja conserva la última información disponible.',
  current: 'El sondeo de Heka está activo.',
};
const rowKey = ({guide}) => `${guide._id}:${guide.last_novelty._id}`;
const canSolve = guide => isHekaId(guide._id) && isHekaId(guide.last_novelty?._id) && ['in_novelty','in_review'].includes(guide.status_novelty);

function SyncStatus({sync}) {
  if (!sync) return null;
  const message = sync.errorCode==='HEKA_CUSTODY' && sync.active ? 'No está disponible la custodia de Heka. Restaura su llave privada original en el servicio de trabajos.' : sync.status==='current'&&sync.cadence==='webhook_daily'?'Webhook comprobado; la conciliación de respaldo es diaria.':syncMessages[sync.status];
  return <div role="status" aria-live="polite">
    <p><strong>Heka · {hekaEnvironment(sync.environment)}.</strong> {message}</p>
    {sync.active && sync.schedulerStatus!=='running' && sync.status!=='scheduler_unavailable' && <p>El servicio de trabajos tampoco informa actividad reciente.</p>}
    <p>Última lectura válida: {sync.lastSuccessAt ? <time dateTime={sync.lastSuccessAt}>{dateFormat.format(new Date(sync.lastSuccessAt))} (Bogotá)</time> : 'Sin registro'}.</p>
  </div>;
}

function NoveltyCard({row,solution,onSolution,onChoose,onReview,onMark,onOpenShipment,disabled,canReview,advisorTarget,anotherDraft,marking}) {
  const heading = useRef(null), {guide,unreadCount} = row, last = guide.last_novelty;
  const label = guide.guide_number ?? 'sin número informado';
  function submit(event) {
    event.preventDefault();
    if (!solution.trim() || disabled || !canReview) return;
    onReview('solveNovelty',{id:last._id,guideId:guide._id,solution:solution.trim()},
      {guide:guide.guide_number,message:last.message,replacing:guide.status_novelty==='in_review'});
  }
  return <li className={`settings-subform ${styles.card}`}>
    <h4 ref={heading} tabIndex={-1}>Guía {label}</h4>
    <HekaValues items={ [['Transportadora',carrierLabel(guide.distributor_id)],['Estado de la novedad',noveltyLabel(guide.status_novelty)],
      ['Motivo informado por Heka',last.message],['ID de novedad',last._id],['Origen',guide.city_origin],['Destino',guide.city_destination]] }/>
    {row.shipmentId&&<button type="button" className="button subtle" disabled={disabled||anotherDraft||!!solution} onClick={()=>onOpenShipment(row.shipmentId)}>Abrir envío local y revisar Caja</button>}
    {guide.movemens?.length>0 && <details className={styles.details}>
      <summary>Movimientos informados por Heka</summary>
      <p className="hint">Capturados con la última revisión registrada de esta novedad.</p>
      <ol>{guide.movemens.map((movement,index)=><li key={index}>{[movement.date,movement.label,movement.status,movement.code].filter(Boolean).join(' · ')}</li>)}</ol>
    </details>}
    {!!unreadCount && <div className="admin-actions">
      <span>{unreadCount===1 ? '1 aviso sin leer' : `${unreadCount} avisos sin leer`}</span>
      <button type="button" className="button subtle" disabled={disabled || anotherDraft || !!solution} aria-label={`Marcar como leída: Guía ${guide.guide_number ?? last._id}`} onClick={async () => {
        if (await onMark(row.eventId)) heading.current?.focus();
      }}>{marking ? 'Marcando…' : 'Marcar como leída'}</button>
    </div>}
    {canReview && <form aria-label={`Solucionar novedad: ${guide.guide_number ?? last._id}`} onSubmit={submit}>
      <fieldset className="editor-fieldset" disabled={disabled || anotherDraft}>
        <HekaField name="solution" type="textarea" label="Solución para Heka" data-advisor-control={advisorTarget?'heka-novelty-review':undefined}
          maxLength={2000} required value={solution} onFocus={onChoose} onChange={(_,value) => onSolution(value.replaceAll(/[\r\n\t]/g,' '))}/>
        <div className="admin-actions">
          <button type="submit" className="button subtle" disabled={!solution.trim()}>Revisar solución</button>
          {solution && <button type="button" className="button subtle" onClick={() => onSolution('')}>Descartar texto de solución</button>}
        </div>
      </fieldset>
    </form>}
  </li>;
}

export default function ShippingNovelties({api,config,busy,review,onRead,onOpenShipment,eventId,onClearEvent,pushControl,advisorFocus,onInteractionStateChange}) {
  const [state,setState] = useState(''), [page,setPage] = useState(1), [refresh,setRefresh] = useState(0);
  const [response,setResponse] = useState(null), [draft,setDraft] = useState(null), [chosen,setChosen] = useState(null), [marking,setMarking] = useState(null), [markError,setMarkError] = useState('');
  const mutation = useRef(null), suspended = useRef(false), editing = useRef(false);
  const queryKey = `${config?.version}:${config?.environment}:${eventId??''}:${state}:${page}`, dirty = Boolean(draft?.text);
  suspended.current = dirty || Boolean(marking) || busy;
  editing.current = dirty;
  useHekaInteraction(onInteractionStateChange,dirty,Boolean(marking));
  useEffect(() => () => { mutation.current?.abort(); mutation.current = null; },[]);
  useEffect(() => {
    const controller = new AbortController(), {signal} = controller;
    let requesting = false;
    async function load() {
      if (requesting) return;
      requesting = true;
      try {
        const params = eventId?new URLSearchParams({eventId}):new URLSearchParams({page:String(page),...(state?{state}:{})});
        const data = await api(`${ROOT}?${params}`,{signal});
        if (!signal.aborted && !editing.current && !mutation.current) setResponse({key:queryKey,data,error:''});
      } catch (error) {
        if (!signal.aborted) setResponse(previous => ({key:queryKey,data:previous?.key===queryKey?previous.data:null,error:error.message}));
      } finally { requesting = false; }
    }
    function updateVisible() {
      if (!suspended.current && document.visibilityState==='visible') void load();
    }
    void load();
    window.addEventListener('focus',updateVisible);
    document.addEventListener('visibilitychange',updateVisible);
    const interval = setInterval(updateVisible,30000);
    return () => {
      controller.abort();
      clearInterval(interval);
      window.removeEventListener('focus',updateVisible);
      document.removeEventListener('visibilitychange',updateVisible);
    };
  },[api,eventId,page,queryKey,refresh,state]);

  async function markRead(eventId) {
    if (mutation.current) return false;
    const controller = new AbortController();
    mutation.current = controller;
    setMarkError(''); setMarking(eventId);
    try {
      await api(ROOT,{method:'POST',body:JSON.stringify({eventId}),signal:controller.signal});
      if (controller.signal.aborted) return false;
      setResponse(current => current?.data && current.key===queryKey ? {...current,data:{...current.data,
        rows:current.data.rows.map(row=>row.eventId===eventId?{...row,unreadCount:0}:row)}} : current);
      setRefresh(current=>current+1);
      onRead?.();
      return true;
    } catch (error) {
      if (!controller.signal.aborted) setMarkError(error.message);
      return false;
    } finally {
      if (mutation.current===controller) { mutation.current = null; setMarking(null); }
    }
  }

  const current = response?.key===queryKey ? response : null, data = current?.data;
  const {rows=[],pager,sync} = data ?? {};
  const reviewCurrent = sync?.active && config?.configured && sync.environment===config.environment && sync.generation===config.version && sync.status!=='forbidden';
  const eligible = reviewCurrent ? rows.filter(row=>canSolve(row.guide)) : [];
  const advisorTarget = eligible.some(row=>rowKey(row)===chosen) ? chosen : !pager?.nextPage && !pager?.previousPage && eligible.length===1 ? rowKey(eligible[0]) : null;
  const disabled = Boolean(busy || marking), preventNavigation = disabled || dirty;
  function navigatePage(next) { setMarkError(''); setChosen(null); setPage(next); }
  return <section className="settings-card" aria-label="Novedades">
    <h3 tabIndex={-1} data-advisor-control="heka-novelty-search">Novedades</h3>
    <p>Leer un aviso no resuelve la novedad ni registra dinero en Caja. Solo una guía vinculada permite abrir las operaciones de Caja del envío.</p>
    <SyncStatus sync={sync}/>
    {pushControl}
    {eventId&&<button type="button" className="button subtle" disabled={preventNavigation} onClick={onClearEvent}>Ver todas las novedades</button>}
    {!eventId&&<div className="admin-actions">
      <label className="field">Estado de la novedad <select value={state} disabled={preventNavigation} onChange={event => { setState(event.target.value); navigatePage(1); }}>
        <option value="">Todas</option><option value="pending">Pendientes</option><option value="review">En revisión o gestión</option><option value="resolved">Resueltas</option>
      </select></label>
      <button type="button" className="button subtle" disabled={preventNavigation} onClick={() => setRefresh(current=>current+1)}>Actualizar bandeja</button>
    </div>}
    {advisorFocus==='heka-novelty-review' && !advisorTarget && rows.length>0 && <p className="hint">Elige la novedad exacta antes de preparar una solución.</p>}
    {dirty && <p className="hint">Revisa o descarta el texto de solución antes de cambiar de página o filtro.</p>}
    {current?.error && <p className="error" role="alert">No se pudo actualizar la bandeja. {current.error}</p>}
    {markError && <p className="error" role="alert">No se pudo marcar el aviso como leído. {markError}</p>}
    {!current && <p role="status">Cargando novedades guardadas…</p>}
    {data && !rows.length && <p role="status">{eventId?'Este aviso ya no pertenece a la bandeja actual.':pager.page>1 ? 'Ya no hay novedades en esta página.' : state ? 'No hay novedades con este estado.' : 'Todavía no hay novedades guardadas.'}</p>}
    {!!rows.length && <ul className={styles.cards}>{rows.map(row => {
      const key = rowKey(row), solution = draft?.key===key ? draft.text : '';
      return <NoveltyCard key={key} row={row} solution={solution} onSolution={text=>setDraft(text?{key,text}:null)} onChoose={()=>setChosen(key)}
        onReview={review} onMark={markRead} onOpenShipment={onOpenShipment} disabled={disabled} canReview={reviewCurrent && canSolve(row.guide)}
        advisorTarget={advisorTarget===key} anotherDraft={dirty && draft.key!==key} marking={marking===row.eventId}/>;
    })}</ul>}
    {pager && (pager.pages>1 || pager.page>1) && <nav className="admin-actions" aria-label="Páginas de novedades">
      <button type="button" className="button subtle" disabled={preventNavigation || !pager.previousPage} onClick={() => navigatePage(pager.previousPage)}>Anterior</button>
      <span aria-live="polite">Página {pager.page} de {Math.max(pager.pages,pager.page)} · {pager.total} novedades</span>
      <button type="button" className="button subtle" disabled={preventNavigation || !pager.nextPage} onClick={() => navigatePage(pager.nextPage)}>Siguiente</button>
    </nav>}
  </section>;
}
