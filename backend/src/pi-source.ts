import type { Response } from 'express';
import sharp from 'sharp';
import { HttpError } from './errors.js';
import { log } from './logger.js';

export class PiSource {
  private jpeg: Buffer | null = null;
  private receivedAt = 0;
  private width = 0;
  private height = 0;
  private viewers = new Map<Response, { blocked: boolean; pending: boolean; onDrain: () => void }>();
  private revision = 0;
  private updateSequence = 0;
  private publishedSequence = 0;
  status() {
    return { online: this.jpeg !== null && Date.now() - this.receivedAt < 5000, width: this.width, height: this.height, receivedAt: this.receivedAt };
  }
  async update(jpeg: Buffer, decoded = false) {
    const revision = this.revision;
    const sequence = ++this.updateSequence;
    const image = sharp(jpeg, { limitInputPixels: 12_000_000, failOn: 'error' });
    const metadata = await image.metadata();
    if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height) throw new HttpError(422, 'Ảnh Raspberry Pi phải là JPEG hợp lệ.');
    // The private RTSP reader has just decoded and encoded these pixels. Avoid
    // decoding them a second time here; uploads still undergo full validation.
    if (!decoded) await image.stats();
    // Validation runs asynchronously. A slower older upload must never replace
    // a newer camera frame that has already reached the video stream.
    if (revision !== this.revision || sequence <= this.publishedSequence) return;
    this.publishedSequence=sequence;
    this.jpeg = jpeg;
    this.width = metadata.width;
    this.height = metadata.height;
    this.receivedAt = Date.now();
    for (const viewer of this.viewers.keys()) this.writeFrame(viewer);
  }
  frame() {
    if (!this.status().online || !this.jpeg) throw new HttpError(503, 'Raspberry Pi chưa kết nối hoặc đã mất nguồn hình.');
    return this.jpeg;
  }
  stream(response: Response) {
    this.frame();
    response.status(200);
    response.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=student-attention');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Accel-Buffering', 'no');
    response.socket?.setNoDelay(true);
    response.flushHeaders();
    const state = { blocked: false, pending: false, onDrain: () => {
      state.blocked = false;
      if (state.pending) { state.pending = false; this.writeFrame(response); }
    } };
    this.viewers.set(response, state);
    log('CAMERA WEB', `Đã mở video Pi trên web (${this.viewers.size} kết nối).`);
    response.on('drain', state.onDrain);
    const disconnect = () => {
      response.off('drain', state.onDrain);
      if (this.viewers.delete(response)) log('CAMERA WEB', `Đã đóng video Pi trên web (${this.viewers.size} kết nối còn lại).`);
    };
    // Network writes finish asynchronously, outside Express's error handler.
    // A failed browser connection must not become an unhandled stream error.
    // Keep the listener through close to absorb an already queued late error.
    response.on('error', disconnect);
    response.once('close', disconnect);
    this.writeFrame(response);
  }
  private writeFrame(response: Response) {
    const state = this.viewers.get(response);
    if (!this.jpeg || response.destroyed || !state) { this.viewers.delete(response); return; }
    // Finish one multipart frame before writing another. A slow viewer gets
    // only the newest frame on drain, never a queue of old movements.
    if (state.blocked) { state.pending = true; return; }
    const header = Buffer.from('--student-attention\r\nContent-Type: image/jpeg\r\nContent-Length: ' + this.jpeg.length + '\r\n\r\n');
    state.blocked = !response.write(Buffer.concat([header, this.jpeg, Buffer.from('\r\n')]));
  }
  close() {
    ++this.revision;
    for (const [viewer, state] of this.viewers) { viewer.off('drain', state.onDrain); viewer.end(); }
    this.viewers.clear();
    this.jpeg = null;
    this.receivedAt = this.width = this.height = 0;
  }
}
