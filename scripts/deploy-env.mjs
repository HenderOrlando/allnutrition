import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, X509Certificate, createPrivateKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const keys = ['POSTGRES_DB', 'POSTGRES_PASSWORD', 'DB_APP_PASSWORD', 'APP_URL', 'APP_DOMAIN', 'HTTPS_PORT', 'DEPLOY_TLS_DIR', 'BACKUP_DIR', 'ARTIFACT_DIR', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'APP_IMAGE', 'LOCAL_UID', 'LOCAL_GID'];
const secret = () => randomBytes(32).toString('hex');
const fail = message => { throw new Error(message); };
function openssl(args) {
  const result = spawnSync('openssl', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) fail(`OpenSSL falló en ${args[0]}; comprueba la instalación y los certificados privados.`);
}
function quote(value) {
  if (/[\r\n\0]/.test(value)) fail('Las variables de despliegue no admiten saltos de línea.');
  return `'${value.replaceAll("'", "\\'")}'`;
}
export function readDeploymentEnv(file) {
  const values = {};
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const match = /^([A-Z_]+)='((?:\\'|[^'])*)'$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) fail('Archivo de entorno incoherente: formato o variables duplicadas.');
    values[match[1]] = match[2].replaceAll("\\'", "'");
  }
  if (Object.keys(values).length !== keys.length || keys.some(key => !Object.hasOwn(values, key))) fail('Archivo de entorno incompleto o con variables inesperadas.');
  return values;
}
function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
function requireMode(path, mode) {
  if ((statSync(path).mode & 0o777) !== mode) fail('Permisos incoherentes en archivos/directorios de despliegue; no se modificaron.');
}
function validateCertificates(tls) {
  const caFile = join(tls, 'ca.crt');
  const serverFile = join(tls, 'server', 'server.crt');
  let ca, server;
  try {
    ca = new X509Certificate(readFileSync(caFile));
    server = new X509Certificate(readFileSync(serverFile));
    const caKey = createPrivateKey(readFileSync(join(tls, 'ca.key')));
    const serverKey = createPrivateKey(readFileSync(join(tls, 'server', 'server.key')));
    if (!ca.ca || server.ca || !ca.verify(ca.publicKey) || !server.verify(ca.publicKey) || !server.checkHost('db') || !ca.checkPrivateKey(caKey) || !server.checkPrivateKey(serverKey)) fail('incoherente');
    if ([caKey, serverKey].some(key => key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 3072)) fail('clave incompatible');
    for (const cert of [ca, server]) {
      if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) fail('caducado');
    }
  } catch { fail('Certificados ausentes, caducados, ilegibles o incompatibles con su CA, clave u hostname db. No se sobrescribieron.'); }
  openssl(['verify', '-CAfile', caFile, serverFile]);
  if ([ca, server].some(cert => Date.parse(cert.validTo) - Date.now() < 30 * 86400000)) console.warn('ADVERTENCIA: certificado de despliegue caduca en menos de 30 días; planifica su renovación.');
  if (readdirSync(join(tls, 'server')).sort().join(',') !== 'server.crt,server.key') fail('El directorio TLS montado en PostgreSQL debe contener únicamente server.crt y server.key.');
  requireMode(tls, 0o700);
  requireMode(join(tls, 'server'), 0o700);
  requireMode(caFile, 0o644);
  for (const file of ['ca.key', 'server/server.crt', 'server/server.key']) requireMode(join(tls, file), 0o600);
}
function validateDomain(domain) {
  if (typeof domain !== 'string' || domain.length > 253 || !domain.includes('.') || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || /^\d+(\.\d+){3}$/.test(domain)) fail('Producción requiere --domain válido, sin protocolo, ruta, puerto ni credenciales.');
  return domain.toLowerCase();
}
export function createDeploymentEnv(mode, options = {}) {
  if (!['staging', 'production', 'test'].includes(mode)) fail('Uso: deploy-env.mjs staging | production --domain DOMINIO --admin-email CORREO | test --id IDENTIFICADOR');
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') fail('El despliegue requiere un host Mac/Linux.');
  if (mode === 'test' && !/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(options.id || '')) fail('El identificador de prueba debe ser alfanumérico con guiones.');
  if (mode !== 'test' && options.id || mode !== 'production' && (options.domain || options.adminEmail)) fail('Opciones incompatibles con el entorno.');
  const domain = mode === 'production' ? validateDomain(options.domain) : 'localhost';
  const email = mode === 'production' ? options.adminEmail : mode === 'staging' ? 'staging-admin@example.test' : '';
  if (mode === 'production' && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email === 'staging-admin@example.test' || email === 'e2e@example.test')) fail('Producción requiere --admin-email real y propio, no una cuenta de pruebas.');
  const root = resolve(mode === 'test' ? `.test-data/docker/${options.id}` : `data/deploy/${mode}`);
  const envFile = mode === 'test' ? join(root, 'env') : resolve(mode === 'staging' ? '.env.staging.local' : '.env.server.local');
  const tls = join(root, 'tls');
  const backups = mode === 'test' ? join(root, 'backups') : resolve(`backups/${mode}`);
  const artifacts = join(root, 'artifacts');
  const expected = {
    POSTGRES_DB: mode === 'test' ? 'allnutrition_test' : mode === 'staging' ? 'allnutrition_staging' : 'allnutrition',
    APP_URL: mode === 'production' ? `https://${domain}` : `https://localhost:${mode === 'staging' ? 8443 : 9443}`,
    APP_DOMAIN: domain, HTTPS_PORT: mode === 'production' ? '443' : mode === 'staging' ? '8443' : '9443',
    DEPLOY_TLS_DIR: tls, BACKUP_DIR: backups, ARTIFACT_DIR: artifacts, ADMIN_EMAIL: email,
    LOCAL_UID: String(process.getuid()), LOCAL_GID: String(process.getgid()),
  };
  if (existsSync(envFile) || existsSync(root) || existsSync(backups)) {
    try {
      const values = readDeploymentEnv(envFile);
      if (Object.entries(expected).some(([key, value]) => values[key] !== value)) fail('Configuración existente incoherente con este entorno, host u opciones.');
      if (!/^[a-f0-9]{64}$/.test(values.POSTGRES_PASSWORD) || !/^[a-f0-9]{64}$/.test(values.DB_APP_PASSWORD) || !/^[a-f0-9]{64}$/.test(values.ADMIN_PASSWORD) || !/^allnutrition:(?:node24-local|release-[a-f0-9]{12})$/.test(values.APP_IMAGE)) fail('Configuración existente incompleta o incoherente.');
      requireMode(envFile, 0o600);
      for (const directory of [root, artifacts, backups]) requireMode(directory, 0o700);
      validateCertificates(tls);
      return { envFile, values, reused: true };
    } catch (error) {
      if (error.code) fail('Despliegue parcial o ilegible: faltan archivos privados. No se sobrescribieron ni borraron datos.');
      throw error;
    }
  }
  openssl(['version']);
  const previousMask = process.umask(0o077);
  try {
    for (const directory of [root, tls, join(tls, 'server'), artifacts, backups]) privateDirectory(directory);
    const caConfig = join(tls, 'ca.cnf');
    const serverConfig = join(tls, 'server.cnf');
    const csr = join(tls, 'server.csr');
    writeFileSync(caConfig, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=AllNutrition PostgreSQL CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(serverConfig, '[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=db\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:db\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n', { mode: 0o600, flag: 'wx' });
    openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650', '-config', caConfig, '-keyout', join(tls, 'ca.key'), '-out', join(tls, 'ca.crt')]);
    openssl(['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-config', serverConfig, '-keyout', join(tls, 'server', 'server.key'), '-out', csr]);
    openssl(['x509', '-req', '-in', csr, '-CA', join(tls, 'ca.crt'), '-CAkey', join(tls, 'ca.key'), '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-out', join(tls, 'server', 'server.crt'), '-days', '365', '-sha256', '-extfile', serverConfig, '-extensions', 'server']);
    // Only the public CA is readable by the unprivileged application bind mount.
    chmodSync(join(tls, 'ca.crt'), 0o644);
    for (const file of [caConfig, serverConfig, csr]) unlinkSync(file);
    validateCertificates(tls);
    const values = { ...expected, POSTGRES_PASSWORD: secret(), DB_APP_PASSWORD: secret(), ADMIN_PASSWORD: secret(), APP_IMAGE: 'allnutrition:node24-local' };
    writeFileSync(envFile, keys.map(key => `${key}=${quote(values[key])}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    return { envFile, values, reused: false };
  } finally { process.umask(previousMask); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    const names = { '--id': 'id', '--domain': 'domain', '--admin-email': 'adminEmail' };
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = names[args[index]];
      if (!key || !args[index + 1] || Object.hasOwn(options, key)) fail('Opciones incompletas o desconocidas.');
      options[key] = args[index + 1];
    }
    const result = createDeploymentEnv(mode, options);
    console.log(`${result.reused ? 'Conservado' : 'Creado'} entorno privado: ${result.envFile}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
