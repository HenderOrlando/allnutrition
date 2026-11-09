// Synthetic provider-shaped data only. No customer, bank, credential or storage fields.
export function hekaSnapshot(overrides = {}) {
  const account = { userId: 'fixture-user-001 ', centerCost: '0007' };
  const header = {
    id_user: account.userId, centro_de_costo: account.centerCost,
    guiasPagadas: ['0000123', '0000123', '0000456'],
    fecha: { seconds: 1794150000, nanoseconds: 123456789 }, total_pagado: '70.25', comision_heka: '3.00',
    cantidad_pagos: 42, timeline: 1794146400000,
  };
  function line(documentId, tracking, gross, shipping, commission, net, timestamp) {
    return {
      documentId, carrierCollection: 'SERVIENTREGA', idPaquetePago: 'fixture-package-01 ',
      REMITENTE: account.centerCost, TRANSPORTADORA: 'SERVIENTREGA', GUIA: tracking,
      FECHA: '08-11-2026', fechaPago: '2026-11-08',
      momentoParticularPago: timestamp, RECAUDO: gross, 'ENVÍO TOTAL': shipping,
      'COMISION HEKA': commission, 'TOTAL A PAGAR': net, referencia: '',
    };
  }
  return {
    schemaVersion: 1, adapterVersion: 'heka-classic-v1',
    query: { queryId: 'fixture-query-001', from: '2026-11-08', to: '2026-11-08', tracking: '' },
    account, capturedAt: '2026-11-09T12:00:00.000Z', source: 'server', complete: true,
    guides: [{
      documentId: 'fixture-guide-001 ', id_heka: '000001 ', numeroGuia: '0000123', transportadora: 'SERVIENTREGA',
      estado: 'FINALIZADA', estadoTransportadora: 'ESTADO_DESCONOCIDO', referencia: '',
      ultima_actualizacion: { seconds: 1794157200, nanoseconds: 987654321 }, fecha: '08/11/2026', timeline: 1794146400000,
      seguro: '0', valor: '100.25', costo_envio: null, type: '',
    }],
    packages: [{
      idPaquetePago: 'fixture-package-01 ', header, headerAfter: structuredClone(header),
      lines: [
        line('000001 ', '0000123', '100.25', '10.00', '1.00', '90.25', 1794150000000),
        // Separate SDK document for the same tracking is a real second adjustment, not a duplicate.
        // Its discovery timestamp is outside the initial range; the complete package retains it.
        line('000002', '0000123', '0', '5.00', '1.00', '-5.00', 1793977200000),
        line('000003', '0000456', '0', '15.00', '1.00', '-15.00', 1794150000000),
      ],
    }],
    pending: {
      cutoff: '2026-11-09T00:00:00.000Z',
      lines: [{
        documentId: 'pending-0001', carrierCollection: 'ENVIA', idPaquetePago: null,
        REMITENTE: account.centerCost, TRANSPORTADORA: 'ENVIA', GUIA: '0000789', FECHA: null,
        fechaPago: null, momentoParticularPago: null, RECAUDO: '0', 'ENVÍO TOTAL': null,
        'COMISION HEKA': null, 'TOTAL A PAGAR': null, referencia: '',
      }],
    },
    ...overrides,
  };
}
