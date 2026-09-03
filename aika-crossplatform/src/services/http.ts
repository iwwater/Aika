import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * 统一的请求出口。
 *
 * 在 Tauri 里走 http 插件：它从 Rust 侧发请求，不受 WebView 的同源策略约束。
 * 本地 Whisper 服务尤其需要这一点——`http://127.0.0.1:8080` 对应用页面来说是跨源的，
 * 指望对方一定配好 CORS 头是不牢靠的。
 *
 * 浏览器里跑 `npm run dev` 时退回原生 fetch，界面不需要知道自己在哪个上面跑。
 */
export function activeFetch(input: string, init: RequestInit): Promise<Response> {
  return "__TAURI_INTERNALS__" in globalThis ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

export interface MultipartFile {
  field: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * 手搓 multipart/form-data。
 *
 * 不用 FormData 是因为它要经过 Tauri 的 IPC 序列化，行为不好保证；
 * 自己拼字节则是确定的，而且能写单元测试。
 */
export function buildMultipartBody(
  fields: Record<string, string>,
  file: MultipartFile,
  boundary = `aika${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`,
): { body: Uint8Array; contentType: string } {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }

  parts.push(encoder.encode(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`
    + `Content-Type: ${file.contentType}\r\n\r\n`,
  ));
  parts.push(file.bytes);
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
