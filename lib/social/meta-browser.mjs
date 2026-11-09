import { fail } from '../validation-core.mjs';
import { BrowserControlError } from './browser-client.mjs';

export function createMetaBrowserConnector({ client, connection, credentials }) {
  if (connection?.integrationMethod !== 'browser') fail('La conexión no corresponde al navegador.');
  const session = { connectionId: connection.id, sessionEpoch: connection.sessionEpoch ?? 0 };
  const identities = connection.identities || {};
  const minimal = () => Object.fromEntries(['userId', 'adAccountId'].filter(key => identities[key]).map(key => [key, identities[key]]));
  const pause = (purpose, operation) => purpose === 'pause' || /^pause:[\w:-]+$/.test(operation?.step || '');
  async function open(signal, purpose = 'normal') {
    return client.open({ ...session, payload: { storageState: credentials?.storageState || null, expectedIdentities: purpose === 'pause' ? minimal() : identities, purpose: 'worker', validationPurpose: purpose }, signal });
  }
  function result(response) {
    if (!['confirmed', 'pending', 'blocked', 'uncertain'].includes(response?.status)) throw new BrowserControlError('LAYOUT_CHANGED');
    const value = response.data || {};
    return { ...value, status: response.status, remoteRefs: value.remoteRefs || {}, observedSpec: value.observedSpec || null, evidence: value.evidence || {} };
  }
  return {
    async validateConnection({ signal, selectAssets = false, purpose = 'normal' } = {}) {
      await open(signal, purpose);
      const response = await client.inspect({ ...session, payload: { kind: 'connection', expectedIdentities: purpose === 'pause' ? minimal() : identities, selectAssets, purpose }, signal });
      if (response.status !== 'confirmed') throw new BrowserControlError(response.data?.errorCode || 'SESSION_EXPIRED');
      return { ...response.data, integrationMethod: 'browser', adapterVersion: 'meta-ui-v2' };
    },
    async estimateAudience({ spec, signal }) {
      await open(signal, 'read');
      const response = await client.inspect({ ...session, payload: { kind: 'audience', spec, expectedIdentities: identities }, signal });
      return response.data?.audienceEstimate || { status: 'unavailable', lower: null, upper: null, source: 'meta_ui', definition: 'potential_audience', reason: 'Meta no ofrece estimación visible para esta audiencia.', apiVersion: null };
    },
    async preflight({ operation, spec, query, media = null, signal }) {
      await open(signal);
      return result(await client.preflight({ ...session, payload: { operation, spec, query: query || null, media, expectedIdentities: identities }, signal }));
    },
    async executeStep({ operation, spec, media, signal, purpose = 'normal' }) {
      const selectedPurpose = pause(purpose, operation) ? 'pause' : 'normal';
      await open(signal, selectedPurpose);
      return result(await client.execute({ ...session, payload: { operation, spec, media: media || null, purpose: selectedPurpose, expectedIdentities: selectedPurpose === 'pause' ? minimal() : identities }, signal }));
    },
    async inspectDelivery({ delivery = null, operation = null, spec, signal, purpose = 'normal' }) {
      const selectedPurpose = pause(purpose, operation) ? 'pause' : 'read';
      await open(signal, selectedPurpose);
      return result(await client.inspect({ ...session, payload: { kind: 'delivery', delivery, operation, spec, purpose: selectedPurpose, expectedIdentities: selectedPurpose === 'pause' ? minimal() : identities }, signal }));
    },
    async verifyRemoteLink({ delivery = null, operation, spec, remoteId, permalink = null, acceptContentVerification = false, signal }) {
      const selectedPurpose = pause('normal', operation) ? 'pause' : 'read';
      await open(signal, selectedPurpose);
      return result(await client.inspect({ ...session, payload: { kind: 'verify-link', delivery, operation, spec, remoteId, permalink, acceptContentVerification, purpose: selectedPurpose, expectedIdentities: selectedPurpose === 'pause' ? minimal() : identities }, signal }));
    },
    async fetchMeasurements({ delivery, spec, query, knownUnsupported = [], signal }) {
      if (spec?.integrationMethod && spec.integrationMethod !== 'browser') fail('La revisión no corresponde al navegador.');
      await open(signal, 'read');
      const response = await client.measure({ ...session, payload: { delivery, spec, query, knownUnsupported, expectedIdentities: identities }, signal });
      if (response.status !== 'confirmed') throw new BrowserControlError(response.data?.errorCode || 'LAYOUT_CHANGED');
      const data = response.data;
      if (!Array.isArray(data?.snapshots) || !Array.isArray(data?.unsupportedMetrics)
        || data.snapshots.some(snapshot => snapshot.integrationMethod !== 'browser' || snapshot.adapterVersion !== 'meta-ui-v2' || snapshot.apiVersion !== null)) throw new BrowserControlError('LAYOUT_CHANGED');
      return { snapshots: data.snapshots, unsupportedMetrics: data.unsupportedMetrics };
    },
    async disconnect({ signal } = {}) {
      await client.close({ ...session, signal });
      return { closed: true, revoked: false };
    }
  };
}
