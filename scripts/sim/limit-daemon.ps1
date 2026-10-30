# scripts/sim/limit-daemon.ps1
#
# Holds processes to a fixed share of the CPU and a memory ceiling, the way a
# Cloud Run container's limits do. A Windows job object's hard CPU cap is the
# closest thing to a cgroup quota this machine has. Reads "pid cpuShare memMiB"
# lines on stdin and answers "ok pid" once that process is capped. The process's
# children would inherit it; the bot and the API have none.

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class SimJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)]
  struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct EXTENDED { public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcess; public UIntPtr PeakJob; }
  [StructLayout(LayoutKind.Sequential)]
  struct CPU { public uint ControlFlags; public uint CpuRate; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

  public static void Limit(int pid, double cpuShare, long memMiB) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());

    if (cpuShare > 0) {
      // In hundredths of a percent of ALL logical processors on the machine.
      uint rate = (uint)Math.Max(1, Math.Round(cpuShare / Environment.ProcessorCount * 10000));
      CPU cpu = new CPU { ControlFlags = 0x1 | 0x4, CpuRate = rate }; // ENABLE | HARD_CAP
      IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(cpu));
      Marshal.StructureToPtr(cpu, p, false);
      if (!SetInformationJobObject(job, 15, p, (uint)Marshal.SizeOf(cpu))) throw new Exception("cpu limit " + Marshal.GetLastWin32Error());
    }
    if (memMiB > 0) {
      EXTENDED ext = new EXTENDED();
      ext.Basic.LimitFlags = 0x200; // JOB_OBJECT_LIMIT_JOB_MEMORY
      ext.JobMemoryLimit = (UIntPtr)(ulong)(memMiB * 1048576);
      IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(ext));
      Marshal.StructureToPtr(ext, p, false);
      if (!SetInformationJobObject(job, 9, p, (uint)Marshal.SizeOf(ext))) throw new Exception("memory limit " + Marshal.GetLastWin32Error());
    }
    IntPtr proc = OpenProcess(0x1F0FFF, false, pid);
    if (proc == IntPtr.Zero) throw new Exception("OpenProcess " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, proc)) throw new Exception("assign " + Marshal.GetLastWin32Error());
  }
}
"@

[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Trim().Split(" ")
  if ($parts.Count -lt 3) { continue }
  try {
    [SimJob]::Limit([int]$parts[0], [double]$parts[1], [long]$parts[2])
    [Console]::Out.WriteLine("ok $($parts[0])")
  } catch {
    [Console]::Out.WriteLine("fail $($parts[0]) $($_.Exception.Message)")
  }
  [Console]::Out.Flush()
}
