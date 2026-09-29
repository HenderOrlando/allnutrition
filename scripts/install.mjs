import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',[existsSync('package-lock.json')?'ci':'install'],{stdio:'inherit'});
process.exit(result.status??1);
