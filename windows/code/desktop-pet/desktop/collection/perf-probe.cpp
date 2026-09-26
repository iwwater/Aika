// desktop/collection/perf-probe.cpp
//
// N081-00 §6: minimal resource probe for the collection helper.
//
// WHY THIS EXISTS: PowerShell's `TotalProcessorTime` is quantized coarsely enough that a short
// measurement window reads as an exactly zero CPU delta, which would silently under-report. This
// probe reads the same values straight from the OS with no quantisation.
//
// It reports one line: "<workingSetBytes> <privateBytes> <cpuMs>". It reads only its own PID or a
// PID given on the command line; it inspects no other process state and opens no files.
//
// Build: tools/build-collection-helper.mjs (same toolchain as the helper).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <cstdio>
#include <cstdlib>

int main(int argc, char** argv) {
  DWORD pid = (argc > 1) ? static_cast<DWORD>(strtoul(argv[1], nullptr, 10)) : GetCurrentProcessId();
  // GetProcessTimes needs PROCESS_QUERY_INFORMATION; QUERY_LIMITED_INFORMATION alone succeeds at
  // OpenProcess but yields no timing data, which would silently report a zero CPU delta forever.
  HANDLE process = (pid == GetCurrentProcessId())
    ? GetCurrentProcess()
    : OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!process) { printf("0 0 0\n"); return 1; }

  PROCESS_MEMORY_COUNTERS counters{};
  counters.cb = sizeof(counters);
  if (!GetProcessMemoryInfo(process, &counters, sizeof(counters))) {
    if (pid != GetCurrentProcessId()) CloseHandle(process);
    printf("0 0 0\n");
    return 1;
  }

  FILETIME creation{}, exitTime{}, kernel{}, user{};
  unsigned long long cpuMs = 0;
  bool haveTimes = GetProcessTimes(process, &creation, &exitTime, &kernel, &user) != 0;
  if (haveTimes) {
    ULARGE_INTEGER k, u;
    k.LowPart = kernel.dwLowDateTime; k.HighPart = kernel.dwHighDateTime;
    u.LowPart = user.dwLowDateTime; u.HighPart = user.dwHighDateTime;
    // FILETIME counts 100 ns units; convert to whole milliseconds.
    cpuMs = (k.QuadPart + u.QuadPart) / 10000ULL;
  }

  if (pid != GetCurrentProcessId()) CloseHandle(process);
  if (!haveTimes) { printf("0 0 -1\n"); return 1; }
  printf("%llu %llu %llu\n",
    static_cast<unsigned long long>(counters.WorkingSetSize),
    static_cast<unsigned long long>(counters.PagefileUsage),
    cpuMs);
  return 0;
}
