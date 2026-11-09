import vm from 'node:vm';
import { hekaSnapshot } from './heka-fixtures.mjs';

export const HEKA_CARRIERS = ['SERVIENTREGA', 'ENVIA', 'TCC', 'INTERRAPIDISIMO', 'COORDINADORA', 'REFERIDOS', 'HEKA'];
const documentId = Symbol('Firestore document ID');
const clone = value => structuredClone(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Model SDK Timestamp instances with component fields and inherited methods. The
// adapter must project the fields, never invoke date/JSON/coercion methods.
class SdkTimestamp {
  toDate() { throw new Error('Timestamp method must not be called'); }
  toMillis() { throw new Error('Timestamp method must not be called'); }
  toJSON() { throw new Error('Timestamp method must not be called'); }
  valueOf() { throw new Error('Timestamp method must not be called'); }
}

// A deliberately small SDK 8-compatible model, not an adapter-result mock. Every
// query executes filters, ordered value/document cursors and limits over documents.
export function createHekaSdkFixture({ snapshot = hekaSnapshot(), onGet, onExecute, location, sdkVersion = '8.10.1' } = {}) {
  const documents = new Map();
  const reads = [];
  const executions = [];
  const headerReads = new Map();
  const account = clone(snapshot.account);
  const metadata = () => ({ fromCache: false, hasPendingWrites: false });
  const guidePath = `usuarios/${account.userId}/guias`;
  for (const guide of snapshot.guides) {
    const { documentId: id, ...data } = guide;
    documents.set(`${guidePath}/${id}`, clone(data));
  }
  for (const pkg of snapshot.packages) {
    documents.set(`paquetePagos/${pkg.idPaquetePago}`, clone(pkg.header));
    for (const line of pkg.lines) {
      const { documentId: id, carrierCollection, ...data } = line;
      documents.set(`pagos/${carrierCollection}/pagos/${id}`, clone(data));
    }
  }
  for (const line of snapshot.pending.lines) {
    const { documentId: id, carrierCollection, ...data } = line;
    documents.set(`pendientePorPagar/${id}`, { timeline: Date.parse(snapshot.pending.cutoff), ...clone(data) });
  }
  const context = vm.createContext({
    TextEncoder, Date, Map, Set, BigInt,
    location: { origin: 'https://admin.hekaentrega.co', pathname: '/plataforma2.html', ...location },
    document: { querySelectorAll: () => [] },
    datos_usuario: { centro_de_costo: account.centerCost },
    localStorage: new Proxy({ user_id: account.userId }, {
      get(target, key) {
        if (key !== 'user_id') throw new Error('Forbidden storage read');
        return target[key];
      },
    }),
  });
  function docSnapshot(path) {
    const exists = documents.has(path);
    const data = clone(documents.get(path));
    const result = {
      id: path.split('/').at(-1), ref: { path }, exists, metadata: metadata(),
      data: () => {
        const value = clone(data);
        for (const key of ['ultima_actualizacion', 'fecha']) {
          if (value?.[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) Object.setPrototypeOf(value[key], SdkTimestamp.prototype);
        }
        return value;
      },
    };
    Object.defineProperty(result, '__value', { value: data });
    return result;
  }
  const field = (doc, name) => name === documentId ? doc.id : doc.__value[name];
  class Query {
    constructor(path, state = {}) {
      this.path = path;
      this.filters = state.filters ?? [];
      this.orders = state.orders ?? [];
      this.start = state.start;
      this.end = state.end;
      this.after = state.after;
      this.maximum = state.maximum;
    }
    copy(change) { return new Query(this.path, { ...this, ...change }); }
    where(name, operator, value) {
      if (!['==', '>=', '<'].includes(operator)) throw new Error('Unsupported where operator');
      return this.copy({ filters: [...this.filters, [name, operator, value]] });
    }
    orderBy(name, direction = 'asc') {
      if (!['asc', 'desc'].includes(direction)) throw new Error('Unsupported order');
      return this.copy({ orders: [...this.orders, [name, direction]] });
    }
    startAt(...values) { return this.copy({ start: values }); }
    endAt(...values) { return this.copy({ end: values }); }
    startAfter(doc) {
      if (!doc || !doc.ref?.path || doc.ref.path.slice(0, doc.ref.path.lastIndexOf('/')) !== this.path || !doc.__cursor) throw new Error('Cursor must be a DocumentSnapshot');
      return this.copy({ after: doc });
    }
    limit(maximum) {
      if (maximum !== 500) throw new Error('Provider pagination must be 500 documents');
      return this.copy({ maximum });
    }
    doc(id) {
      if (typeof id !== 'string' || !id || id.includes('/')) throw new Error('Invalid document ID');
      return new DocumentReference(`${this.path}/${id}`);
    }
    async get(options) {
      if (options?.source !== 'server' || Object.keys(options).length !== 1) throw new Error('Server source required');
      if (this.maximum !== 500) throw new Error('Unbounded query');
      const record = { kind: 'query', path: this.path, filters: this.filters, orders: this.orders, limit: this.maximum, cursor: this.after?.ref.path ?? null, end: this.end };
      reads.push(record);
      const response = await onGet?.({ record, documents, context, headerReads, reads });
      if (response?.error) throw response.error;
      const prefix = this.path + '/';
      let docs = [...documents.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map(docSnapshot);
      docs = docs.filter(doc => this.filters.every(([name, operator, value]) => {
        const actual = field(doc, name);
        return operator === '==' ? actual === value : operator === '>=' ? actual >= value : actual < value;
      }));
      // Firestore orderBy excludes documents missing the ordered field.
      docs = docs.filter(doc => this.orders.every(([name]) => field(doc, name) !== undefined));
      const ordering = this.orders.length ? this.orders : [[documentId, 'asc']];
      const cmp = (a, b) => {
        for (const [name, direction] of ordering) {
          const result = compare(field(a, name), field(b, name)) * (direction === 'desc' ? -1 : 1);
          if (result) return result;
        }
        return compare(a.id, b.id);
      };
      const cmpValues = (doc, values) => {
        for (let index = 0; index < values.length; index++) {
          const [name, direction] = ordering[index];
          const result = compare(field(doc, name), values[index]) * (direction === 'desc' ? -1 : 1);
          if (result) return result;
        }
        return 0;
      };
      docs.sort(cmp);
      if (this.start) docs = docs.filter(doc => cmpValues(doc, this.start) >= 0);
      if (this.end) docs = docs.filter(doc => cmpValues(doc, this.end) <= 0);
      if (this.after) docs = docs.filter(doc => cmp(doc, this.after) > 0);
      docs = docs.slice(0, this.maximum);
      for (const doc of docs) Object.defineProperty(doc, '__cursor', { value: true });
      const result = { docs, size: docs.length, empty: docs.length === 0, metadata: metadata() };
      response?.mutate?.(result);
      return result;
    }
  }
  class DocumentReference {
    constructor(path) { this.path = path; this.id = path.split('/').at(-1); }
    collection(name) { return new Query(`${this.path}/${name}`); }
    async get(options) {
      if (options?.source !== 'server' || Object.keys(options).length !== 1) throw new Error('Server source required');
      headerReads.set(this.path, (headerReads.get(this.path) ?? 0) + 1);
      const record = { kind: 'document', path: this.path, count: headerReads.get(this.path) };
      reads.push(record);
      const response = await onGet?.({ record, documents, context, headerReads, reads });
      if (response?.error) throw response.error;
      const result = docSnapshot(this.path);
      response?.mutate?.(result);
      return result;
    }
  }
  const firestore = () => ({ collection: name => new Query(name) });
  firestore.FieldPath = { documentId: () => documentId };
  context.firebase = { SDK_VERSION: sdkVersion, firestore };
  const webContents = {
    async executeJavaScript(source) {
      executions.push(source);
      await onExecute?.({ context, executions, documents });
      const result = await vm.runInContext(source, context);
      // Electron structured-clones return values into the main process realm.
      return clone(result);
    },
  };
  return { webContents, documents, context, reads, executions, snapshot, account, query: clone(snapshot.query), guidePath, headerReads };
}
