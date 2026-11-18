import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync, writeFileSync, appendFileSync, lstatSync, mkdirSync, mkdtempSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Disposable native-host operation. No commands execute until this CLI is invoked.
process.umask(0o077);
const mode = process.argv[2];
const pair = mode === 'pair';
const root = dirname(fileURLToPath(import.meta.url));
const manifestBytes = readFileSync(pair ? process.argv[3] : join(root, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const candidate = pair ? resolve(process.env.RELEASE_CANDIDATE || process.cwd()) : manifest.nativeCandidate;
const configRoot = pair && process.env.RELEASE_CONFIG_ROOT ? resolve(process.env.RELEASE_CONFIG_ROOT) : candidate;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestSha256 = sha(manifestBytes);
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|HOME|LANG|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|XDG_RUNTIME_DIR)$/.test(key)));
cleanEnv.NEXT_TELEMETRY_DISABLED = '1';
if (!pair) cleanEnv.BUILDX_BUILDER = manifest.nativeBuilder;
const token = randomBytes(10).toString('hex');
const project = `allnutrition-browser-${mode}-${token}`;
const owner = 'allnutrition.browser-acceptance';
let work, composeFile, generated, interrupted = false, cleanupRunning = false;
const secrets = [];
const proof = {};
let imageId = null, releaseTag = null, appImageId = null;
let expectedIds;
const ownerId = manifest.id || token;
const ensure = (condition, message) => assert.ok(condition, message);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
function safe(text) {
  let value = String(text || '');
  for (const secret of secrets) if (secret) value = value.replaceAll(secret, '[redacted]');
  return value.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[database URL redacted]');
}
function run(binary, args, { input, timeout = 180000, allowFailure = false, logOutput = true, env = cleanEnv, cwd = candidate } = {}) {
  ensure(!interrupted || cleanupRunning, 'Operation interrupted');
  const result = spawnSync(binary, args, { input, timeout, env, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (work) appendFileSync(join(work, 'commands.log'), JSON.stringify({ binary, command: args[0], status: result.status, signal: result.signal, error: result.error?.code }) + '\n' + (logOutput ? safe(`${result.stdout || ''}${result.stderr || ''}`) : '[private command output withheld]') + '\n', { mode: 0o600 });
  ensure(allowFailure || !result.error && result.status === 0, `Command failed: ${binary} ${args[0]} (${result.error?.code || result.signal || result.status}); see private diagnostics`);
  return result;
}
const docker = (args, options) => run('docker', args, options);
function inspect(kind, id, optional = false) {
  const result = docker([kind, 'inspect', id], { logOutput: false, allowFailure: optional });
  if (optional && result.status !== 0) {
    ensure(!result.error && /No such (?:image|object|container|volume|network)|not found/i.test(result.stderr), 'Unable to determine resource existence');
    return null;
  }
  return JSON.parse(result.stdout)[0];
}
function sourceVerified() {
  if (pair) return;
  ensure(sha(readFileSync(join(root, 'source.tar'))) === manifest.archiveSha256, 'Source archive mismatch');
  for (const entry of manifest.directories) {
    ensure(!entry.path.startsWith('/') && !entry.path.split('/').includes('..'), 'Unsafe manifest directory');
    const info = lstatSync(join(candidate, entry.path));
    ensure(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 511) === entry.mode, 'Sealed candidate directory mismatch');
  }
  for (const entry of manifest.files) {
    ensure(!entry.path.startsWith('/') && !entry.path.split('/').includes('..'), 'Unsafe manifest path');
    const path = join(candidate, entry.path), info = lstatSync(path);
    ensure(info.isFile() && !info.isSymbolicLink() && (info.mode & 511) === entry.mode && info.size === entry.size && sha(readFileSync(path)) === entry.sha256, 'Sealed candidate source mismatch');
  }
}
function identity(info, id) {
  ensure(/^sha256:[a-f0-9]{64}$/.test(id) && info.Id === id && info.Os === 'linux' && info.Architecture === 'amd64' && info.Config.User === 'node', 'Immutable Linux/amd64 node image required');
}
function resources(kind) {
  const args = kind === 'container' ? ['ps', '-a', '-q', '--no-trunc'] : kind === 'network' ? ['network', 'ls', '-q', '--no-trunc'] : ['volume', 'ls', '-q'];
  return docker([...args, '--filter', `label=com.docker.compose.project=${project}`], { logOutput: false }).stdout.trim().split(/\s+/).filter(Boolean);
}
function own(kind, id) {
  const info = inspect(kind, id);
  const labels = kind === 'container' ? info.Config.Labels : info.Labels;
  ensure(labels?.['com.docker.compose.project'] === project && labels?.[owner] === ownerId, 'Cleanup rejected foreign resource');
  if (kind === 'container') ensure(info.Id === id, 'Container identity changed');
  else ensure(info.Name === id || info.Id === id, 'Resource identity changed');
  return info;
}
function cleanup() {
  cleanupRunning = true;
  try {
    for (const kind of ['container', 'volume', 'network']) for (const id of resources(kind)) {
      own(kind, id);
      docker([kind, 'rm', ...(kind === 'container' ? ['--force'] : []), id]);
    }
    const remaining = Object.fromEntries(['container', 'volume', 'network'].map(kind => [kind + 's', resources(kind)]));
    ensure(Object.values(remaining).every(ids => ids.length === 0), 'Owned resources remain after cleanup');
    return { project, remaining, zeroOwnedLeftovers: true };
  } finally { cleanupRunning = false; }
}
function compose(args, options = {}) {
  return docker(['compose', '-p', project, '--env-file', generated.envFile, '-f', composeFile, ...args], options);
}
function exec(service, script) {
  const wrapped = `try {\n${script}\n} catch (error) { console.error(error.stack || ('ACCEPTANCE_PROBE_FAILED ' + (error.code || error.name))); process.exitCode=1; }`;
  const result = compose(['exec', '-T', service, 'node', '--input-type=module'], { input: wrapped, logOutput: false, allowFailure: true });
  if (result.error || result.status !== 0) {
    save(join(work, `failed-probe-${randomUUID()}.json`), { service, status: result.status, signal: result.signal, error: result.error?.code, stdout: safe(result.stdout), stderr: safe(result.stderr) });
    throw Error(`Private probe failed in ${service}; see failed-probe diagnostics`);
  }
  return JSON.parse(result.stdout.trim());
}
function container(service) {
  const id = compose(['ps', '-q', service], { logOutput: false }).stdout.trim();
  ensure(/^[a-f0-9]{64}$/.test(id), 'Service container missing');
  return own('container', id);
}
function processIdentity(service) {
  const info = container(service);
  ensure(info.State.Running && info.State.Pid > 0 && info.RestartCount === 0, 'Service restarted or stopped');
  const processes = exec(service, `const fs=await import('node:fs'); const rows=[],nodeExecutable=fs.realpathSync(process.execPath); for(const id of fs.readdirSync('/proc').filter(v=>/^\\d+$/.test(v))) {try {const cmd=fs.readFileSync('/proc/'+id+'/cmdline','utf8').replaceAll('\\0',' '); if(fs.realpathSync('/proc/'+id+'/exe')===nodeExecutable&&(cmd.includes('scripts/business-jobs.mjs')||cmd.includes('scripts/social-browser.mjs'))) {const stat=fs.readFileSync('/proc/'+id+'/stat','utf8'); rows.push({pid:Number(id),startTicks:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]});}}catch{}} if(rows.length!==1)throw Error('PROCESS_COUNT'); console.log(JSON.stringify(rows[0]));`);
  return { id: info.Id, pid: info.State.Pid, startedAt: info.State.StartedAt, process: processes };
}
function heartbeat() {
  return exec('web', `const {openStore}=await import('./lib/db/index.mjs'); const store=await openStore(); try {const rows=await store.db.all('SELECT key,updated_at,state,error_code FROM '+store.t('job_runs')+' WHERE key IN (?,?) ORDER BY key',['scheduler:heartbeat','scheduler:social-browser:heartbeat']); console.log(JSON.stringify(rows));}finally{await store.close();}`);
}
async function until(probe, accepted, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { ensure(!interrupted, 'Operation interrupted'); const value = probe(); if (accepted(value)) return value; await delay(1000); }
  throw Error(label + ' did not reach required state');
}
const runnerHealth = () => exec('social-browser', `const r=await fetch('http://localhost:3320/health',{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('HEALTH');console.log(JSON.stringify(await r.json()));`);
function keyState() {
  return exec('web', `const fs=await import('node:fs'); const result=[]; for(const dir of ['/app/data/integration-secrets','/app/data/social-browser-control']) {const s=fs.lstatSync(dir); if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==1000||s.gid!==1000||(s.mode&4095)!==448)throw Error('DIRECTORY_PERMISSIONS'); result.push({directory:dir,uid:s.uid,gid:s.gid,mode:'0700',files:fs.readdirSync(dir).sort().map(name=>{const t=fs.lstatSync(dir+'/'+name); if(!t.isFile()||t.isSymbolicLink()||t.uid!==1000||t.gid!==1000||(t.mode&4095)!==384||t.size!==32)throw Error('KEY_PERMISSIONS');return {name,uid:t.uid,gid:t.gid,mode:'0600',bytes:t.size};})});} console.log(JSON.stringify(result));`);
}
function settingsScript(action, secret) {
  // The cookie is obtained via HTTPS; getSession resolves its real persisted CSRF,
  // never fabricating a session or bypassing the HTTP route's write authorization.
  return `const https=await import('node:https'); const fs=await import('node:fs'); const {getSession}=await import('./lib/auth.mjs'); const {openStore}=await import('./lib/db/index.mjs'); const {randomUUID}=await import('node:crypto'); const origin=process.env.APP_URL; const ca=fs.readFileSync('/run/db-ca/ca.crt');
  async function request(path,method='GET',body,headers={}) {return await new Promise((resolve,reject)=>{const data=body===undefined?null:JSON.stringify(body);const req=https.request(new URL(path,origin),{method,ca,rejectUnauthorized:true,agent:false,headers:{Origin:origin,...headers,...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{})}},res=>{let text='';res.setEncoding('utf8');res.on('data',v=>{text+=v;if(text.length>65536)req.destroy(Error('RESPONSE_LIMIT'));});res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,value:JSON.parse(text)})}catch{reject(Error('RESPONSE_JSON'))}});});req.on('error',reject);req.setTimeout(15000,()=>req.destroy(Error('HTTPS_TIMEOUT')));if(data)req.write(data);req.end();});}
  const login=await request('/api/auth/login','POST',{email:'e2e@example.test',password:'clave-e2e-solo-pruebas'}); if(login.status!==200)throw Error('LOGIN'); const cookie=login.headers['set-cookie']?.[0]?.split(';')[0];if(!cookie||!login.headers['set-cookie'][0].toLowerCase().includes('secure'))throw Error('SECURE_COOKIE'); const token=cookie.slice(cookie.indexOf('=')+1);const store=await openStore();let session;try{session=await getSession(store,token);}finally{await store.close();}if(!session?.csrf)throw Error('SESSION_CSRF');
  const headers={cookie,'x-csrf-token':session.csrf};const initial=await request('/api/admin/social/settings','GET',undefined,headers);if(initial.status!==200)throw Error('SETTINGS_GET');let current=initial.value;
  const action=${JSON.stringify(action)}; const appSecret=${JSON.stringify(secret || '')};
  if(action==='first'){if(current.version!==0||current.hasAppSecret||current.publishingEnabled||current.browserEnabled)throw Error('NOT_FRESH');const denied=await request('/api/admin/social/settings','PUT',{...current,requestId:randomUUID()}, {cookie});if(denied.status!==403)throw Error('CSRF_GATE');}
  const body={version:current.version,requestId:randomUUID(),publicBaseUrl:origin,appId:'123456789012345',loginConfigId:'234567890123456',publishingEnabled:false,browserEnabled:action!=='disable',...(action==='first'?{appSecret}:{})};const saved=await request('/api/admin/social/settings','PUT',body,headers);if(saved.status!==200||saved.value.version!==current.version+1||saved.value.publishingEnabled!==false||saved.value.browserEnabled!==body.browserEnabled||saved.value.hasAppSecret!==true)throw Error('SETTINGS_PUT');const reread=await request('/api/admin/social/settings','GET',undefined,headers);if(reread.status!==200||JSON.stringify(reread.value)!==JSON.stringify(saved.value))throw Error('SETTINGS_PERSISTED');const text=JSON.stringify(saved.value);if((appSecret&&text.includes(appSecret))||Object.hasOwn(saved.value,'appSecret')||/ciphertext|auth_tag|app_secret_iv/.test(text))throw Error('SECRET_DTO');console.log(JSON.stringify({version:saved.value.version,publishingEnabled:false,browserEnabled:saved.value.browserEnabled,hasAppSecret:true,httpsVerified:true,csrfVerified:true,secretExcluded:true}));`;
}
function isolation() {
  const runner = container('social-browser'), worker = container('social-browser-worker');
  ensure(runner.Image === expectedIds['social-browser'] && runner.Config.User === '1000:1000', 'Runner image/user mismatch');
  ensure(worker.Image === expectedIds['social-browser-worker'] && worker.Config.User === 'node', 'Consumer image/user mismatch');
  const ports = info => Object.values(info.NetworkSettings.Ports || {}).every(value => !value?.length) && Object.values(info.HostConfig.PortBindings || {}).every(value => !value?.length);
  ensure(ports(runner) && ports(worker), 'Published ports are forbidden');
  const allowedEnv = new Set(['PATH','NODE_VERSION','YARN_VERSION','NODE_ENV','PLAYWRIGHT_BROWSERS_PATH','SOCIAL_MEDIA_DIR','SOCIAL_BROWSER_CONTROL_DIR','SOCIAL_BROWSER_MAX_CONTEXTS']);
  ensure(runner.Config.Env.every(value => allowedEnv.has(value.split('=')[0])), 'Runner received unexpected environment');
  for (const info of [runner, worker, container('web'), container('scheduler')]) ensure(info.Config.Env.every(value => !/^(META_|SOCIAL_(?:PUBLISHING_ENABLED|BROWSER_ENABLED|TOKEN_KEY|SESSION_KEY|MEDIA_SIGNING_KEY|BROWSER_CONTROL_KEY)=)/.test(value)), 'Legacy integration environment present');
  const runnerMounts = runner.Mounts.filter(m => m.Type !== 'tmpfs');
  ensure(runnerMounts.length === 2 && runnerMounts.every(m => ['/app/data/social-media','/app/data/social-browser-control'].includes(m.Destination) && m.RW === false && m.Type === 'volume'), 'Runner must mount only readonly control and media');
  const media = worker.Mounts.find(m => m.Destination === '/app/data/social-media');
  ensure(media && !media.RW && !worker.Mounts.some(m => m.Destination === '/var/run/docker.sock'), 'Consumer media mount must be readonly');
  const networks = info => Object.keys(info.NetworkSettings.Networks).sort();
  ensure(JSON.stringify(networks(worker)) === JSON.stringify([`${project}_backend`,`${project}_social_control`].sort()), 'Consumer network isolation mismatch');
  ensure(JSON.stringify(networks(runner)) === JSON.stringify([`${project}_social_control`,`${project}_social_egress`].sort()), 'Runner network isolation mismatch');
  const host = runner.HostConfig;
  ensure(host.ReadonlyRootfs && !host.Privileged && !(host.CapAdd || []).length && host.CapDrop?.includes('ALL') && host.SecurityOpt?.some(v=>v==='no-new-privileges:true') && host.SecurityOpt?.some(v=>v.startsWith('seccomp=') && !v.includes('unconfined')), 'Runner sandbox isolation weakened');
  const seccomp = host.SecurityOpt.find(v=>v.startsWith('seccomp='));
  const actualProfile = JSON.parse(seccomp.slice('seccomp='.length));
  ensure(isDeepStrictEqual(actualProfile, JSON.parse(readFileSync(join(configRoot,'deploy/social-browser-seccomp.json')))), 'Runner seccomp differs from product');
  ensure(host.Tmpfs?.['/tmp']?.includes('noexec') && host.ShmSize === 512 * 1024 * 1024, 'Runner tmpfs/shm isolation mismatch');
  for (const name of Object.keys(runner.NetworkSettings.Networks)) ensure(inspect('network',name).Internal === true, 'Acceptance runner egress must be internal');
  return { runnerImageId:runner.Image,consumerImageId:worker.Image,user:1000,noPorts:true,runnerReadonlyControlAndMedia:true,noRunnerDatabaseOrApiKeys:true,consumerNetworks:networks(worker),runnerNetworks:networks(runner),capabilitiesDropped:true,noNewPrivileges:true,readonlyRoot:true,seccompSha256:sha(readFileSync(join(configRoot,'deploy/social-browser-seccomp.json'))),egressBlocked:true };
}
async function build() {
  const tag = `allnutrition-social-browser:candidate-${token}`;
  docker(['buildx','build','--builder',manifest.nativeBuilder,'--platform','linux/amd64','--load','--file','Dockerfile.social-browser','--tag',tag,'.'], { timeout:7200000 });
  const image = inspect('image',tag); imageId=image.Id; identity(image,imageId);
  releaseTag=`allnutrition-social-browser:release-${imageId.slice(7,19)}`;
  const existing=inspect('image',releaseTag,true);
  ensure(!existing || existing.Id===imageId,'Immutable runner release tag contradiction');
  if(!existing)docker(['image','tag',imageId,releaseTag]);
  const output=docker(['run','--rm','--name',`${project}-identity`,'--label',`com.docker.compose.project=${project}`,'--label',`${owner}=${manifest.id}`,'--network','none',imageId,'node','-e',`if(process.getuid()!==1000||process.getgid()!==1000||process.versions.node.split('.')[0]!=='24')process.exit(1);console.log(JSON.stringify({node:process.version,uid:process.getuid(),gid:process.getgid()}))`],{logOutput:false});
  proof.runtime=JSON.parse(output.stdout.trim());
  sourceVerified();
  ensure(inspect('image',releaseTag).Id===imageId,'Runner release tag changed');
  docker(['image','rm',tag]);
  return { arch:'amd64',os:'linux',node:proof.runtime.node,uid:1000,gid:1000 };
}
function pairIdentities() {
  ensure(manifest.format === 1, 'Invalid pair manifest format');
  return Object.fromEntries(['web','scheduler','social-browser-worker','social-browser','db'].map(name => {
    const entry = manifest.services?.[name];
    ensure(/^sha256:[a-f0-9]{64}$/.test(entry?.imageId || '') && typeof entry.imageTag === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9./_:@-]*$/.test(entry.imageTag), 'Missing image identity: ' + name);
    const image = inspect('image', entry.imageId);
    if (name === 'db') ensure(image.Id === entry.imageId && image.Os === 'linux' && image.Architecture === 'amd64', 'PostgreSQL image identity mismatch');
    else identity(image, entry.imageId);
    return [name, image.Id];
  }));
}
async function verify() {
  let legacyAppTag;
  if (pair) {
    expectedIds=pairIdentities();
    imageId=expectedIds['social-browser']; releaseTag=manifest.services['social-browser'].imageTag; appImageId=expectedIds.web;
  } else {
    const accepted=JSON.parse(readFileSync(join(root,'acceptance.json')));
    ensure(accepted.accepted===true&&accepted.code===0&&accepted.sourceFilesVerified===true&&accepted.archiveSha256===manifest.archiveSha256&&accepted.manifestSha256===manifestSha256&&accepted.result?.exitCode===0,'Successful same-source core acceptance required');
    ensure(accepted.result.reusedContracts==null,'A new complete acceptance is required');
    proof.coreAcceptance={mode:'fresh-native',tests:accepted.result.tests};
    const runner=JSON.parse(readFileSync(join(root,'runner-image.json')));
    ensure(runner.accepted===true&&runner.archiveSha256===manifest.archiveSha256&&runner.manifestSha256===manifestSha256,'Successful same-source runner build required');
    imageId=runner.imageId;releaseTag=runner.releaseTag;appImageId=accepted.result.imageId;legacyAppTag=accepted.result.releaseTag;
    identity(inspect('image',imageId),imageId);identity(inspect('image',appImageId),appImageId);
    ensure(releaseTag===`allnutrition-social-browser:release-${imageId.slice(7,19)}`&&inspect('image',releaseTag).Id===imageId,'Immutable runner tag mismatch');
    ensure(legacyAppTag===`allnutrition:release-${appImageId.slice(7,19)}`&&inspect('image',legacyAppTag).Id===appImageId,'Immutable app tag mismatch');
    expectedIds={web:appImageId,scheduler:appImageId,'social-browser-worker':appImageId,'social-browser':imageId};
  }
  const previous=process.cwd();process.chdir(work);
  try {const {createDeploymentEnv}=await import(pathToFileURL(join(candidate,'scripts/deploy-env.mjs')));generated=createDeploymentEnv('test',{id:token});} finally {process.chdir(previous);}
  const values=generated.values; secrets.push(values.POSTGRES_PASSWORD,values.DB_APP_PASSWORD,values.ADMIN_PASSWORD);
  ensure(values.POSTGRES_DB==='allnutrition_test','Disposable database name guard');
  const config=JSON.parse(docker(['compose','-p',project,'--env-file',generated.envFile,'-f',join(configRoot,'compose.yaml'),'--profile','tools','config','--format','json'],{env:{...cleanEnv,APP_IMAGE:appImageId,SOCIAL_BROWSER_IMAGE:imageId,APP_URL:'https://browser-proxy'},logOutput:false}).stdout);
  const selected=['db','web','scheduler','social-browser-worker','social-browser','migrate'];
  config.services=Object.fromEntries(selected.map(name=>[name,config.services[name]]));
  delete config.name;
  for(const [name,service] of Object.entries(config.services)) {delete service.build;delete service.profiles;service.restart='no';service.labels={...service.labels,[owner]:ownerId};if(expectedIds[name]){service.image=expectedIds[name];service.pull_policy='never';}if(name==='social-browser')service.security_opt=['no-new-privileges:true',`seccomp=${join(configRoot,'deploy/social-browser-seccomp.json')}`];ensure(!service.ports?.length,'Disposable services cannot publish ports');}
  for(const [name,network] of Object.entries(config.networks)){network.name=`${project}_${name}`;network.internal=true;network.labels={...network.labels,[owner]:ownerId};}
  for(const [name,volume] of Object.entries(config.volumes)){volume.name=`${project}_${name}`;volume.labels={...volume.labels,[owner]:ownerId};}
  // Remove unused product proxy volumes: this acceptance never starts Caddy.
  delete config.volumes.caddy_data;delete config.volumes.caddy_config;
  const tls=values.DEPLOY_TLS_DIR;
  writeFileSync(join(work,'https.cnf'),'[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=browser-proxy\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:browser-proxy\n',{mode:0o600,flag:'wx'});
  run('openssl',['req','-new','-newkey','rsa:3072','-nodes','-sha256','-config',join(work,'https.cnf'),'-keyout',join(work,'https.key'),'-out',join(work,'https.csr')]);
  run('openssl',['x509','-req','-in',join(work,'https.csr'),'-CA',join(tls,'ca.crt'),'-CAkey',join(tls,'ca.key'),'-set_serial',`0x${randomBytes(16).toString('hex')}`,'-out',join(work,'https.crt'),'-days','2','-sha256','-extfile',join(work,'https.cnf'),'-extensions','server']);
  writeFileSync(join(work,'nginx.conf'),'events {}\nhttp { access_log off; server { listen 443 ssl; server_name browser-proxy; ssl_certificate /run/https.crt; ssl_certificate_key /run/https.key; location / { proxy_pass http://web:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; } } }\n',{mode:0o600,flag:'wx'});
  const bind=(source,target)=>({type:'bind',source,target,read_only:true,bind:{create_host_path:false}});
  config.services['browser-proxy']={image:'nginx:stable-alpine',restart:'no',labels:{[owner]:ownerId},networks:['frontend'],volumes:[bind(join(work,'nginx.conf'),'/etc/nginx/nginx.conf'),bind(join(work,'https.crt'),'/run/https.crt'),bind(join(work,'https.key'),'/run/https.key')],depends_on:{web:{condition:'service_healthy'}}};
  config.services.fixture={image:appImageId,user:'node',restart:'no',labels:{[owner]:ownerId},networks:['backend'],environment:{...config.services.web.environment,TEST_DATABASE_URL:`postgresql://postgres:${values.POSTGRES_PASSWORD}@db:5432/allnutrition_test`,TEST_ALLOW_DATABASE_RESET:'allnutrition_test',TEST_DB_SSL:'verify',TEST_DB_CA_CERT_FILE:'/run/db-ca/ca.crt'},volumes:[bind(join(tls,'ca.crt'),'/run/db-ca/ca.crt')],command:['node','tests/e2e/setup.mjs']};
  composeFile=join(work,'compose.json');save(composeFile,config);
  compose(['config','--quiet']);
  compose(['up','-d','--wait','--wait-timeout','120','db']);
  compose(['run','--rm','--no-deps','migrate'],{timeout:600000});
  compose(['run','--rm','--no-deps','fixture'],{timeout:600000});
  compose(['up','-d','--wait','--wait-timeout','180','web','social-browser','social-browser-worker','scheduler','browser-proxy'],{timeout:300000});
  const checkIds = () => {
    for (const [name, expected] of Object.entries(expectedIds)) ensure(container(name).Image === expected, 'Running image identity mismatch: ' + name);
  };
  checkIds();
  proof.beforeKeys=keyState();ensure(proof.beforeKeys.every(d=>d.files.length===0),'Custody must start completely empty');
  proof.beforeHealth=runnerHealth();ensure(proof.beforeHealth.alive===true&&proof.beforeHealth.available===false,'Unconfigured runner must be alive but unavailable');
  const start=Date.now();
  proof.beforeHeartbeats=await until(heartbeat,rows=>rows.length===2&&rows.every(r=>r.state==='succeeded'&&!r.error_code&&Number.isFinite(Date.parse(r.updated_at))&&Date.now()-Date.parse(r.updated_at)<65000),'Worker heartbeats');
  proof.beforeProcesses=Object.fromEntries(['social-browser','social-browser-worker','scheduler'].map(service=>[service,processIdentity(service)]));
  proof.isolation=isolation();
  const syntheticSecret=randomBytes(32).toString('hex');secrets.push(syntheticSecret);
  proof.firstSave=exec('web',settingsScript('first',syntheticSecret));
  proof.keys=keyState();
  ensure(JSON.stringify(proof.keys.map(d=>d.files.map(f=>f.name)))===JSON.stringify([['appSecret.key','media.key','sessions.key','tokens.key'],['control.key']]),'First save must create exactly five private keys');
  proof.afterHealth=await until(runnerHealth,value=>value.alive===true&&value.available===true,'Runner key readiness');
  proof.disabled=exec('web',settingsScript('disable'));
  proof.enabled=exec('web',settingsScript('enable'));
  proof.signedClose=exec('social-browser-worker',`
    const {createBrowserClient}=await import('./lib/social/browser-client.mjs');
    const {createIntegrationKeyring}=await import('./lib/integrations/keyring.mjs');
    const {openStore}=await import('./lib/db/index.mjs');
    const {loadSocialRuntime}=await import('./lib/social/config.mjs');
    const {randomBytes}=await import('node:crypto');
    const store=await openStore();let runtime;
    try{runtime=await loadSocialRuntime(store);}finally{await store.close();}
    if(runtime.publishingEnabled||!runtime.browserEnabled)throw Error('FLAGS');
    const key=await createIntegrationKeyring().read('control',{required:true});
    const id='acceptance_'+randomBytes(16).toString('hex');
    const session={connectionId:id,sessionEpoch:0,lease:{key:'social:browser-lock:'+id,token:randomBytes(32).toString('base64url'),leaseUntil:new Date(Date.now()+60000).toISOString()}};
    const client=createBrowserClient({baseUrl:process.env.SOCIAL_BROWSER_URL,controlKey:key,runtime});
    let errorCode=null;
    try{await client.close(session);}catch(error){errorCode=error.errorCode;}
    if(errorCode!=='LEASE_LOST')throw Error('SIGNED_CLOSE_EXPECTED_UNUSED_SESSION');
    let wrongKey=randomBytes(32);
    while(wrongKey.equals(key))wrongKey=randomBytes(32);
    const unauthenticated=createBrowserClient({baseUrl:process.env.SOCIAL_BROWSER_URL,controlKey:wrongKey,runtime});
    let wrongKeyErrorCode=null;
    try{await unauthenticated.close(session);}catch(error){wrongKeyErrorCode=error.errorCode;}
    if(wrongKeyErrorCode!=='AUTH_FAILED')throw Error('WRONG_CONTROL_KEY_NOT_REJECTED');
    console.log(JSON.stringify({errorCode,wrongKeyErrorCode,signed:true,authenticated:true,unusedSessionRejected:true,providerOpened:false,configurationVersion:runtime.configurationVersion}));
  `);
  proof.sandbox=exec('social-browser',`
    const {chromium}=await import('playwright'),fs=await import('node:fs'),{createHash}=await import('node:crypto');
    const options={headless:true,chromiumSandbox:true},browser=await chromium.launch(options);
    try{
      const context=await browser.newContext({serviceWorkers:'block'});let blocked=0;
      await context.route('**/*',route=>{blocked++;return route.abort();});
      const page=await context.newPage();await page.goto('data:text/html,<title>isolated-sandbox-acceptance</title>');
      if(await page.title()!=='isolated-sandbox-acceptance'||blocked!==0)throw Error('ISOLATED_PAGE');
      const children=[];
      for(const id of fs.readdirSync('/proc').filter(v=>/^\\d+$/.test(v))){try{
        const stat=fs.readFileSync('/proc/'+id+'/stat','utf8'),ppid=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);
        const args=fs.readFileSync('/proc/'+id+'/cmdline','utf8').split(String.fromCharCode(0)).filter(Boolean);
        if(ppid===process.pid&&args.includes('--remote-debugging-pipe'))children.push({id:Number(id),args});
      }catch{}}
      if(children.length!==1)throw Error('CHROMIUM_PROCESS_COUNT');
      const {id:browserPid,args}=children[0];
      if(args.some(v=>v==='--no-sandbox'||v==='--disable-setuid-sandbox'))throw Error('SANDBOX_DISABLED');
      const status=Object.fromEntries(fs.readFileSync('/proc/'+browserPid+'/status','utf8').split(String.fromCharCode(10)).filter(v=>v.includes(':')).map(v=>{const i=v.indexOf(':');return[v.slice(0,i),v.slice(i+1).trim()];}));
      if(status.NoNewPrivs!=='1'||status.Seccomp!=='2'||status.Uid.split(String.fromCharCode(9)).some(v=>v!=='1000'))throw Error('CHROMIUM_PROCESS_ISOLATION');
      console.log(JSON.stringify({options,version:browser.version(),dataPageLoaded:true,providerRequests:0,noSandboxBypass:true,browserPid,noNewPrivileges:1,seccomp:2,commandLineSha256:createHash('sha256').update(JSON.stringify(args)).digest('hex')}));
    }finally{await browser.close();}
  `);
  proof.afterHeartbeats=await until(heartbeat,rows=>rows.length===2&&rows.every(row=>row.state==='succeeded'&&!row.error_code&&Date.parse(row.updated_at)>Math.max(start,Date.parse(proof.beforeHeartbeats.find(old=>old.key===row.key).updated_at))),'Continued worker heartbeats',100000);
  proof.afterProcesses=Object.fromEntries(['social-browser','social-browser-worker','scheduler'].map(service=>[service,processIdentity(service)]));
  ensure(JSON.stringify(proof.beforeProcesses)===JSON.stringify(proof.afterProcesses),'Runner or worker process changed while configuring');
  proof.finalHealth=runnerHealth();ensure(proof.finalHealth.alive===true&&proof.finalHealth.available===true,'Runner final readiness');
  proof.finalSettings=exec('web',`const {openStore}=await import('./lib/db/index.mjs');const {getSocialSettings}=await import('./lib/business/social-settings.mjs');const store=await openStore();try{const v=await getSocialSettings(store);if(v.publishingEnabled||!v.browserEnabled||v.version!==3)throw Error('FINAL_FLAGS');console.log(JSON.stringify({version:v.version,publishingEnabled:v.publishingEnabled,browserEnabled:v.browserEnabled}));}finally{await store.close();}`);
  checkIds();
  sourceVerified();identity(inspect('image',imageId),imageId);identity(inspect('image',appImageId),appImageId);
  if (pair) ensure(isDeepStrictEqual(pairIdentities(),expectedIds),'Loaded image identity changed during pair acceptance');
  else ensure(inspect('image',releaseTag).Id===imageId&&inspect('image',legacyAppTag).Id===appImageId,'Release tag changed during acceptance');
  return { images: expectedIds };
}

let failure = null, cleanupProof = null, extras = {};
try {
  ensure(pair ? process.argv.length===4 : ['build','verify'].includes(mode)&&process.argv.length===3,'Usage: node browser-acceptance.mjs build | verify | pair <manifest>');
  ensure(process.platform==='linux'&&process.arch==='x64'&&process.versions.node.startsWith('24.')&&process.getuid()===1000&&process.getgid()===1000,'Native Linux/amd64 Node24 UID/GID1000 required');
  if (pair) {
    ensure(![candidate,configRoot].some(path => path === '/home/allnutrition/app' || path.startsWith('/home/allnutrition/app/')), 'Production checkout is not a test source');
    work=mkdtempSync(join(tmpdir(),`allnutrition-browser-${token}-`));
  } else {
    ensure(resolve(root)===dirname(candidate)&&root!==manifest.productionRoot,'Helper must run only from its native root');
    ensure(!lstatSync(root).isSymbolicLink()&&(lstatSync(root).mode&511)===0o700,'Native root must be private');
    work=join(root,`browser-${mode}-${token}`);mkdirSync(work,{mode:0o700});
    const existing=join(root,mode==='build'?'runner-image.json':'browser-acceptance.json');
    ensure(!existsSync(existing)||JSON.parse(readFileSync(existing)).accepted!==true,'Successful metadata already exists; refusing to replace observed acceptance');
    sourceVerified();
  }
  for(const kind of ['container','volume','network'])ensure(resources(kind).length===0,'Disposable project unexpectedly exists');
  extras=await (mode==='build'?build():verify());
} catch(error) {
  failure={name:error.name,code:error.code||null,message:safe(error.message)};
  if(work)save(join(work,'failure.json'),failure);
} finally {
  if(work){
    if(failure&&composeFile){try{compose(['logs','--no-color','--tail','160'],{logOutput:true});}catch{ /* The original failure remains primary. */ }}
    try{cleanupProof=cleanup();save(join(work,'cleanup.json'),cleanupProof);}catch(error){const cleanupFailure={name:error.name,message:safe(error.message)};save(join(work,'cleanup-failure.json'),cleanupFailure);if(!failure)failure=cleanupFailure;}
  }
}
if(work){
  const result={accepted:!failure&&cleanupProof?.zeroOwnedLeftovers===true,imageId,releaseTag,appImageId,archiveSha256:manifest.archiveSha256,manifestSha256,proof,cleanup:cleanupProof,failure,diagnostics:work,productionWrites:false,...extras};
  if (pair) {
    rmSync(work,{recursive:true,force:true});
    console.log(JSON.stringify({accepted:result.accepted,images:extras.images,zeroOwnedLeftovers:cleanupProof?.zeroOwnedLeftovers===true,failure}));
  } else {
    const destination=join(root,mode==='build'?'runner-image.json':'browser-acceptance.json');
    if(!existsSync(destination)||JSON.parse(readFileSync(destination)).accepted!==true)save(destination,result);
    console.log(JSON.stringify({accepted:result.accepted,imageId,releaseTag,appImageId,diagnostics:work,zeroOwnedLeftovers:cleanupProof?.zeroOwnedLeftovers===true}));
  }
  process.exitCode=result.accepted?0:1;
}else{console.error('Native browser acceptance refused: '+(failure?.message||'unknown failure'));process.exitCode=1;}
