export const REPORT_VIEW_FILTERS = Object.freeze(['seller', 'product', 'platform', 'carrier', 'status', 'account']);
export const REPORT_FILTERS = Object.freeze([...REPORT_VIEW_FILTERS, 'source']);
export const REPORT_FILTER_LABELS = Object.freeze({ seller:'Vendedor', product:'Producto u obsequio / combo', platform:'Plataforma', carrier:'Transportadora', status:'Estado', account:'Cuenta de caja o banco', source:'Origen de plataforma' });

export function reportViewFilters(view) {
  return Object.fromEntries(REPORT_VIEW_FILTERS.filter(key => view[key]).map(key => [key, view[key]]));
}
