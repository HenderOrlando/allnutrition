import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';

export const FIXTURE_KEY = 'heka-test-fixture-key-not-a-credential';
export const FIXTURE_PRODUCTION_KEY = 'heka-production-branch-fixture-not-a-credential';
export const CITY = '111111111111111111111111', WAREHOUSE = '222222222222222222222222', TEMPLATE = '333333333333333333333333';
export const GUIDE_A = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', guide_number: '000000567801', distributor_id: 'coordinadora', status: 'created' };
export const GUIDE_B = { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', guide_number: '000000567802', distributor_id: 'coordinadora', status: 'in_office' };
export const GUIDE_C = { _id: 'cccccccccccccccccccccccc', guide_number: '000000567803', distributor_id: 'coordinadora', status: 'created' };
const HISTORY = [GUIDE_A,GUIDE_B,GUIDE_C,...Array.from({length:38},(_,index)=>({
  _id:(index+1).toString(16).padStart(24,'0'),guide_number:`SYN-${index+1}`,distributor_id:index<12?'coordinadora':'envia',status:'created',
}))];
export const NOVELTY = 'dddddddddddddddddddddddd';
export const SOLUTION = 'Entregar en portería de la dirección sintética';
export const UNCERTAIN_SOLUTION = 'Solución sintética registrada sin recibo';

function blankPDF() {
  const entries = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = entries.map((entry, index) => { const offset = pdf.length; pdf += `${index + 1} 0 obj\n${entry}\nendobj\n`; return offset; });
  const start = pdf.length;
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.map(x => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf).toString('base64');
}

export function installHekaBrowserTransport(log, origin) {
  const localFetch = globalThis.fetch;
  const paged = (rows, extra = {}) => ({ rows, pager: { total: rows.length, pages: 1, page: 1, previousPage: null, nextPage: null, ...extra } });
  const ok = response => Response.json({ code: 200, response });
  let storedSolution;
  const reject = (status, message) => Response.json({ code: status, response: { message } }, { status });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === origin) return localFetch(input, init);
    const productionBranch = url.origin === 'https://api.hekaentrega.co';
    assert.ok(productionBranch || url.origin === 'https://apidev.hekaentrega.co', 'La fixture prohíbe toda salida a un proveedor real');
    const request = new Request(input, init);
    assert.equal(request.headers.get('api-key'), productionBranch ? FIXTURE_PRODUCTION_KEY : FIXTURE_KEY);
    assert.equal(request.headers.has('Authorization'), false);
    const { method } = request, path = url.pathname.slice('/api/v1'.length), query = url.searchParams;
    assert.ok(url.pathname.startsWith('/api/v1/'));
    if (productionBranch) assert.equal(`${method} ${path}`, 'GET /shipments/guide/v2/external');
    appendFileSync(log, JSON.stringify({ method, path, productionBranch }) + '\n');
    switch (`${method} ${path}`) {
      case 'GET /geolocation/city': {
        if (query.get('label') === 'AMBIGUA') return ok(paged([{ _id: CITY, label: 'Primera coincidencia sintética', dane: '11001000' }], { total: 2, pages: 2, nextPage: 2 }));
        assert.equal(query.get('label'), 'BOGOTA');
        return ok(paged([{ _id: CITY, label: 'BOGOTA(CUNDINAMARCA)', dane: '11001000' }]));
      }
      case 'GET /warehouse': {
        const values = { _id: WAREHOUSE, name: 'Bodega de prueba', status: 'active' };
        return ok(query.get('limit') === '1' ? values : paged([values]));
      }
      case 'GET /shipping/template': return ok([{ _id: TEMPLATE, label: 'Plantilla de prueba', city_destination: '05001000', type_payment: 3, declared_value: 25000, weight: 1, height: 5, long: 6, width: 7, withshipping_cost: false }]);
      case 'POST /shipping/quoter': {
        const body = await request.json();
        assert.ok(body.city_origin==='11001000'||body.city_origin?.city==='Bogotá');
        assert.ok(body.city_destination==='05001000'||body.city_destination?.state==='Cundinamarca');
        if (body.warehouse!==undefined) assert.equal(body.warehouse, WAREHOUSE);
        assert.equal(body.withshipping_cost, false);
        assert.equal(body.client, undefined);
        assert.ok(!('recipient' in body)&&!('orderId' in body));
        return ok({ options: [{distributor_id:'coordinadora',total:12750,deliveryTime:2,visual_flete:12000,assured:0,transportCommission:750},{ amount:12750 }], authToken:'never-return-provider-token' });
      }
      case 'GET /shipments/guide/v2/external': {
        if (query.get('id') === GUIDE_A._id) return ok(paged([GUIDE_A]));
        if (query.get('id') === GUIDE_C._id) return ok(paged([GUIDE_C]));
        if (query.get('text') === 'SIN-RESULTADOS') return ok(paged([]));
        if (query.get('text') === 'ERROR-DE-PROVEEDOR') return reject(403, 'no muestres el mensaje privado del proveedor');
        const carrier=query.get('distributor_id'), limit=Number(query.get('limit')||20), page=Number(query.get('page')||1);
        if(carrier==='tcc'&&limit===2) return reject(503,'Cuenta temporalmente no disponible');
        const all=HISTORY.filter(row=>!carrier||row.distributor_id===carrier), total=all.length, pages=Math.max(1,Math.ceil(total/limit));
        return ok(paged(all.slice((page-1)*limit,page*limit),{page,total,pages,nextPage:page<pages?page+1:null,previousPage:page>1?page-1:null}));
      }
      case 'POST /shipments/guide': {
        const body = await request.json();
        assert.equal(body.distributor_id, 'coordinadora'); assert.equal(body.warehouse, WAREHOUSE);
        assert.equal(body.client.name, 'Destinatario de prueba');
        assert.equal(body.client.phone, 3000000000);
        if (body.product === 'Envío sin respuesta verificable') return new Response('no hay recibo verificable', { status: 502 });
        assert.equal(body.product, 'Producto de prueba');
        return ok(GUIDE_A);
      }
      case 'GET /shipments/client-log': {
        assert.equal(query.get('document'), '000123');
        return ok(paged([{ name: 'Des**** de pru****', document: '***123', guide_number: GUIDE_A.guide_number, phone: 3000000000 }]));
      }
      case 'GET /shipments/guide/client': {
        assert.equal(query.get('limit'), '1');
        return ok(query.get('phone') === '3000000000' ? { _id: { name: 'Des**** de pru****', document: '***123' }, statuses: { finished: 3 }, total: 4, returned: 1, percentReturned: 25, category: 'qualified' } : null);
      }
      case 'GET /shipments/novelty': {
        const item = { ...GUIDE_B, status: 'novelty', status_novelty: 'in_novelty', city_destination: 'MEDELLIN(ANTIOQUIA)',
          last_novelty: { _id: NOVELTY, message: 'Cliente no disponible', last_status: 'distribution', ...(query.get('id') === GUIDE_B._id&&storedSolution?{solution:storedSolution}:{}) },
          movemens: [{ label: 'Visita de prueba', status: 'distribution', isNovelty: true, date: '2026-11-10T10:00:00Z' }] };
        return ok(paged([item]));
      }
      case `PATCH /shipments/novelty/${NOVELTY}`: {
        const { solution } = await request.json();
        if(solution===UNCERTAIN_SOLUTION){ storedSolution=solution; return new Response('recibo sintético no verificable',{status:502}); }
        assert.equal(solution, SOLUTION);
        return ok({ _id: NOVELTY, last_status: 'distribution', solution: SOLUTION, updatedAt: '2026-11-12T15:00:00Z' });
      }
      case 'POST /documents/sticker': {
        if (query.get('type') === 'document') assert.equal(query.get('id'), TEMPLATE);
        else {
          assert.equal(query.get('type'), 'guide');
          assert.deepEqual(await request.json(), { guides: [GUIDE_A._id, GUIDE_B._id] });
        }
        return ok(blankPDF());
      }
      default: assert.fail(`Operación de fixture no permitida: ${method} ${path}`);
    }
  };
}
