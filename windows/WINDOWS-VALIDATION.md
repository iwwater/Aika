> Source-author report: the Windows-specific runtime results below were supplied with the Windows source archive. The integration review has not independently reproduced them on Windows. macOS is currently the most mature platform; report Windows problems through this repository’s Issues.

# Windows validation

Validated locally on 17 September 2026, on Windows 11 x64 with Node 24.19.0, Electron 44.4.1 and the package's locked dependencies.

| Check | Result |
| --- | --- |
| TypeScript backend build | Passed |
| Desktop renderer and management preview build, using supplied local model/SDK | Passed |
| SQLite native module | Loaded; real database tests passed |
| Windows wake native module | Packaged and loaded; `KeywordSpotter` available |
| Windows-specific tests | 11 passed, 0 failed |
| Existing release suite | 115 passed, 0 failed |
| Existing broader suite | 520 passed, 4 existing failures |
| Actual Electron UI smoke test | Passed: Live2D load, sandboxed preload, backend ready, text round trip, visible chat panel, shutdown |
| Local resource doctor | All reported resources present in the prepared working folder |
| Follow-up synthetic stress suite | 5 passed; 2,000 requests, 250 mock conversations, 300 projects, 20,000 cancellations, 10,000 layout transitions |
| Additional task, runtime, playback and retry checks | 116 passed after Windows permission and test-fixture fixes |
| Follow-up software-rendered Electron preview | Passed; SwiftShader verified, model loaded, text round trip completed, screenshot inspected |

The Windows-specific tests cover credential DACLs (including rejecting an Everyone read grant), real credential save/reopen, drive-qualified paths, traversal and junction rejection, SQLite project persistence, multi-monitor window geometry, management-session identity checks, launch fingerprints, split UTF-8 transport, stale generations, reconnection, bounded messages, timeout and graceful backend EOF.

The four remaining broader-suite failures match the original source package's documented failures:

1. Manual-assistant evidence retention assertion.
2. Legacy combined-Omni adapter audio/image assertion.
3. Legacy combined-Omni adapter model/emotion assertion.
4. Legacy Qwen-summary format assertion.

No test was removed or skipped to make these results pass. Test fixtures now close their additional SQLite handles before deleting files on Windows. The voice-registry permission assertion checks actual file privacy on each platform, and the interleaving test uses real files so Windows ACL operations remain exercised.

Not verified: physical microphone/camera capture, live ASR/TTS, wake-word detection accuracy, authenticated cloud chat, WeChat login/delivery, external Harness dispatch, or Windows Codex task dispatch. The Mac-specific Codex IPC adapter remains unsupported on Windows. No archived credentials, chats or account sessions were activated for validation.

The local preview uses the supplied private model without changing its watermark or redistributing it. The source ZIP excludes the private rig, SDK, credentials, runtime data and dependency/build directories. See [README-WINDOWS.md](README-WINDOWS.md) for setup and development commands.

The follow-up review corrected Windows permissions on newly created task-receipt databases. Tests now verify the real Windows ACL, use directory junctions for escape checks without administrator privileges, and wait for the actual cancellation checkpoint instead of a fixed count of event-loop ticks. See [WINDOWS-STRESS-RESULTS.md](WINDOWS-STRESS-RESULTS.md). Passing application tests does not establish GPU/NPU driver stability; the follow-up preview deliberately used software rendering after the laptop's recurring driver timeouts.
