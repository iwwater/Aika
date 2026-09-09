import { describe, expect, it } from "vitest";
import { createVoiceDiagnostics, summarizeVoiceDiagnostics } from "./voiceDiagnostics";

describe("voice diagnostics", () => {
  it("使用有界环形缓冲，只保留无正文事件与可复核元数据", () => {
    const diagnostics = createVoiceDiagnostics(2);
    diagnostics.sink({
      name: "speechEnd",
      atMonotonicMs: 10,
      recordedAtUtc: "2026-09-10T00:00:00.000Z",
      turnId: 4,
      segmentId: "segment-0",
      timeSource: "audio",
      details: { sequence: 0, textLength: 6 },
    });
    diagnostics.sink({ name: "asrFinal", atMonotonicMs: 20, recordedAtUtc: "2026-09-10T00:00:00.010Z", turnId: 4, segmentId: "segment-0" });
    diagnostics.sink({ name: "turnCommitted", atMonotonicMs: 30, recordedAtUtc: "2026-09-10T00:00:00.020Z", turnId: 4, details: { textLength: 6 } });

    const snapshot = diagnostics.snapshot();
    expect(snapshot.events.map((event) => event.name)).toEqual(["asrFinal", "turnCommitted"]);
    expect(snapshot.metadata).toMatchObject({ vadTailSilenceMs: 120, audioSampleRateHz: 16_000, maxEvents: 2 });
    expect(diagnostics.exportJson()).not.toContain("今日は");
  });

  it("可以清空并再次导出", () => {
    const diagnostics = createVoiceDiagnostics();
    diagnostics.sink({ name: "interruptDetected", atMonotonicMs: 1, recordedAtUtc: "2026-09-10T00:00:00.000Z", turnId: 9 });
    diagnostics.clear();
    expect(diagnostics.snapshot().events).toEqual([]);
  });

  it("按 turn 关联事件并把 stop request 作为代理样本单独计算", () => {
    const diagnostics = createVoiceDiagnostics();
    diagnostics.sink({ name: "speechEnd", atMonotonicMs: 100, recordedAtUtc: "2026-09-10T00:00:00.000Z", turnId: 3, segmentId: "s0" });
    diagnostics.sink({ name: "firstAudio", atMonotonicMs: 250, recordedAtUtc: "2026-09-10T00:00:00.150Z", turnId: 3 });
    diagnostics.sink({ name: "interruptDetected", atMonotonicMs: 300, recordedAtUtc: "2026-09-10T00:00:00.200Z", turnId: 3 });
    diagnostics.sink({ name: "playbackStopped", atMonotonicMs: 305, recordedAtUtc: "2026-09-10T00:00:00.205Z", turnId: 3, details: { status: "stopRequested", precision: "proxy" } });

    expect(summarizeVoiceDiagnostics(diagnostics.snapshot())).toMatchObject({
      speechEndToFirstAudioMs: [150],
      interruptToStopRequestedProxyMs: [5],
      speechEndToFirstAudioP95Ms: 150,
      interruptToStopRequestedProxyP95Ms: 5,
    });
  });
});
