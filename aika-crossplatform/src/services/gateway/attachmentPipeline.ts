/**
 * 附件入口与音频文件转写（GW-03）。
 *
 * 三条边界：
 * - **只收平台受控下载地址**：URL 由平台 fileId 构造，重定向后再次白名单校验，
 *   禁止任意 URL 抓取。
 * - 附件白名单：纯文本/Markdown/JSON + 受支持音频；image/PDF/office/压缩包
 *   明确不支持。文件名拒绝路径穿越、绝对路径、控制字符。
 * - 音频识别经 STT 拥有的 `AudioTranscriptionPort`：注入解码/重采样边界，
 *   复用 Whisper 请求（16kHz 单声道 Float32Array）。**不能把 OGG/Opus 塞给
 *   麦克风端口**；能力缺失明确 unsupported，不偷偷降级。
 */

import type { WhisperClient } from "../voice/whisperClient";

export interface AttachmentFileMeta {
  fileName: string;
  mediaType: string;
  sizeBytes: number;
}

export const MAX_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;

const SUPPORTED_TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".json"];
const SUPPORTED_AUDIO_MEDIA = ["audio/ogg", "audio/opus", "audio/mpeg", "audio/wav", "audio/x-wav"];

/** 元数据校验：路径穿越/绝对路径/控制字符/超限/不支持类型全部拒绝（GW-03-A）。 */
export function validateAttachmentFile(meta: AttachmentFileMeta, maxBytes = MAX_ATTACHMENT_FILE_BYTES): string | null {
  if (!meta.fileName.trim()) return "文件名为空";
  if (meta.fileName.length > 255) return "文件名过长";
  // 控制字符。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f<>:"|?*]/.test(meta.fileName)) return "文件名含非法字符";
  // 路径穿越与绝对路径：Windows 盘符、反斜杠、连续点段、UNC。
  const lowered = meta.fileName.toLowerCase();
  if (lowered.includes("..") || /^[a-z]:[\\/]/.test(lowered) || lowered.startsWith("\\\\")
    || meta.fileName.includes("/") || meta.fileName.includes("\\")) {
    return "文件名含路径成分";
  }
  if (!Number.isFinite(meta.sizeBytes) || meta.sizeBytes <= 0) return "大小非法";
  if (meta.sizeBytes > maxBytes) return "超过大小上限";

  const media = meta.mediaType.toLowerCase();
  const extension = lowered.slice(lowered.lastIndexOf("."));
  const isText = SUPPORTED_TEXT_EXTENSIONS.includes(extension) && (media.startsWith("text/") || media === "application/json" || media === "");
  const isAudio = SUPPORTED_AUDIO_MEDIA.includes(media);
  if (!isText && !isAudio) return `不支持的附件类型：${meta.mediaType}`;
  return null;
}

export function isAudioAttachment(meta: AttachmentFileMeta): boolean {
  return SUPPORTED_AUDIO_MEDIA.includes(meta.mediaType.toLowerCase());
}

/** 平台受控下载地址：只能由 fileId 构造，不接受调用方给的任意 URL。 */
export function buildControlledDownloadUrl(baseUrl: string, botToken: string, fileId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
}

/** 重定向后再校验：主机不在白名单 → 拒绝。 */
export function assertAllowedDownloadHost(url: string, allowedHosts: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    return allowedHosts.includes(parsed.host);
  } catch {
    return false;
  }
}

export interface DownloadLimits {
  maxBytes: number;
  timeoutMs: number;
  allowedHosts: readonly string[];
  signal?: AbortSignal;
}

export interface DownloadResult {
  ok: boolean;
  bytes?: Uint8Array;
  reason?: "timeout" | "too-large" | "bad-host" | "http-error" | "aborted";
}

/**
 * 受限下载：超时、大小上限、逐跳主机白名单（重定向必须重新过白名单）。
 * fetchImpl 需要把最终 URL 交回来（redirect: "manual" 的真实实现负责）。
 */
export async function downloadWithLimits(
  fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number; finalUrl: string; bytes: Uint8Array }>,
  url: string,
  limits: DownloadLimits,
): Promise<DownloadResult> {
  if (!assertAllowedDownloadHost(url, limits.allowedHosts)) return { ok: false, reason: "bad-host" };
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(limits.timeoutMs) : undefined;
  const signal = limits.signal
    ? (timeout ? AbortSignal.any([limits.signal, timeout]) : limits.signal)
    : timeout;
  let response: { status: number; finalUrl: string; bytes: Uint8Array };
  try {
    response = await fetchImpl(url, { signal });
  } catch {
    return { ok: false, reason: limits.signal?.aborted ? "aborted" : "timeout" };
  }
  if (response.status !== 200) return { ok: false, reason: "http-error" };
  if (!assertAllowedDownloadHost(response.finalUrl, limits.allowedHosts)) return { ok: false, reason: "bad-host" };
  if (response.bytes.length > limits.maxBytes) return { ok: false, reason: "too-large" };
  return { ok: true, bytes: response.bytes };
}

/**
 * STT 拥有的音频文件转写端口（GW-03 全文审阅）。
 * 与 `SpeechInputEngine`（麦克风）完全分开：文件走 decode→16kHz 单声道→Whisper。
 */
export interface AudioTranscriptionPort {
  /** 能力缺失时返回 unsupported（明确不支持，不偷偷降级）。 */
  transcribe(input: { bytes: Uint8Array; mediaType: string; signal?: AbortSignal }):
    Promise<{ ok: true; text: string } | { ok: false; reason: "unsupported" | "decode-failed" | "aborted" | "empty" }>;
}

export interface FileTranscriptionOptions {
  /** 未配置 Whisper 客户端 = 能力缺失，明确 unsupported。 */
  whisperClient?: WhisperClient;
  /** 注入的解码/重采样边界：容器字节 → 16kHz 单声道 Float32Array。 */
  decodeToPcm16kMono: (bytes: Uint8Array, mediaType: string) => Float32Array;
}

export function createFileTranscriptionPort(options: FileTranscriptionOptions): AudioTranscriptionPort {
  return {
    async transcribe(input) {
      if (!options.whisperClient) return { ok: false, reason: "unsupported" };
      if (input.signal?.aborted) return { ok: false, reason: "aborted" };
      let samples: Float32Array;
      try {
        samples = options.decodeToPcm16kMono(input.bytes, input.mediaType);
      } catch {
        return { ok: false, reason: "decode-failed" };
      }
      if (samples.length === 0) return { ok: false, reason: "empty" };
      if (input.signal?.aborted) return { ok: false, reason: "aborted" };
      const text = await options.whisperClient.transcribe(samples);
      return { ok: true, text: text.trim() };
    },
  };
}

/** 文本附件提取：UTF-8 解码（容量校验已在上游做过）。 */
export function extractTextAttachment(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
}

/**
 * 临时附件生命周期：取消/失败时 dispose 清理。
 * 真实宿主的临时文件实现负责把 blob 落盘/删除；这里冻结契约与清理责任。
 */
export interface TempAttachment {
  meta: AttachmentFileMeta;
  bytes: Uint8Array;
  dispose(): void;
}

export function createTempAttachment(meta: AttachmentFileMeta, bytes: Uint8Array): TempAttachment & { disposed: boolean } {
  let disposed = false;
  return {
    meta,
    bytes,
    get disposed() {
      return disposed;
    },
    dispose() {
      disposed = true;
      bytes.fill(0);
    },
  };
}
