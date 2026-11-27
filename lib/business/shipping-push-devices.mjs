export const SHIPPING_PUSH_COOKIE = '__Host-allnutrition_shipping_device';
const DEVICE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const shippingPushDeviceId = value => typeof value === 'string' && DEVICE.test(value) ? value : null;

export async function discardShippingPushDeliveriesTx(tx, id) {
  await tx.db.run(`UPDATE ${tx.t('shipping_push_deliveries')} SET state='discarded',lease_id=NULL,lease_until=NULL WHERE subscription_id=? AND state='pending'`, [id]);
}

export async function disableShippingPushDeviceTx(tx, userId, device, now) {
  const id = shippingPushDeviceId(device);
  if (!id) return;
  const { changes } = await tx.db.run(`UPDATE ${tx.t('shipping_push_subscriptions')} SET disabled_at=?,updated_at=? WHERE id=? AND user_id=? AND disabled_at IS NULL`, [now, now, id, userId]);
  if (changes) await discardShippingPushDeliveriesTx(tx, id);
}
