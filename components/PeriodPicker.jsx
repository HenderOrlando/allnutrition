'use client';
import { useEffect, useId, useState } from 'react';
import { addDays, bogotaDate, businessDate, periodBounds } from '@/lib/business/dates.mjs';

export const REPORT_PERIOD_LABELS = { day: 'Diario', week: 'Semanal', month: 'Mensual', quarter: 'Trimestral', halfyear: 'Semestral', year: 'Anual' };
export function reportDateLabel(value) {
  if (!value) return 'Sin fecha';
  const parts = value.slice(0, 10).split('-');
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export default function PeriodPicker({ period = 'month', anchor, onChange, disabled = false }) {
  const id = useId(), date = anchor || bogotaDate();
  const [draft, setDraft] = useState(date);
  useEffect(() => { setDraft(date); }, [date]);
  let bounds, previous, next;
  try {
    bounds = periodBounds(period, date);
    previous = periodBounds(period, addDays(bounds.startDate, -1)).startDate;
    next = periodBounds(period, bounds.endDateExclusive).startDate;
  } catch { /* A calendar boundary has no adjacent supported period. */ }
  function chooseDate(value) {
    setDraft(value);
    try { businessDate(value); periodBounds(period, value); onChange({ period, anchor: value }); } catch { /* Native date entry may be temporarily incomplete. */ }
  }
  return <fieldset className="report-period" disabled={disabled}>
    <legend>Período</legend>
    <label htmlFor={`${id}-period`}>Frecuencia<select id={`${id}-period`} value={period} onChange={event => onChange({ period: event.target.value, anchor: date })}>{Object.entries(REPORT_PERIOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label htmlFor={`${id}-anchor`}>Fecha de referencia<input id={`${id}-anchor`} type="date" min="0001-01-01" max="9998-12-31" required value={draft} onChange={event => chooseDate(event.target.value)} onBlur={() => setDraft(date)}/></label>
    <div className="report-period-arrows"><button className="button subtle" type="button" disabled={!previous} aria-label="Período anterior" onClick={() => onChange({ period, anchor: previous })}>Anterior</button><button className="button subtle" type="button" disabled={!next} aria-label="Período siguiente" onClick={() => onChange({ period, anchor: next })}>Siguiente</button></div>
    {bounds && <p className="small muted report-period-range">Del {reportDateLabel(bounds.startDate)} al {reportDateLabel(addDays(bounds.endDateExclusive, -1))} · America/Bogota</p>}
  </fieldset>;
}
