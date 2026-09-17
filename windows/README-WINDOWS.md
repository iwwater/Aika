> Source-author report: the Windows-specific runtime results below were supplied with the Windows source archive. The integration review has not independently reproduced them on Windows. macOS is currently the most mature platform; report Windows problems through this repository’s Issues.

# AAAAGENT on Windows

This version adds a Windows desktop host using Electron while retaining the TypeScript backend and Live2D renderer. It is an editable source project, with an offline preview for everyday development. Windows x64 is the validated target; use Node.js 24 LTS with npm. No WSL, Swift or Xcode is needed on Windows.

## Run the development preview

In the prepared local working folder, double-click **Start-Windows.cmd**. Or open PowerShell in `code/desktop-pet`:

```powershell
npm.cmd ci
npm.cmd run dev
```

The preview loads the actual character and window, and sends text through a separate local backend that echoes your input. It does not read provider keys, conversation databases or WeChat login state. Voice and the management console require the configured runtime described below. Preview chat is temporary; display size, position and the hold-to-talk key preference are saved under Electron's user-data directory.

The prepared local working folder has the supplied private model and Cubism SDK in ignored directories. The source-only ZIP does **not** include these resources. Before using that ZIP, copy `desktop/assets/local-model` and `desktop/vendor/cubism` from your private source archive into the same locations under `code/desktop-pet`. Copy the private `desktop/config/parameter-map.json` to `desktop/assets/local-model/parameter-map.json`; this optional local mapping takes priority over the shared default. Keep the rig, expressions, notices and textures together. No model watermark has been removed by this port.

## Make changes

| Change | File or folder under `code/desktop-pet` |
| --- | --- |
| Layout, colors, typography | `desktop/style.css`, `desktop/index.html` |
| Conversation controls | `desktop/main.mjs` |
| Character animation | `desktop/cubism-renderer.mjs` |
| Windows window, menus and device access | `desktop/electron/main.mjs` |
| Window positioning | `desktop/electron/layout.mjs` |
| Isolated renderer bridge | `desktop/electron/preload.cjs` |
| Backend connection and shutdown | `desktop/electron/transport.mjs` |
| Memory and provider logic | `memory/`, `providers/`, `app/` |

After editing source, quit the preview and run `npm.cmd run dev` again; it rebuilds the backend and renderer. CSS/HTML changes can also be refreshed with Ctrl+R. Ctrl+Shift+I opens developer tools. Drag the character to move it; use the existing size handle and full/half-body controls. The voice key works while the pet has focus, outside the text input. Quit with the in-app Exit button or Alt+F4.

## Run with your services

1. Run `npm.cmd run build:windows`.
2. Use `config/providers.example.json` to prepare an external `config.local.json`. Write Windows paths as `C:/path/to/...` or JSON-escaped backslashes. Use your external credential files and genuine voice registry, with credential references rebound to their Windows file paths. The private archive's Mac activation hashes and absolute paths cannot be reused unchanged.
3. Restrict each credential file you own, then obtain the voice binding reference:

```powershell
node tools/private-file.mjs "C:/AAAAGENT-secrets/dashscope.key"
node tools/voice-reference.mjs "C:/AAAAGENT-secrets/dashscope.key"
```

4. Configure and activate when you are ready to use the services:

```powershell
npm.cmd run configure -- "C:/AAAAGENT-secrets/config.local.json" --activate
npm.cmd start
```

Configuration checks the real model, voice registration metadata, external-file access and build fingerprints. It creates fresh runtime data under the repository's `.local/` directory and refuses to overwrite existing state. Configured chat/voice can call your providers. The Windows port does not automatically import old conversations, activate the archived credentials, log into WeChat or start listening on the archived account.

For subsequent code changes with an existing Windows configuration:

```powershell
# Quit the running desktop first.
npm.cmd run build:windows
npm.cmd run refresh:runtime
npm.cmd start
```

The refresh command registers the rebuilt files, saves a backup of the configuration pair, and preserves activation status, memories and provider settings. It never starts a service itself. The console button opens the current authenticated management session after checking the backend identity.

## Validation and limits

```powershell
npm.cmd run test:windows
npm.cmd run test:stress
npm.cmd run test:release
npm.cmd run test:windows:ui
npm.cmd run doctor
```

The UI smoke test requires the local model and SDK; other test groups use synthetic data. Detailed results are recorded in [WINDOWS-VALIDATION.md](WINDOWS-VALIDATION.md).

`test:stress` runs bounded offline workloads: repeated text requests and reconnects, mock conversations with simulated playback, temporary SQLite projects, cancellation, and window geometry. It uses synthetic data and does not use the GPU, NPU, microphone or cloud services. See [WINDOWS-STRESS-RESULTS.md](WINDOWS-STRESS-RESULTS.md) for the follow-up review and its limits.

- The Windows host implements transparent/always-on-top display, dragging, resizing, saved display preferences, text input, reconnect, cancellation and backend shutdown. Microphone and camera requests are restricted to the local pet page and explicit voice/wake actions. Physical audio, camera, cloud speech and provider billing still require interactive testing with your account.
- Wake packaging selects the installed Windows x64 or ia32 native module rather than the original Mac ARM module. Actual keyword accuracy and microphone behavior need device testing; Windows ARM64 is not claimed.
- The original Codex task adapter depends on a fingerprinted Mac application and Unix socket. It remains unavailable on Windows. Task dispatch to the Windows Codex app needs a separately supported adapter; this port does not bypass that compatibility check.
- Harness uses `%APPDATA%/DeepSeek Harness` on Windows. Set `PET_HARNESS_HOME` if your installation stores `web.log` and `workspace` elsewhere. Its service and presets must be configured separately.
- No signed installer is produced. This is a Windows development version with a separate system Node backend, so SQLite and wake modules use the normal Node ABI rather than Electron's ABI.

If dependency installation fails, check access to the npm registry and GitHub releases. `better-sqlite3` needs its Windows prebuilt binary or Python plus Visual Studio C++ Build Tools. Electron needs its Windows runtime download. `npm.cmd` avoids PowerShell's `npm.ps1` policy issue. Do not copy a Mac `node_modules` directory.

The host follows Electron's [context isolation and security guidance](https://www.electronjs.org/docs/latest/tutorial/security), [custom protocol API](https://www.electronjs.org/docs/latest/api/protocol), and [media permission APIs](https://www.electronjs.org/docs/latest/api/session).
