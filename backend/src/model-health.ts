import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export async function checkModel(directory: string): Promise<boolean> {
  try {
    const graph = JSON.parse(await readFile(resolve(directory, 'model.json'), 'utf8'));
    const installation = JSON.parse(await readFile(resolve(directory, 'installation.json'), 'utf8'));
    if (!graph.modelTopology || !Array.isArray(graph.weightsManifest)) return false;
    if (!Array.isArray(installation.files) || !installation.files.length) return false;
    const required = ['model.json', ...graph.weightsManifest.flatMap((group: { paths: string[] }) => group.paths)];
    if (required.length < 2) return false;
    for (const name of required) {
      if (typeof name !== 'string') return false;
      const path = resolve(directory, name);
      const rel = relative(directory, path);
      if (isAbsolute(name) || rel.startsWith('..') || isAbsolute(rel) || path === directory) return false;
      const record = installation.files.find((file: { path: string; bytes: number; sha256: string }) => file.path === name);
      if (!record || (await stat(path)).size !== record.bytes) return false;
      const hash = createHash('sha256').update(await readFile(path)).digest('hex');
      if (hash !== record.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}
