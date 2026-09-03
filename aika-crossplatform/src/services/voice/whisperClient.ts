import { encodeWav, TARGET_SAMPLE_RATE } from "../../domain/audio";
import { activeFetch, buildMultipartBody } from "../http";

/**
 * 本地 Whisper 客户端。
 *
 * 对面是 whisper.cpp 自带的 `whisper-server`：`POST /inference` 收 multipart，
 * 返回 `{"text": "..."}`。选它而不是把 whisper-rs 编进工程里，是因为这台机器上
 * 没有 cmake 也没有 CUDA toolkit——而官方预编译包带 cuBLAS，装个驱动就能用 GPU。
 * 代价是多一个进程，收益是不用维护 C++ 构建。
 *
 * `language` 固定送 auto。这才是 M3 想要的：用户说日语、中文、英语都不用切换。
 * 但要诚实——Whisper 的检测是**整段**的，一句话里中英混说时，它多半会统一
 * 按主语言转写。比 Web Speech 一次只能给一个语言码强得多，但不是完美的混说识别。
 */

export interface WhisperClient {
  /** 服务在不在。设置页据此显示状态，而不是等用户说完才报错。 */
  probe(): Promise<boolean>;
  /** 转写一段 16 kHz 单声道采样，返回识别文本。听不出内容时返回空串。 */
  transcribe(samples: Float32Array): Promise<string>;
}

export const DEFAULT_WHISPER_ENDPOINT = "http://127.0.0.1:8080";

function cleanEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

/** whisper.cpp 会把纯静音识别成这类固定幻听，落进对话里就是凭空多出一句话。 */
const HALLUCINATIONS = [
  "ご視聴ありがとうございました",
  "ご清聴ありがとうございました",
  "字幕by",
  "字幕製作",
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
  "訂閱",
  "谢谢观看",
  "謝謝觀看",
];

/**
 * 去掉一眼可见的幻听。
 *
 * 判断只看「整段就是这么一句」，不做包含匹配——用户真说了「ありがとうございました」
 * 的时候不能把它吞掉。
 */
export function isLikelyHallucination(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[\s。．，、.,!！?？~〜-]/g, "");
  if (!normalized) return true;
  return HALLUCINATIONS.some((phrase) => normalized === phrase.toLowerCase().replace(/\s/g, ""));
}

/** whisper.cpp 会把非语音段标成 [BLANK_AUDIO]、(music) 这类记号，不该念给用户看。 */
export function stripMarkers(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\*[^*]*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function createWhisperClient(getEndpoint: () => string): WhisperClient {
  return {
    async probe() {
      try {
        const response = await activeFetch(`${cleanEndpoint(getEndpoint())}/`, {
          method: "GET",
          connectTimeout: 2_000,
        } as RequestInit);
        return response.status < 500;
      } catch {
        return false;
      }
    },

    async transcribe(samples) {
      if (!samples.length) return "";

      const { body, contentType } = buildMultipartBody(
        {
          // auto 才是重点：用户不需要在说话前先声明自己要说哪种语言。
          language: "auto",
          response_format: "json",
          temperature: "0",
          // 关掉上下文续传，否则上一段的幻听会一路传染下去。
          no_context: "true",
        },
        {
          field: "file",
          filename: "turn.wav",
          contentType: "audio/wav",
          bytes: encodeWav(samples, TARGET_SAMPLE_RATE),
        },
      );

      const endpoint = cleanEndpoint(getEndpoint());
      let response: Response;
      try {
        response = await activeFetch(`${endpoint}/inference`, {
          method: "POST",
          headers: { "Content-Type": contentType },
          body,
        } as RequestInit);
      } catch (error) {
        throw new Error(`连不上本地语音识别服务 ${endpoint}：${error instanceof Error ? error.message : String(error)}`);
      }

      if (!response.ok) {
        throw new Error(`本地语音识别服务返回 ${response.status}`);
      }

      const data = await response.json().catch(() => null);
      const text = typeof data?.text === "string" ? data.text : "";
      const cleaned = stripMarkers(text);
      return isLikelyHallucination(cleaned) ? "" : cleaned;
    },
  };
}
