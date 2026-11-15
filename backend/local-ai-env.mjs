import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';

/** All new AI dependencies, downloads, caches and temporary files stay here. */
export async function localAIEnv(backend,inherited=process.env){
  const cache=resolve(backend,'.cache'),temporary=resolve(backend,'.tmp');
  const paths={TEMP:temporary,TMP:temporary,PIP_CACHE_DIR:resolve(backend,'.pip-cache'),
    XDG_CACHE_HOME:cache,HF_HOME:resolve(cache,'huggingface'),
    HF_HUB_CACHE:resolve(cache,'huggingface/hub'),HUGGINGFACE_HUB_CACHE:resolve(cache,'huggingface/hub'),
    HF_XET_CACHE:resolve(cache,'huggingface/xet'),TORCH_HOME:resolve(cache,'torch'),
    MPLCONFIGDIR:resolve(cache,'matplotlib'),YOLO_CONFIG_DIR:resolve(temporary,'ultralytics'),
    NUMBA_CACHE_DIR:resolve(cache,'numba')};
  await Promise.all([...new Set(Object.values(paths)),resolve(temporary,'ultralytics/Ultralytics')].map(path=>mkdir(path,{recursive:true})));
  return {...inherited,...paths,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',
    PIP_REQUIRE_VIRTUALENV:'true',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'};
}
