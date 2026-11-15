import { HttpError } from './errors.js';
import type { InferenceEngine } from './types.js';

/** Keeps HTTP available while the local models initialize or report a failure. */
export class InferenceRuntime implements InferenceEngine {
  private engine?: InferenceEngine;
  private initialization?: Promise<void>;
  private shutdown?: Promise<void>;
  private failure?: Error;
  private closed = false;
  private abort = new AbortController();

  constructor(private readonly factory: (signal: AbortSignal) => Promise<InferenceEngine>) {}

  get ready() { return !this.closed && this.engine?.ready === true; }
  get detector() { return this.engine?.detector ?? 'classroom' as const; }
  get capabilities() { return this.engine?.capabilities; }
  get metrics() { return this.engine?.metrics; }
  get startupState(): 'loading' | 'ready' | 'error' {
    return this.ready ? 'ready' : this.failure || this.engine || this.closed ? 'error' : 'loading';
  }
  get startupError() {
    return this.failure?.message ?? this.engine?.startupError ?? (this.engine && !this.engine.ready
      ? 'Luồng AI đã dừng. Kiểm tra terminal backend rồi khởi động lại.' : undefined);
  }

  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.initialization ??= (async () => {
      try {
        const engine = await this.factory(this.abort.signal);
        if (this.closed) await engine.close();
        else this.engine = engine;
      } catch (error) {
        if (!this.closed) this.failure = error instanceof Error ? error : new Error(String(error));
      }
    })();
  }

  trackFrame(jpeg: Buffer, context: Parameters<NonNullable<InferenceEngine['trackFrame']>>[1]) {
    if (!this.ready) return Promise.reject(new HttpError(503,
      this.startupError ?? 'Backend đang nạp mô hình AI. Vui lòng chờ.'));
    if (!this.engine!.trackFrame) return Promise.reject(new HttpError(503, 'Backend chưa hỗ trợ luồng bám hình ảnh.'));
    return this.engine!.trackFrame(jpeg, context);
  }
  seedGeometry(sessionId: string, seeds: Parameters<NonNullable<InferenceEngine['seedGeometry']>>[1]) {
    if (this.ready) this.engine!.seedGeometry?.(sessionId, seeds);
  }
  detect(jpeg: Buffer, context?: Parameters<InferenceEngine['detect']>[1]) {
    if (!this.ready) return Promise.reject(new HttpError(503,
      this.startupError ?? 'Backend đang nạp mô hình AI. Vui lòng chờ.'));
    return this.engine!.detect(jpeg, context);
  }
  async detectFrame(jpeg: Buffer, context?: Parameters<NonNullable<InferenceEngine['detectFrame']>>[1]) {
    if (!this.ready) throw new HttpError(503, this.startupError ?? 'Backend đang nạp mô hình AI. Vui lòng chờ.');
    return this.engine!.detectFrame ? this.engine!.detectFrame(jpeg,context)
      : {people:await this.engine!.detect(jpeg,context),objects:[]};
  }
  release(sessionId: string) { this.engine?.release?.(sessionId); }

  close(): Promise<void> {
    return this.shutdown ??= (async () => {
      this.closed = true;
      this.abort.abort();
      await this.initialization;
      await this.engine?.close();
    })();
  }
}
