import type { InferenceEngine } from './types.js';
import { createPythonEngine } from './python-inference.js';

export async function createInferenceEngine(modelDirectory: string, signal?: AbortSignal): Promise<InferenceEngine> {
  signal?.throwIfAborted();
  return createPythonEngine(modelDirectory, signal);
}
