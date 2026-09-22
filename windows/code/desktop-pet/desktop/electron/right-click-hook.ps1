# Windows-only helper for click-through recovery.
# The parent sends the current screen-pixel bounds on stdin. A right-button press inside that rectangle
# is emitted as `R <screenX> <screenY>` and consumed so the underlying window cannot open its own menu.
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class AikaRightClickHook {
  private const int WH_MOUSE_LL = 14;
  private const int WM_RBUTTONDOWN = 0x0204;
  private static IntPtr hook;
  private static HookProc callback;
  private static int boundX, boundY, boundWidth, boundHeight;
  private static bool suppressing;

  [StructLayout(LayoutKind.Sequential)] private struct Point { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] private struct MouseData { public Point pt; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public Point pt; }
  private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);

  public static void SetBounds(string line) {
    var parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
    int x, y, width, height;
    if (parts.Length != 4 || !int.TryParse(parts[0], out x) || !int.TryParse(parts[1], out y)
      || !int.TryParse(parts[2], out width) || !int.TryParse(parts[3], out height)) return;
    boundX = x; boundY = y; boundWidth = Math.Max(0, width); boundHeight = Math.Max(0, height);
  }

  private static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam) {
    var message = wParam.ToInt64();
    if (code >= 0 && (message == WM_RBUTTONDOWN || message == 0x0205)) {
      var data = Marshal.PtrToStructure<MouseData>(lParam);
      var inside = data.pt.x >= boundX && data.pt.y >= boundY && data.pt.x < boundX + boundWidth && data.pt.y < boundY + boundHeight;
      if (message == WM_RBUTTONDOWN && inside) {
        suppressing = true;
        Console.WriteLine(string.Format("R {0} {1}", data.pt.x, data.pt.y));
        Console.Out.Flush();
      }
      if (suppressing) {
        if (message == 0x0205) suppressing = false;
        return (IntPtr)1;
      }
    }
    return CallNextHookEx(hook, code, wParam, lParam);
  }

  public static void Run() {
    callback = OnMouse;
    var reader = new System.Threading.Thread(() => {
      string line;
      while ((line = Console.ReadLine()) != null) SetBounds(line);
    });
    reader.IsBackground = true;
    reader.Start();
    using (var process = Process.GetCurrentProcess())
    using (var module = process.MainModule) {
      hook = SetWindowsHookEx(WH_MOUSE_LL, callback, GetModuleHandle(module.ModuleName), 0);
    }
    if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      Message message;
      while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref message); DispatchMessage(ref message); }
    } finally { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[AikaRightClickHook]::Run()
