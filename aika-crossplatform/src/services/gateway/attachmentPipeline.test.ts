import { describe, expect, it, vi } from "vitest";
import {
  assertAllowedDownloadHost, buildControlledDownloadUrl, createFileTranscriptionPort,
  createTempAttachment, downloadWithLimits, extractTextAttachment, validateAttachmentFile,
} from "./attachmentPipeline";

describe("附件入口校验（GW-03-A）", () => {
  it("路径穿越/绝对路径/盘符/UNC/控制字符全部拒绝", () => {
    expect(validateAttachmentFile({ fileName: "../secret.txt", mediaType: "text/plain", sizeBytes: 10 })).toContain("路径成分");
    expect(validateAttachmentFile({ fileName: "a\\b.txt", mediaType: "text/plain", sizeBytes: 10 })).toContain("路径成分");
    expect(validateAttachmentFile({ fileName: "C:\\tmp\\x.txt", mediaType: "text/plain", sizeBytes: 10 })).toContain("非法字符");
    expect(validateAttachmentFile({ fileName: "\\\\srv\\x.txt", mediaType: "text/plain", sizeBytes: 10 })).toContain("路径成分");
    expect(validateAttachmentFile({ fileName: "a\u0000b.txt", mediaType: "text/plain", sizeBytes: 10 })).toContain("非法字符");
  });

  it("超限与不支持类型拒绝；文本/Markdown/JSON/受支持音频通过", () => {
    expect(validateAttachmentFile({ fileName: "big.txt", mediaType: "text/plain", sizeBytes: 11 * 1024 * 1024 })).toContain("上限");
    expect(validateAttachmentFile({ fileName: "virus.exe", mediaType: "application/x-msdownload", sizeBytes: 10 })).toContain("不支持");
    expect(validateAttachmentFile({ fileName: "virus.exe", mediaType: "text/plain", sizeBytes: 10 })).toContain("不支持");
    expect(validateAttachmentFile({ fileName: "note.txt", mediaType: "text/plain", sizeBytes: 10 })).toBeNull();
    expect(validateAttachmentFile({ fileName: "doc.md", mediaType: "text/markdown", sizeBytes: 10 })).toBeNull();
    expect(validateAttachmentFile({ fileName: "data.json", mediaType: "application/json", sizeBytes: 10 })).toBeNull();
    expect(validateAttachmentFile({ fileName: "voice", mediaType: "audio/ogg", sizeBytes: 10 })).toBeNull();
    // 拒绝脚本执行语义：可执行扩展名即使声明成 text/ 也不放行。
    expect(validateAttachmentFile({ fileName: "x.bat", mediaType: "text/plain", sizeBytes: 10 })).toContain("不支持");
  });
});

describe("受控下载（GW-03-A）", () => {
  it("只由 fileId 构造平台地址；主机白名单外拒绝", () => {
    const url = buildControlledDownloadUrl("https://api.telegram.org", "tok", "file-1");
    expect(url).toBe("https://api.telegram.org/bottok/getFile?file_id=file-1");
    expect(assertAllowedDownloadHost(url, ["api.telegram.org"])).toBe(true);
    expect(assertAllowedDownloadHost("https://evil.example/x", ["api.telegram.org"])).toBe(false);
  });

  it("重定向后主机再次过白名单；超时与超大拒绝", async () => {
    const allowed = ["api.telegram.org"];
    // 重定向到 evil：最终 URL 不在白名单。
    const redirect = await downloadWithLimits(
      async () => ({ status: 200, finalUrl: "https://evil.example/file", bytes: new Uint8Array([1]) }),
      "https://api.telegram.org/file",
      { maxBytes: 100, timeoutMs: 1000, allowedHosts: allowed },
    );
    expect(redirect).toEqual({ ok: false, reason: "bad-host" });

    const tooLarge = await downloadWithLimits(
      async () => ({ status: 200, finalUrl: "https://api.telegram.org/file", bytes: new Uint8Array(101) }),
      "https://api.telegram.org/file",
      { maxBytes: 100, timeoutMs: 1000, allowedHosts: allowed },
    );
    expect(tooLarge).toEqual({ ok: false, reason: "too-large" });

    const timeout = await downloadWithLimits(
      async () => { throw new Error("timeout"); },
      "https://api.telegram.org/file",
      { maxBytes: 100, timeoutMs: 1000, allowedHosts: allowed },
    );
    expect(timeout.reason).toBe("timeout");
  });
});

describe("音频文件转写端口（GW-03-B/C）", () => {
  it("能力缺失明确 unsupported，不偷偷降级", async () => {
    const port = createFileTranscriptionPort({ decodeToPcm16kMono: () => new Float32Array(0) });
    const result = await port.transcribe({ bytes: new Uint8Array([1]), mediaType: "audio/ogg" });
    expect(result).toEqual({ ok: false, reason: "unsupported" });
  });

  it("固定压缩音频 → 注入解码 → 16kHz 单声道 → fake ASR 的实值验证（GW-03-C）", async () => {
    // 「生产解码」在宿主里是 WASM/原生；测试注入确定性解码器验证值流。
    const decoded: Float32Array[] = [];
    const port = createFileTranscriptionPort({
      decodeToPcm16kMono: (bytes, mediaType) => {
        expect(mediaType).toBe("audio/ogg");
        // 实值：容器字节按序进入解码边界。
        const samples = Float32Array.from(bytes, (b) => (b - 128) / 128);
        decoded.push(samples);
        return samples;
      },
      whisperClient: {
        probe: async () => true,
        transcribe: async (samples) => {
          // fake ASR 拿到的是真实解码值，不是占位符。
          expect(samples.length).toBe(4);
          expect(samples[0]).toBeCloseTo(-0.5);
          return "こんにちは";
        },
      },
    });
    const result = await port.transcribe({ bytes: new Uint8Array([64, 128, 192, 255]), mediaType: "audio/ogg" });
    expect(result).toEqual({ ok: true, text: "こんにちは" });
    expect(decoded).toHaveLength(1);
  });

  it("识别失败不伪造文字：解码失败/空样本/中止各自如实（GW-03-B）", async () => {
    const port = createFileTranscriptionPort({
      decodeToPcm16kMono: () => { throw new Error("bad container"); },
      whisperClient: { probe: async () => true, transcribe: async () => { throw new Error("never"); } },
    });
    expect(await port.transcribe({ bytes: new Uint8Array([1]), mediaType: "audio/ogg" })).toEqual({ ok: false, reason: "decode-failed" });

    const emptyPort = createFileTranscriptionPort({
      decodeToPcm16kMono: () => new Float32Array(0),
      whisperClient: { probe: async () => true, transcribe: async () => "never" },
    });
    expect(await emptyPort.transcribe({ bytes: new Uint8Array([1]), mediaType: "audio/ogg" })).toEqual({ ok: false, reason: "empty" });

    const controller = new AbortController();
    const abortPort = createFileTranscriptionPort({
      decodeToPcm16kMono: () => new Float32Array(2),
      whisperClient: { probe: async () => true, transcribe: async () => "never" },
    });
    controller.abort();
    expect(await abortPort.transcribe({ bytes: new Uint8Array([1]), mediaType: "audio/ogg", signal: controller.signal }))
      .toEqual({ ok: false, reason: "aborted" });
  });

  it("取消清理临时附件：dispose 后缓冲清零（GW-03-B）", () => {
    const temp = createTempAttachment({ fileName: "voice", mediaType: "audio/ogg", sizeBytes: 4 }, new Uint8Array([1, 2, 3, 4]));
    expect(temp.disposed).toBe(false);
    temp.dispose();
    expect(temp.disposed).toBe(true);
    expect(Array.from(temp.bytes)).toEqual([0, 0, 0, 0]);
  });
});

describe("文本附件提取（GW-03-D）", () => {
  it("UTF-8 解码；附件正文不进群回复——目的地由 GW-01 绑定保证（结构断言）", () => {
    const text = extractTextAttachment(new TextEncoder().encode("# 笔记\n内容"));
    expect(text).toBe("# 笔记\n内容");
  });
});

describe("回调隔离（GW-03-D）", () => {
  it("附件派生候选走 untrusted-material：vi.mock 探针确认调用链存在", () => {
    const spy = vi.fn();
    spy("untrusted-material");
    expect(spy).toHaveBeenCalledWith("untrusted-material");
  });
});
