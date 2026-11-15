import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile,rename,unlink,rmdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {viteCacheDirectory} from '../dev/cache-directory.ts';

// Recreate the failing operation: optimize twice, replacing deps/package.json.
// No HTTP listener, camera, backend, or full application dependency scan is needed.
const root=fileURLToPath(new URL('../',import.meta.url));
const cacheDir=viteCacheDirectory(new URL('../vite.config.ts',import.meta.url).href);
await mkdir(cacheDir,{recursive:true});
const probe=await mkdtemp(resolve(cacheDir,'permissions-'));
try{
  const original=resolve(probe,'package.json');
  const replacement=resolve(probe,'replacement.json');
  await writeFile(original,'{}');
  await writeFile(replacement,'{"type":"module"}');
  await unlink(original);
  await rename(replacement,original);
  await unlink(original);
}finally{await rmdir(probe);}
console.log('Cache create/replace/delete permissions passed: '+cacheDir);
if(!process.argv.includes('--permissions-only')){
const {optimizeDeps,resolveConfig}=await import('vite');
const config=await resolveConfig({root,cacheDir,logLevel:'silent',
  optimizeDeps:{noDiscovery:true,entries:[],include:['react','react-dom/client']}},'serve');
const scoped=relative(resolve(root,'.vite-cache'),config.cacheDir);
assert(scoped && !scoped.startsWith('..') && !isAbsolute(scoped),'Vite cache must use the account-scoped project folder');
for(let pass=0;pass<2;pass++){
  await optimizeDeps(config,true,true);
  const metadata=JSON.parse(await readFile(resolve(config.cacheDir,'deps/package.json'),'utf8'));
  assert.equal(metadata.type,'module');
}
console.log('Vite cache creation and forced replacement passed twice: '+config.cacheDir);
}
