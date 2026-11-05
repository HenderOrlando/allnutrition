import { crc32 } from 'node:zlib';
import { Unzip, UnzipInflate } from 'fflate';

const MiB = 1024 * 1024;
function reject(message, code = 'EXCEL_INVALID', status = 400) {
  throw Object.assign(new Error(message), { code, status });
}
function limit(message) { reject(message, 'EXCEL_CONTENT_LIMIT', 413); }

function zipDirectory(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) reject('El contenedor Excel está truncado o dañado.');
  const count = bytes.readUInt16LE(end + 10);
  if (count > 2048) limit('El archivo contiene más de 2048 entradas ZIP.');
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count) reject('No se admiten archivos Excel ZIP divididos.');
  const start = bytes.readUInt32LE(end + 16);
  if (start + bytes.readUInt32LE(end + 12) !== end) reject('El directorio del archivo Excel está dañado.');
  const entries = new Map();
  let position = start;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) reject('El directorio ZIP está truncado.');
    const flags = bytes.readUInt16LE(position + 8), compression = bytes.readUInt16LE(position + 10);
    if (flags & 1) reject('El Excel está cifrado. Guarda una copia sin contraseña.', 'EXCEL_PROTECTED');
    if (![0, 8].includes(compression)) reject('El archivo usa un método ZIP no admitido.', 'EXCEL_FORMAT', 415);
    const nameLength = bytes.readUInt16LE(position + 28);
    const next = position + 46 + nameLength + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
    if (next > end) reject('El directorio ZIP está truncado.');
    const name = bytes.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    if (entries.has(name)) reject('El archivo contiene entradas ZIP repetidas.');
    const offset = bytes.readUInt32LE(position + 42), compressed = bytes.readUInt32LE(position + 20);
    if (offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50
      || bytes.readUInt16LE(offset + 8) !== compression || bytes.readUInt16LE(offset + 6) & 1) reject('La cabecera ZIP no es válida.');
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const dataStart = offset + 30 + localNameLength + bytes.readUInt16LE(offset + 28);
    if (dataStart + compressed > start || bytes.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') !== name) reject('El contenido ZIP está truncado o dañado.');
    entries.set(name, { size: bytes.readUInt32LE(position + 24), crc: bytes.readUInt32LE(position + 16), compression });
    position = next;
  }
  if (position !== end) reject('El directorio ZIP no coincide con el archivo.');
  return entries;
}

// Budget the actual emitted bytes, not trusted ZIP header sizes. Optional retention
// lets expansion reuse the very same validated bytes without decompressing twice.
export function validateExcelZip(input, extension, { retain = false } = {}) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const directory = zipDirectory(bytes), observed = new Set(), entries = Object.create(null);
  let total = 0, count = 0, completed = 0, contentTypes = '', failure = null;
  const stop = (file, message, code = 'EXCEL_INVALID', status = 400) => {
    failure ??= Object.assign(new Error(message), { code, status });
    file.terminate();
  };
  const unzip = new Unzip(file => {
    if (failure) { file.terminate(); return; }
    if (++count > 2048) { stop(file, 'El archivo contiene más de 2048 entradas ZIP.', 'EXCEL_CONTENT_LIMIT', 413); return; }
    const entry = directory.get(file.name);
    if (!entry || observed.has(file.name) || entry.compression !== file.compression) { stop(file, 'Las entradas ZIP no coinciden con el directorio.'); return; }
    observed.add(file.name);
    let emitted = 0, checksum = 0;
    const parts = [];
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) { stop(file, 'No se pudo descomprimir el Excel; puede estar dañado.'); return; }
      emitted += chunk.length;
      total += chunk.length;
      if (emitted > 32 * MiB) { stop(file, 'Una entrada del Excel supera 32 MiB descomprimidos.', 'EXCEL_CONTENT_LIMIT', 413); return; }
      if (total > 128 * MiB) { stop(file, 'El Excel supera 128 MiB descomprimidos.', 'EXCEL_CONTENT_LIMIT', 413); return; }
      if (file.name === '[Content_Types].xml' && emitted > MiB) { stop(file, 'Los metadatos del Excel son demasiado grandes.', 'EXCEL_CONTENT_LIMIT', 413); return; }
      checksum = crc32(chunk, checksum);
      if (retain || file.name === '[Content_Types].xml') parts.push(Buffer.from(chunk));
      if (final) {
        if (emitted !== entry.size || checksum !== entry.crc) { stop(file, 'El contenido Excel está dañado (tamaño o CRC incorrecto).'); return; }
        completed++;
        if (retain || file.name === '[Content_Types].xml') {
          const value = Buffer.concat(parts);
          if (retain) entries[file.name] = value;
          if (file.name === '[Content_Types].xml') contentTypes = value.toString('utf8');
        }
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    try { unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length); }
    catch (error) { throw failure ?? error; }
    if (failure) throw failure;
  }
  if (completed !== directory.size) reject('El Excel está truncado; faltan entradas ZIP.');
  const macro = /application\/vnd\.ms-excel\.sheet\.macroEnabled\.main\+xml/.test(contentTypes);
  if (!contentTypes || (extension === 'xlsb' ? !directory.has('xl/workbook.bin') : !directory.has('xl/workbook.xml'))
    || (extension === 'xlsm' && !macro) || (extension === 'xlsx' && (macro || directory.has('xl/vbaProject.bin')))) reject('La extensión no corresponde al contenido Excel. Guarda el archivo con su extensión original.', 'EXCEL_FORMAT', 415);
  return retain ? entries : undefined;
}
