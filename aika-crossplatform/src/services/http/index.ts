import type { HttpFetch } from "./tokens";

export { FetchToken, type HttpFetch } from "./tokens";

/** 浏览器请求出口。 */
export function createBrowserFetch(): HttpFetch {
  return (input, init) => globalThis.fetch(input, init);
}

/**
 * 过渡转发。
 *
 * 与 secretStore / openStorage 同理：默认走浏览器 fetch，**不再嗅探平台**；
 * 桌面宿主在启动时把 plugin-http 的实现装上。CORE-06 删除本段，届时
 * whisperClient 与 providerClient 改为从注册表取 FetchToken。
 */
let installed: HttpFetch | null = null;

export function installHttpFetch(fetchImpl: HttpFetch): void {
  installed = fetchImpl;
}

/** 测试用：把过渡槽恢复到未安装状态。 */
export function resetInstalledHttpFetch(): void {
  installed = null;
}

/** @deprecated 过渡用，改从注册表取 FetchToken；CORE-06 删除。 */
export function activeFetch(input: string, init: RequestInit): Promise<Response> {
  return (installed ?? globalThis.fetch.bind(globalThis))(input, init);
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
