'use client';

export default function OrderLineCosts({ items, value, onChange, renderAmount }) {
  const change = (index, patch) => onChange(value.map((line, position) => position === index ? { ...line, ...patch } : line));
  return value.map((line, index) => {
    const item = items.find(candidate => candidate.lineId === line.lineId);
    return <section className="form-section" key={line.lineId}>
      <label className="checkbox-field"><input type="checkbox" checked={line.selected} onChange={event => change(index, { selected: event.target.checked })}/>{item?.title || item?.productExternalKey || line.lineId}</label>
      {line.selected && (line.components?.length ? line.components.map((component, componentIndex) => renderAmount(`component-${line.lineId}-${component.productId}`, item?.components?.find(candidate => candidate.productId === component.productId)?.title || component.productId, component.unitCostMinor, unitCostMinor => change(index, { components: line.components.map((previous, position) => position === componentIndex ? { ...previous, unitCostMinor } : previous) }))) : renderAmount(`cost-${line.lineId}`, 'Costo unitario histórico (COP)', line.unitCostMinor, unitCostMinor => change(index, { unitCostMinor })))}
    </section>;
  });
}
