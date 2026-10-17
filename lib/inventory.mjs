/** Physical inventory is private. Availability is the only inventory fact exposed publicly. */
export function stockAvailable(item, products = []) {
  const composed = item.productType === 'gift' || item.kind === 'combos' || Boolean(item.items?.length);
  if (!composed) return item.stockQuantity == null ? null : Math.max(0, item.stockQuantity - (item.stockReserved || 0));
  if (!item.items?.length) return 0;
  const byId = products instanceof Map ? products : new Map(products.map(product => [product.id, product]));
  let available = Number.MAX_SAFE_INTEGER, unknown = false;
  for (const component of item.items) {
    const product = byId.get(component.productId);
    if (!product || product.productType === 'gift' || !(product.orderable ?? product.status === 'published')) return 0;
    const quantity = stockAvailable(product);
    if (quantity == null) { unknown = true; continue; }
    available = Math.min(available, Math.floor(quantity / component.quantity));
    if (!available) return 0;
  }
  return unknown ? null : available;
}

export function inventoryAvailability(item, products = []) {
  if (item.orderable === false) return 'soldout';
  const available = stockAvailable(item, products);
  return available == null ? 'consult' : available > 0 ? 'available' : 'soldout';
}
