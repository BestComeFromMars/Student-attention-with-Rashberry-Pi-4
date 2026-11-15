import {constants} from 'node:fs';
import {mkdir,readdir,copyFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';

const version=name=>/^v([1-9]\d*)\.mp4$/.exec(name);

export async function nextDemoVersion(directory){
  await mkdir(directory,{recursive:true});
  const previous=(await readdir(directory)).map(name=>version(name)).filter(Boolean).map(match=>Number(match[1]));
  return 'v'+(Math.max(0,...previous)+1);
}

/** Publish only a verified video. Keep the previous version until copying succeeds. */
export async function publishDemoVideo(staged,directory,stem){
  if(!/^v[1-9]\d*$/.test(stem))throw Error('Invalid demo version');
  const output=resolve(directory,stem+'.mp4');
  await copyFile(staged,output,constants.COPYFILE_EXCL);
  for(const name of await readdir(directory)){
    const old=version(name);
    if(old&&Number(old[1])<Number(stem.slice(1)))await unlink(resolve(directory,name));
  }
  return output;
}
