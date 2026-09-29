import { readdirSync,readFileSync,existsSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const loaded=await import(process.env.TYPESCRIPT_PATH?pathToFileURL(process.env.TYPESCRIPT_PATH).href:'typescript');
const ts=loaded.default||loaded;let errors=0,files=0;
function check(folder){for(const entry of readdirSync(folder,{withFileTypes:true})){
 const path=resolve(folder,entry.name);if(entry.isDirectory()){if(!['node_modules','.next','.git','docs','public','.test-data'].includes(entry.name))check(path);continue;}
 if(!/\.(mjs|jsx|js)$/.test(entry.name))continue;files++;
 const source=readFileSync(path,'utf8');
 const parsed=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,path.endsWith('jsx')?ts.ScriptKind.JSX:ts.ScriptKind.JS);
 for(const diagnostic of parsed.parseDiagnostics){errors++;console.error(path,ts.flattenDiagnosticMessageText(diagnostic.messageText,' '));}
 for(const match of source.matchAll(/(?:from\s*|import\s*)['"]([.@][^'"]+)['"]/g)){
  const spec=match[1];if(!spec.startsWith('.')&&!spec.startsWith('@/'))continue;
  const base=spec.startsWith('@/')?resolve(spec.slice(2)):resolve(dirname(path),spec);
  if(!['','.js','.jsx','.mjs','/index.js','/index.mjs'].some(ext=>existsSync(base+ext))){errors++;console.error(`Import no encontrado: ${path}: ${spec}`);}
 }
}}
check('.');console.log(`${files} archivos JavaScript/JSX revisados; ${errors} errores de sintaxis/imports locales. No sustituye next build.`);process.exitCode=errors?1:0;
