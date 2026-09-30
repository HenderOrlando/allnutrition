import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { openStore } from '../../lib/db/index.mjs';
import { databaseConfig } from '../../lib/db/config.mjs';
import { login, getSession } from '../../lib/auth.mjs';
import { productData, orderData } from '../contract.mjs';

const command = process.argv[2];
const snapshotFile = '/artifacts/operational.json';
function ensure(condition, message) { if (!condition) throw new Error(message); }

async function rejectConnection(connectionString, ssl, expectedCodes) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString, ssl, connectionTimeoutMillis: 10000 });
  let code;
  try { await client.connect(); }
  catch (error) { code = error.code; }
  finally { await client.end(); }
  ensure(expectedCodes.includes(code), 'La conexión insegura no fue rechazada por el motivo TLS/HBA requerido.');
}

let store;
try {
  ensure(['prepare', 'assert', 'reject-insecure'].includes(command), 'Comando esperado: prepare, assert o reject-insecure.');
  ensure(process.env.TEST_ALLOW_DATABASE_RESET === 'allnutrition_test', 'Operación Docker no autorizada para esta base.');
  const config = databaseConfig();
  const allowed = command === 'assert' ? ['allnutrition_test', 'allnutrition_restore'] : ['allnutrition_test'];
  ensure(config.provider === 'supabase' && allowed.includes(new URL(config.url).pathname.slice(1)), 'Operaciones limitadas a la base descartable de prueba/restore.');
  store = await openStore(process.env, { migrate: true });
  const connection = await store.db.get('SELECT current_database() AS name, current_user AS role, ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
  ensure(allowed.includes(connection?.name), 'La base real no coincide con la guarda de prueba/restore.');
  ensure(connection.role === 'allnutrition_app' && connection.ssl === true, 'La operación requiere rol runtime limitado y TLS verificado.');

  if (command === 'prepare') {
    const session = await login(store, 'e2e@example.test', 'clave-e2e-solo-pruebas');
    const product = await store.save('products', productData({ slug: 'docker-verification', image: '/brand/creatina-vital-force.jpg', price: 55000 }));
    const payload = orderData(product);
    payload.items[0].quantity = 2;
    const order = await store.saveOrder(payload, session.user.id);
    ensure(order.total === 119000 && order.subtotal === 110000 && order.shippingCost === 9000, 'Total operativo incorrecto: se requieren 119000 pesos.');
    const counter = await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='orders'`);
    const account = await store.db.get(`SELECT id,email,password,active FROM ${store.t('users')} WHERE id=?`, [session.user.id]);
    const snapshot = { product, payload, actor: session.user.id, order, session, account, counter: counter.value, orderCount: (await store.orders()).length };
    writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log('Snapshot operativo privado creado: pedido de 119000, historial, cuenta, sesión e idempotencia.');
  } else if (command === 'assert') {
    const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    ensure(isDeepStrictEqual(await store.get('products', snapshot.product.id), snapshot.product), 'El producto persistido difiere del snapshot.');
    ensure(isDeepStrictEqual(await store.order(snapshot.order.id), snapshot.order), 'El pedido, número, versión, total o historial difiere del snapshot.');
    const session = await getSession(store, snapshot.session.token);
    ensure(isDeepStrictEqual(session, { csrf: snapshot.session.csrf, expires: snapshot.session.expires, user: snapshot.session.user }), 'La sesión persistida dejó de ser válida.');
    const account = await store.db.get(`SELECT id,email,password,active FROM ${store.t('users')} WHERE id=?`, [snapshot.actor]);
    ensure(isDeepStrictEqual(account, snapshot.account), 'La cuenta o su contraseña cambió.');
    ensure(isDeepStrictEqual(await store.saveOrder(snapshot.payload, snapshot.actor), snapshot.order), 'Replay no conservó el pedido original.');
    ensure((await store.orders()).length === snapshot.orderCount, 'El número de pedidos cambió o replay duplicó un pedido.');
    ensure((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='orders'`)).value === snapshot.counter, 'El contador de numeración cambió.');
    let denied;
    try { await store.db.exec('CREATE TABLE allnutrition.permission_probe(id int)'); }
    catch (error) { denied = error.code; }
    ensure(denied === '42501', 'El runtime no rechazó CREATE TABLE con 42501.');
    console.log('Persistencia, cuenta, sesión, replay, numeración, historial, TLS y prohibición DDL verificados.');
  } else {
    const url = new URL(config.url);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
    await rejectConnection(url.toString(), { rejectUnauthorized: true, ca: readFileSync('/artifacts/https-ca.crt', 'utf8') }, ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
    await rejectConnection(url.toString(), false, ['28000']);
    console.log('CA equivocada rechazada por cadena TLS; TCP sin TLS rechazado por HBA con 28000.');
  }
} catch (error) {
  // Never dump assertion objects: operational.json includes an active session and password hash.
  console.error(`Verificación operativa falló: ${error.code || error.message}`);
  process.exitCode = 1;
} finally { await store?.close(); }
