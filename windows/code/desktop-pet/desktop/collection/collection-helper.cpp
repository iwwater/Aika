// desktop/collection/collection-helper.cpp
//
// N081-03: Controlled Windows collection helper.
//
// Process boundary (see docs/next/0.81/CONTRACTS.md#7):
//   - Runs in the signed-in interactive Windows session.
//   - Owns the ONLY global keyboard source (Raw Input) and the ONLY clipboard change source.
//   - Aggregates keystrokes into activity buckets INSIDE this process. Key codes, scan codes,
//     characters, composition state and per-key timestamps never leave this file: they are counted
//     and discarded in the same callback.
//   - Clipboard notifications report a sequence number only. Image bytes are written to a staging
//     file on demand, never into the NDJSON stream.
//   - Directory watching is NOT here; the backend owns the bounded watcher.
//
// stdin/stdout: versioned, length-capped NDJSON control/event messages.
//
// Build: tools/build-collection-helper.mjs (MSVC/LLVM-MinGW) -> dist/collection/aika-collection-helper.exe

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wtsapi32.h>
#include <string>
#include <vector>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <cstdint>
#include <mutex>

namespace {

constexpr const char* SCHEMA_VERSION = "1";
constexpr size_t MAX_LINE_LENGTH = 65536;
constexpr size_t MAX_STAGED_BYTES = 20u * 1024u * 1024u; // 20 MiB, matching policy.maxImageBytes

std::string g_instanceId;
std::mutex g_outMutex;
bool g_running = true;
/** Signalled once the message-pump thread has created its windows. */
HANDLE g_windowThreadReady = nullptr;

// --- NDJSON output ------------------------------------------------------------------------------

void writeStdout(const std::string& line) {
  std::lock_guard<std::mutex> guard(g_outMutex);
  fwrite(line.data(), 1, line.size(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

/** Minimal JSON string escaping. All emitted text is machine-generated, never user content. */
std::string jsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (unsigned char ch : value) {
    switch (ch) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (ch < 0x20) { char buf[8]; snprintf(buf, sizeof(buf), "\\u%04x", ch); out += buf; }
        else out += static_cast<char>(ch);
    }
  }
  return out;
}

void emitEvent(const std::string& requestId, const std::string& grantRevision, const char* kind,
  const char* op, const std::string& payloadFields) {
  std::string line = "{\"schemaVersion\":" + std::string(SCHEMA_VERSION)
    + ",\"instanceId\":\"" + jsonEscape(g_instanceId)
    + "\",\"requestId\":\"" + jsonEscape(requestId)
    + "\",\"grantRevision\":" + grantRevision
    + ",\"kind\":\"" + kind + "\",\"op\":\"" + op + "\"";
  if (!payloadFields.empty()) line += "," + payloadFields;
  line += "}";
  writeStdout(line);
}

// --- JSON input parsing (deliberately tiny: the control surface is a fixed, flat shape) ---------

bool extractString(const std::string& json, const char* key, std::string& out) {
  std::string needle = std::string("\"") + key + "\"";
  size_t at = json.find(needle);
  if (at == std::string::npos) return false;
  at = json.find(':', at + needle.size());
  if (at == std::string::npos) return false;
  at = json.find('"', at);
  if (at == std::string::npos) return false;
  size_t end = at + 1;
  std::string value;
  while (end < json.size() && json[end] != '"') {
    if (json[end] == '\\' && end + 1 < json.size()) { value += json[end + 1]; end += 2; continue; }
    value += json[end++];
  }
  out = value;
  return true;
}

bool extractNumber(const std::string& json, const char* key, long long& out) {
  std::string needle = std::string("\"") + key + "\"";
  size_t at = json.find(needle);
  if (at == std::string::npos) return false;
  at = json.find(':', at + needle.size());
  if (at == std::string::npos) return false;
  out = strtoll(json.c_str() + at + 1, nullptr, 10);
  return true;
}

// --- keyboard aggregation (the only place raw input is ever observed) ---------------------------

struct KeyboardState {
  std::mutex mutex;
  bool active = false;
  unsigned long long bucketMs = 10000;
  unsigned long long quietMs = 5000;
  unsigned long long afkMs = 300000;
  std::string grantId;
  std::string grantRevision;
  std::string requestId;
  DWORD bucketStartTick = 0;
  DWORD lastInputTick = 0;
  int activityCount = 0;
  bool afkBoundary = false;
  std::string foregroundAppId;
  HANDLE timer = nullptr;
  HWND window = nullptr;
};

KeyboardState g_keyboard;

/** Defined below; declared here because startKeyboard runs before it in this translation unit. */
HWND createMessageWindow(const char* className, WNDPROC proc, bool messageOnly);

/**
 * Milliseconds-since-Unix-epoch as an ISO-8601 UTC string.
 *
 * FILETIME counts 100-ns intervals from 1601-01-01, so the Unix offset must be subtracted;
 * formatting the raw value yields a date roughly 369 years in the future.
 */
std::string isoFromUnixMillis(unsigned long long unixMillis) {
  time_t raw = static_cast<time_t>(unixMillis / 1000ULL);
  unsigned long long remainder = unixMillis % 1000ULL;
  struct tm tmUtc;
  gmtime_s(&tmUtc, &raw);
  char buffer[40];
  snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d:%02d:%02d.%03lluZ",
    tmUtc.tm_year + 1900, tmUtc.tm_mon + 1, tmUtc.tm_mday,
    tmUtc.tm_hour, tmUtc.tm_min, tmUtc.tm_sec, remainder);
  return std::string(buffer);
}

/** 100-ns intervals between 1601-01-01 and 1970-01-01. */
constexpr unsigned long long FILETIME_UNIX_EPOCH_OFFSET = 116444736000000000ULL;

unsigned long long currentUnixMillis() {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER value;
  value.LowPart = ft.dwLowDateTime;
  value.HighPart = ft.dwHighDateTime;
  return (value.QuadPart - FILETIME_UNIX_EPOCH_OFFSET) / 10000ULL;
}

/** Wall-clock instant for observation timestamps, sharing the keyboard path's epoch handling. */
std::string nowIso8601() { return isoFromUnixMillis(currentUnixMillis()); }

void flushBucketLocked(const char* reason) {
  if (!g_keyboard.active) return;
  DWORD elapsed = GetTickCount() - g_keyboard.bucketStartTick;
  std::string startIso = isoFromUnixMillis(currentUnixMillis() - elapsed);
  std::string endIso = isoFromUnixMillis(currentUnixMillis());

  // Zero-activity buckets are never reported: a bucket means "activity happened".
  if (g_keyboard.activityCount > 0) {
    std::string payload = "\"payload\":{\"bucketStart\":\"" + startIso
      + "\",\"bucketEnd\":\"" + endIso
      + "\",\"activityCount\":" + std::to_string(g_keyboard.activityCount)
      + ",\"foregroundAppId\":" + (g_keyboard.foregroundAppId.empty() ? "null" : ("\"" + jsonEscape(g_keyboard.foregroundAppId) + "\""))
      + ",\"afkBoundary\":" + (g_keyboard.afkBoundary ? "true" : "false") + "}";
    emitEvent(g_keyboard.requestId, g_keyboard.grantRevision, "keyboard", "activity", payload);
  }
  (void)reason;
  g_keyboard.activityCount = 0;
  g_keyboard.afkBoundary = false;
  g_keyboard.bucketStartTick = GetTickCount();
}

/** Foreground process image name only. Window titles are deliberately never read. */
std::string foregroundProcessName() {
  HWND window = GetForegroundWindow();
  if (!window) return std::string();
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (!pid) return std::string();
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return std::string();
  char path[MAX_PATH * 2];
  DWORD size = sizeof(path);
  std::string name;
  if (QueryFullProcessImageNameA(process, 0, path, &size)) {
    std::string full(path, size);
    size_t slash = full.find_last_of("\\/");
    name = slash == std::string::npos ? full : full.substr(slash + 1);
  }
  CloseHandle(process);
  return name;
}

/** Called for every WM_INPUT. Counts only; key identity is discarded immediately. */
void onRawKeyInput() {
  std::lock_guard<std::mutex> guard(g_keyboard.mutex);
  if (!g_keyboard.active) return;
  DWORD now = GetTickCount();
  // A gap longer than the AFK threshold starts a new activity fragment marked as a boundary.
  if (g_keyboard.lastInputTick != 0 && (now - g_keyboard.lastInputTick) >= static_cast<DWORD>(g_keyboard.afkMs)) {
    flushBucketLocked("afk");
    g_keyboard.afkBoundary = true;
  }
  if (g_keyboard.activityCount == 0) {
    g_keyboard.bucketStartTick = now;
    g_keyboard.foregroundAppId = foregroundProcessName();
  }
  g_keyboard.activityCount++;
  g_keyboard.lastInputTick = now;
}

void onTimer() {
  std::lock_guard<std::mutex> guard(g_keyboard.mutex);
  if (!g_keyboard.active) return;
  DWORD now = GetTickCount();
  if (g_keyboard.activityCount == 0) return;
  bool bucketElapsed = (now - g_keyboard.bucketStartTick) >= static_cast<DWORD>(g_keyboard.bucketMs);
  bool quietElapsed = (now - g_keyboard.lastInputTick) >= static_cast<DWORD>(g_keyboard.quietMs);
  if (bucketElapsed || quietElapsed) flushBucketLocked(quietElapsed ? "quiet" : "bucket");
}

LRESULT CALLBACK rawInputProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_INPUT) {
    // Only the presence of a keyboard-class raw input matters; the payload is not inspected.
    UINT size = 0;
    if (GetRawInputData(reinterpret_cast<HRAWINPUT>(lparam), RID_INPUT, nullptr, &size, sizeof(RAWINPUTHEADER)) == 0 && size > 0) {
      std::vector<BYTE> buffer(size);
      if (GetRawInputData(reinterpret_cast<HRAWINPUT>(lparam), RID_INPUT, buffer.data(), &size, sizeof(RAWINPUTHEADER)) == size) {
        RAWINPUT* raw = reinterpret_cast<RAWINPUT*>(buffer.data());
        // Keyboard class only. Mouse movement must never be counted as keyboard activity.
        if (raw->header.dwType == RIM_TYPEKEYBOARD) onRawKeyInput();
      }
    }
    // rp is swallowed: the helper must not interfere with normal input handling.
  }
  return DefWindowProcA(window, message, wparam, lparam);
}

/** Message-only window that receives raw keyboard input for this session. */
bool startKeyboard(const std::string& grantId, const std::string& grantRevision, const std::string& requestId,
  unsigned long long bucketMs, unsigned long long quietMs, unsigned long long afkMs) {
  std::lock_guard<std::mutex> guard(g_keyboard.mutex);
  if (g_keyboard.active) return false;

  // RIDEV_INPUTSINK requires a real hwndTarget owned by a pumping thread. The window is created by
  // windowThread at startup; a missing one means that thread failed and the source is unavailable.
  if (!g_keyboard.window) return false;

  g_keyboard.grantId = grantId;
  g_keyboard.grantRevision = grantRevision;
  g_keyboard.requestId = requestId;
  g_keyboard.bucketMs = bucketMs;
  g_keyboard.quietMs = quietMs;
  g_keyboard.afkMs = afkMs;
  g_keyboard.bucketStartTick = GetTickCount();
  g_keyboard.lastInputTick = GetTickCount();
  g_keyboard.activityCount = 0;
  g_keyboard.afkBoundary = false;

  RAWINPUTDEVICE device{};
  device.usUsagePage = 0x01; // Generic Desktop
  device.usUsage = 0x06;     // Keyboard
  device.dwFlags = RIDEV_INPUTSINK;
  device.hwndTarget = g_keyboard.window;
  if (!RegisterRawInputDevices(&device, 1, sizeof(device))) {
    g_keyboard.active = false;
    return false;
  }
  g_keyboard.active = true;
  if (!g_keyboard.timer) g_keyboard.timer = CreateWaitableTimerExA(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
  return true;
}

void stopKeyboard() {
  std::lock_guard<std::mutex> guard(g_keyboard.mutex);
  if (!g_keyboard.active) return;
  flushBucketLocked("stop");
  RAWINPUTDEVICE device{};
  device.usUsagePage = 0x01;
  device.usUsage = 0x06;
  device.dwFlags = RIDEV_REMOVE;
  device.hwndTarget = nullptr;
  RegisterRawInputDevices(&device, 1, sizeof(device));
  if (g_keyboard.timer) { CloseHandle(g_keyboard.timer); g_keyboard.timer = nullptr; }
  g_keyboard.active = false;
  g_keyboard.grantId.clear();
  g_keyboard.grantRevision.clear();
  g_keyboard.requestId.clear();
  g_keyboard.foregroundAppId.clear();
}

// --- clipboard sequence watch (bytes stay out of the stream) ------------------------------------

struct ClipboardState {
  std::mutex mutex;
  bool active = false;
  DWORD lastSequence = 0;
  std::string grantId;
  std::string grantRevision;
  std::string requestId;
  std::string stagingRoot;
  HWND window = nullptr;
};
ClipboardState g_clipboard;

void onClipboardChange() {
  std::lock_guard<std::mutex> guard(g_clipboard.mutex);
  if (!g_clipboard.active) return;
  DWORD sequence = GetClipboardSequenceNumber();
  if (sequence == g_clipboard.lastSequence) return;
  g_clipboard.lastSequence = sequence;
  std::string payload = "\"payload\":{\"clipboardSequence\":" + std::to_string(sequence)
    + ",\"observedAt\":\"" + nowIso8601() + "\"}";
  emitEvent(g_clipboard.requestId, g_clipboard.grantRevision, "clipboard_image", "clipboard_seq", payload);
}

// --- staged clipboard image (one-shot, backend-deleted) -----------------------------------------

/**
 * Wait until the clipboard is free, verify the sequence has not moved, and write the image to a
 * staging file. Only the staged asset id and metadata go upstream; the bytes never enter NDJSON.
 */
void readClipboardImage(const std::string& requestId, const std::string& grantRevision, long long sequence) {
  const int maxAttempts = 3;
  const DWORD budgetMs = 1000;
  DWORD started = GetTickCount();
  for (int attempt = 0; attempt < maxAttempts; attempt++) {
    if ((GetTickCount() - started) > budgetMs) break;
    if (!OpenClipboard(nullptr)) { Sleep(20); continue; }
    // A changed sequence invalidates this notification entirely.
    if (static_cast<long long>(GetClipboardSequenceNumber()) != sequence) {
      CloseClipboard();
      emitEvent(requestId, grantRevision, "clipboard_image", "error", "\"payload\":{\"code\":\"stale_clipboard\"}");
      return;
    }
    HANDLE handle = GetClipboardData(CF_DIBV5);
    bool isV5 = handle != nullptr;
    if (!handle) handle = GetClipboardData(CF_DIB);
    if (!handle) {
      // Text/HTML/file-list content is explicitly not read and not reported as an error.
      CloseClipboard();
      emitEvent(requestId, grantRevision, "clipboard_image", "error", "\"payload\":{\"code\":\"no_supported_image\"}");
      return;
    }
    void* source = GlobalLock(handle);
    if (!source) { CloseClipboard(); Sleep(20); continue; }
    SIZE_T size = GlobalSize(handle);
    if (size == 0 || size > MAX_STAGED_BYTES) {
      GlobalUnlock(handle);
      CloseClipboard();
      emitEvent(requestId, grantRevision, "clipboard_image", "error", "\"payload\":{\"code\":\"image_too_large\"}");
      return;
    }

    // stagingRoot/<instanceId>/<uuid>.bmp — the backend reads and deletes it by this id.
    SYSTEMTIME st;
    GetSystemTime(&st);
    char nameBuffer[256];
    snprintf(nameBuffer, sizeof(nameBuffer), "clip-%04u%02u%02u%02u%02u%02u-%lu-%lld.bmp",
      st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, GetCurrentProcessId(), sequence);
    std::string directory = g_clipboard.stagingRoot + "\\" + g_instanceId;
    CreateDirectoryA(g_clipboard.stagingRoot.c_str(), nullptr);
    CreateDirectoryA(directory.c_str(), nullptr);
    std::string target = directory + "\\" + nameBuffer;

    HANDLE file = CreateFileA(target.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
      GlobalUnlock(handle);
      CloseClipboard();
      emitEvent(requestId, grantRevision, "clipboard_image", "error", "\"payload\":{\"code\":\"staging_failed\"}");
      return;
    }
    // Write a BITMAPFILEHEADER ahead of the DIB so the staged file is a self-describing .bmp.
    BITMAPFILEHEADER header{};
    BITMAPINFOHEADER* info = reinterpret_cast<BITMAPINFOHEADER*>(source);
    size_t payloadOffset = isV5 ? sizeof(BITMAPV5HEADER) : sizeof(BITMAPINFOHEADER);
    if (info->biSize > payloadOffset) payloadOffset = info->biSize;
    size_t pixelBytes = size > payloadOffset ? size - payloadOffset : 0;
    header.bfType = 0x4D42;
    header.bfOffBits = static_cast<DWORD>(sizeof(BITMAPFILEHEADER) + payloadOffset);
    header.bfSize = header.bfOffBits + static_cast<DWORD>(pixelBytes);
    DWORD written = 0;
    WriteFile(file, &header, sizeof(header), &written, nullptr);
    WriteFile(file, source, static_cast<DWORD>(size), &written, nullptr);
    CloseHandle(file);
    GlobalUnlock(handle);
    CloseClipboard();

    std::string stagedAssetId = std::string(g_instanceId) + "/" + nameBuffer;
    std::string payload = "\"payload\":{\"stagedAssetId\":\"" + jsonEscape(stagedAssetId)
      + "\",\"mimeType\":\"image/bmp\",\"byteLength\":" + std::to_string(sizeof(header) + size) + "}";
    emitEvent(requestId, grantRevision, "clipboard_image", "staged_image", payload);
    return;
  }
  emitEvent(requestId, grantRevision, "clipboard_image", "error", "\"payload\":{\"code\":\"clipboard_busy\"}");
}

LRESULT CALLBACK clipboardProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_CLIPBOARDUPDATE) onClipboardChange();
  if (message == WM_WTSSESSION_CHANGE) {
    if (wparam == WTS_SESSION_LOCK) {
      emitEvent("", "0", "system", "session_locked", "\"payload\":{\"reason\":\"session_locked\"}");
    }
  }
  if (message == WM_POWERBROADCAST) {
    if (wparam == PBT_APMSUSPEND) {
      emitEvent("", "0", "system", "session_locked", "\"payload\":{\"reason\":\"session_locked\"}");
    }
  }
  if (message == WM_DESTROY) {
    WTSUnRegisterSessionNotification(window);
    PostQuitMessage(0);
  }
  return DefWindowProcA(window, message, wparam, lparam);
}

HWND createMessageWindow(const char* className, WNDPROC proc, bool messageOnly) {
  WNDCLASSEXA cls{};
  cls.cbSize = sizeof(cls);
  cls.lpfnWndProc = proc;
  cls.hInstance = GetModuleHandleA(nullptr);
  cls.lpszClassName = className;
  RegisterClassExA(&cls);
  if (messageOnly) {
    return CreateWindowExA(0, className, "", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, GetModuleHandleA(nullptr), nullptr);
  }
  /*
   * A real but never-shown window.
   *
   * `WM_CLIPBOARDUPDATE` is NOT delivered to a message-only (`HWND_MESSAGE`) window: measured with a
   * direct probe, `AddClipboardFormatListener` returned success and the window then received zero
   * notifications. The clipboard listener therefore needs a normal top-level window — hidden, zero
   * sized, and never activated — so it is off-screen and out of the taskbar while still receiving
   * broadcasts.
   */
  HWND window = CreateWindowExA(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
    className, "", WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, GetModuleHandleA(nullptr), nullptr);
  if (window) {
    // Keep it out of the taskbar and never let it take focus.
    ShowWindow(window, SW_HIDE);
    // P1-3: Register for Windows session lock/unlock notifications to pause collection immediately.
    WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION);
  }
  return window;
}

// --- control loop -------------------------------------------------------------------------------

void handleControl(const std::string& line) {
  std::string instanceId, requestId, grantId, grantRevision, kind, op;
  extractString(line, "instanceId", instanceId);
  extractString(line, "requestId", requestId);
  extractString(line, "grantId", grantId);
  extractString(line, "kind", kind);
  extractString(line, "op", op);
  long long revisionValue = 0;
  if (extractNumber(line, "grantRevision", revisionValue)) grantRevision = std::to_string(revisionValue);
  else grantRevision = "0";

  // A control message for another instance is not ours to act on.
  if (!instanceId.empty() && !g_instanceId.empty() && instanceId != g_instanceId) return;

  if (op == "start" && kind == "keyboard") {
    long long bucket = 10000, quiet = 5000, afk = 300000;
    extractNumber(line, "keyboardBucketMs", bucket);
    extractNumber(line, "keyboardQuietMs", quiet);
    extractNumber(line, "afkMs", afk);
    if (startKeyboard(grantId, grantRevision, requestId, static_cast<unsigned long long>(bucket),
        static_cast<unsigned long long>(quiet), static_cast<unsigned long long>(afk))) {
      emitEvent(requestId, grantRevision, "keyboard", "started", "");
    } else {
      emitEvent(requestId, grantRevision, "keyboard", "error", "\"payload\":{\"code\":\"keyboard_unavailable\"}");
    }
    return;
  }
  if (op == "stop" && kind == "keyboard") {
    stopKeyboard();
    emitEvent(requestId, grantRevision, "keyboard", "stopped", "");
    return;
  }
  if (op == "start" && kind == "clipboard_image") {
    std::lock_guard<std::mutex> guard(g_clipboard.mutex);
    extractString(line, "stagingRoot", g_clipboard.stagingRoot);
    g_clipboard.grantId = grantId;
    g_clipboard.grantRevision = grantRevision;
    g_clipboard.requestId = requestId;
    if (!g_clipboard.window) {
      g_clipboard.active = false;
      emitEvent(requestId, grantRevision, "clipboard_image", "error", "\"payload\":{\"code\":\"clipboard_unavailable\"}");
      return;
    }
    if (AddClipboardFormatListener(g_clipboard.window)) {
      g_clipboard.active = true;
      // The pre-existing clipboard content at enable time is deliberately not ingested.
      g_clipboard.lastSequence = GetClipboardSequenceNumber();
      emitEvent(requestId, grantRevision, "clipboard_image", "started", "");
    } else {
      g_clipboard.active = false;
      emitEvent(requestId, grantRevision, "clipboard_image", "error", "\"payload\":{\"code\":\"clipboard_unavailable\"}");
    }
    return;
  }
  if (op == "stop" && kind == "clipboard_image") {
    std::lock_guard<std::mutex> guard(g_clipboard.mutex);
    if (g_clipboard.window) RemoveClipboardFormatListener(g_clipboard.window);
    g_clipboard.active = false;
    emitEvent(requestId, grantRevision, "clipboard_image", "stopped", "");
    return;
  }
  if (op == "read_clipboard_image") {
    long long sequence = 0;
    extractNumber(line, "sequence", sequence);
    readClipboardImage(requestId, grantRevision, sequence);
    return;
  }
  if (op == "close") {
    stopKeyboard();
    {
      std::lock_guard<std::mutex> guard(g_clipboard.mutex);
      if (g_clipboard.window) RemoveClipboardFormatListener(g_clipboard.window);
      g_clipboard.active = false;
      if (g_clipboard.window) DestroyWindow(g_clipboard.window);
      g_clipboard.window = nullptr;
    }
    emitEvent(requestId, grantRevision, "keyboard", "stopped", "");
    g_running = false;
    return;
  }
  emitEvent(requestId, grantRevision, kind.empty() ? "keyboard" : kind.c_str(), "error",
    "\"payload\":{\"code\":\"unsupported_control\"}");
}

DWORD WINAPI timerThread(LPVOID) {
  while (g_running) {
    Sleep(200);
    onTimer();
  }
  return 0;
}

/**
 * Dedicated message pump for the keyboard and clipboard windows.
 *
 * Raw input and clipboard notifications are only delivered while their owning thread pumps
 * messages. The main thread blocks on stdin, so this thread must exist; without it the listener
 * registers successfully and then silently observes nothing.
 */
DWORD WINAPI windowThread(LPVOID) {
  {
    std::lock_guard<std::mutex> guard(g_keyboard.mutex);
    // Raw input works with a message-only window.
    g_keyboard.window = createMessageWindow("AikaCollectionRawInput", rawInputProc, true);
  }
  {
    std::lock_guard<std::mutex> guard(g_clipboard.mutex);
    // The clipboard listener needs a real (hidden) window; see createMessageWindow.
    g_clipboard.window = createMessageWindow("AikaCollectionClipboard", clipboardProc, false);
  }
  SetEvent(g_windowThreadReady);

  MSG message;
  while (g_running && GetMessageA(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageA(&message);
  }
  return 0;
}

} // namespace

int main(int argc, char** argv) {
  // The instance id comes from the backend so every message is attributable to one runtime.
  for (int index = 1; index < argc; index++) {
    if (strcmp(argv[index], "--instance-id") == 0 && index + 1 < argc) g_instanceId = argv[index + 1];
  }
  if (g_instanceId.empty()) { fprintf(stderr, "missing --instance-id\n"); return 2; }

  // The helper owns no manifest and prints nothing about its own configuration.
  writeStdout("{\"schemaVersion\":\"" + std::string(SCHEMA_VERSION) + "\",\"op\":\"ready\",\"instanceId\":\""
    + jsonEscape(g_instanceId) + "\"}");

  HANDLE timer = CreateThread(nullptr, 0, timerThread, nullptr, 0, nullptr);
  (void)timer;
  // Raw input and clipboard notifications require a pumping thread; start it before any control
  // message can arrive and wait until its windows exist.
  g_windowThreadReady = CreateEventA(nullptr, TRUE, FALSE, nullptr);
  HANDLE windows = CreateThread(nullptr, 0, windowThread, nullptr, 0, nullptr);
  (void)windows;
  WaitForSingleObject(g_windowThreadReady, 5000);

  std::string line;
  line.reserve(MAX_LINE_LENGTH);
  int ch;
  while (g_running && (ch = fgetc(stdin)) != EOF) {
    if (ch == '\n') {
      if (!line.empty()) handleControl(line);
      line.clear();
      if (line.capacity() > MAX_LINE_LENGTH * 2) line.shrink_to_fit();
      continue;
    }
    if (ch == '\r') continue;
    // A control line beyond the cap is refused rather than buffered without bound.
    if (line.size() >= MAX_LINE_LENGTH) {
      line.clear();
      emitEvent("", "0", "keyboard", "error", "\"payload\":{\"code\":\"line_too_long\"}");
      continue;
    }
    line += static_cast<char>(ch);
  }

  stopKeyboard();
  {
    std::lock_guard<std::mutex> guard(g_clipboard.mutex);
    if (g_clipboard.window) RemoveClipboardFormatListener(g_clipboard.window);
    g_clipboard.active = false;
  }
  return 0;
}
