type Level = 'info' | 'warn' | 'error' | 'debug';
const labels = { info: 'THÔNG TIN', warn: 'CẢNH BÁO', error: 'LỖI', debug: 'CHI TIẾT' };
const clock = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const recent = new Map<string, number>();

export function redact(message: string) {
  let text = message.replace(/\b(?:rtsp|https?):\/\/[^\s"']+/gi, value => {
    try { const url = new URL(value); return url.username || url.password || url.search ? url.protocol + '//[đã ẩn thông tin riêng]' : value; }
    catch { return '[địa chỉ đã ẩn]'; }
  }).replace(/Bearer\s+\S+/gi, 'Bearer [đã ẩn]');
  for (const value of [process.env.PI_TOKEN, process.env.PI_RTSP_URL]) if (value) text = text.split(value).join('[đã ẩn]');
  return text.replace(/[\r\n]+/g, ' ').slice(0, 1200);
}

export function log(area: string, message: string, level: Level = 'info', key?: string) {
  if (level === 'debug' && process.env.AI_DEBUG !== '1') return;
  if (key) {
    if (Date.now() - (recent.get(key) ?? 0) < 10000) return;
    recent.set(key, Date.now());
    if (recent.size > 200) recent.delete(recent.keys().next().value!);
  }
  const line = `${clock.format(new Date())} | ${labels[level].padEnd(9)} | ${area.padEnd(11)} | ${redact(message)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Native libraries may emit verbose initialization warnings in fragmented chunks.
 * Our own stage messages are translated; raw diagnostics require AI_DEBUG=1. */
export function nativeLog(line: string) {
  const stages: Record<string, string> = {
    'AI: warming YOLO models': 'Đang chuẩn bị mô hình người, đồ vật và tư thế.',
    'AI: loading verified CavT checkpoint': 'Đang nạp mô hình CavT cho chuỗi khuôn mặt.',
    'AI: all pipelines ready': 'Các luồng xử lý đã nạp xong.',
  };
  if (stages[line.trim()]) log('AI', stages[line.trim()]);
  else if (line.startsWith('AI process memory MB:')) {
    const mb = line.match(/MB:\s*(\d+)/)?.[1];
    log('AI', `Bộ nhớ khởi tạo khoảng ${mb ?? '?'} MB; xử lý trên máy tính.`);
  } else log('THƯ VIỆN', line, 'debug');
}
