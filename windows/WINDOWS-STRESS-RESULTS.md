> Source-author report: the Windows-specific runtime results below were supplied with the Windows source archive. The integration review has not independently reproduced them on Windows. macOS is currently the most mature platform; report Windows problems through this repository’s Issues.

# Windows follow-up review and simulated workloads

Completed locally on 17 September 2026. The watermark and model files remain unchanged.

## Result

The bounded application stress suite, Windows checks, release checks, additional task-workflow checks, and software-rendered preview all passed. The broader source suite still has the same four failures documented in the original package; the entire project test suite is not all green.

| Check | Final result |
| --- | --- |
| Windows build: backend, renderer, management preview, wake module, desktop host | Passed |
| Windows-specific checks | 11 passed, 0 failed |
| Release checks | 115 passed, 0 failed |
| Broader memory/provider checks | 520 passed, 4 previously documented failures |
| Additional task routing, forwarding, runtime, cancellation, playback and retry checks | 116 passed, 0 failed |
| New bounded stress suite | 5 passed, 0 failed; approximately 8 seconds |
| Actual Electron preview using the supplied model | Passed with verified SwiftShader software rendering |

These are suite totals; some suites overlap and should not be added as unique test counts.

## Simulated workloads

- **2,000 text requests** containing Chinese and emoji across **10 backend sessions**. Checked exact response ordering, unique turn IDs, rejection of stale connection generations, and clean backend exit after each session. These use the offline echo backend.
- **250 complete conversations** through the real backend session with mock dialogue and speech providers. Checked both conversation records, replies, simulated playback completion, and release of temporary media after every turn.
- **300 temporary projects** in real SQLite storage. Created and updated every record, rejected outdated updates, reopened the database, checked pagination and persistence, then removed the records and temporary database.
- **20,000 rapid cancellations/replacements**. Checked that cancelled and late playback events cannot alter the current turn.
- **10,000 window-layout transitions** across varied screen sizes and negative monitor coordinates. Checked screen bounds and stable character position.

The stress runner reported a peak resident memory of 63 MiB for its own process. This excludes child processes, the rendered model and the rest of Windows; it is not a laptop-wide peak measurement.

Run the repeatable offline workload from `code/desktop-pet`:

```powershell
npm.cmd run test:stress
```

It uses synthetic data and temporary files, with bounded iteration counts and test deadlines. It does not call paid providers, dispatch real tasks, use account credentials, or exercise the GPU/NPU or physical audio devices.

## Problems found and corrected

1. **Task-receipt database privacy on Windows:** POSIX file creation modes do not establish a private Windows ACL. Newly created receipt files now receive the application's private Windows ACL before SQLite writes task content. The test verifies the actual ACL. Existing user databases are not silently rewritten.
2. **Cancellation-test hang:** a test waited only twenty event-loop ticks for disk-backed validation. On Windows this could fail before reaching the controlled lookup and then leave cleanup waiting indefinitely. It now waits for that checkpoint with a deadline and always releases the mock operation during cleanup. The original cancellation assertions remain intact.
3. **Link-escape test:** the original file-symlink fixture needed Windows privileges not available in this session. The test now uses an actual directory junction on Windows and a directory symlink elsewhere, preserving the check that an external file cannot be delivered through a project reference.
4. **Temporary diagnostic-launcher error:** the first software-preview helper imported the Electron package path instead of Electron's runtime API. This produced the error dialog shown by the user. The helper was corrected; the rerun verified SwiftShader, loaded the real model, completed a text round trip and exited. The helper lives outside the distributed source project.

## Remaining limits

The four broad-suite failures remain unchanged: manual-assistant evidence retention, two legacy combined-Omni adapter assertions, and the legacy Qwen-summary assertion. No assertions were removed or weakened to conceal these failures.

Some optional integration tests reference `tests/desktop/ui-harness.mjs`, which is absent from the supplied public source. They are outside the suites reported above and were not counted as passes.

The visual follow-up used the real Electron host and model, but deliberately selected SwiftShader and verified the reported renderer string before accepting the result. SwiftShader renders on the CPU. [Chromium documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md).

Windows was already reporting recurring Intel NPU timeouts while the project was closed. These application tests do not demonstrate that the laptop's earlier `0x10E / 0x37` crash or GPU/NPU driver problem is fixed. Hardware-accelerated stress was not performed. The preview and diagnostic Electron processes were closed after testing.

The source ZIP continues to exclude private models, the Cubism SDK, credentials, runtime databases, installed dependencies and generated builds.
