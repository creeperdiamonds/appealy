# scripts/sim/sampler.ps1
#
# Reads CPU time and memory from outside the processes being measured, so taking
# the measurement costs them nothing. One JSON line per sample.

param([int]$BotPid, [int]$ApiPid, [int]$IntervalMs = 2000)

$sw = [Diagnostics.Stopwatch]::StartNew()
# Postgres starts a process per connection, and a total of the ones alive right
# now goes backwards whenever one exits. Adding up each one's growth doesn't.
$lastCpu = @{}
$totalCpu = @{ "postgres" = 0.0; "redis-server" = 0.0 }
while ($true) {
  $row = @{ t = $sw.ElapsedMilliseconds; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  # The whole machine, so a run taken while something else was busy can be spotted.
  $row["machine"] = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
  foreach ($pair in @(@("bot", $BotPid), @("api", $ApiPid))) {
    $p = Get-Process -Id $pair[1] -ErrorAction SilentlyContinue
    if ($p) {
      $row[$pair[0]] = @{ cpu = $p.TotalProcessorTime.TotalMilliseconds; ws = $p.WorkingSet64; priv = $p.PrivateMemorySize64; peakWs = $p.PeakWorkingSet64; peakPriv = $p.PeakPagedMemorySize64; threads = $p.Threads.Count }
    }
  }
  foreach ($name in @("postgres", "redis-server")) {
    $ps = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    $ws = 0
    foreach ($p in $ps) {
      $now = $p.TotalProcessorTime.TotalMilliseconds
      if ($lastCpu.ContainsKey($p.Id)) { $totalCpu[$name] += [Math]::Max(0, $now - $lastCpu[$p.Id]) } else { $totalCpu[$name] += $now }
      $lastCpu[$p.Id] = $now
      $ws += $p.WorkingSet64
    }
    $row[$name] = @{ cpu = $totalCpu[$name]; ws = $ws; count = $ps.Count }
  }
  [Console]::Out.WriteLine(($row | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $IntervalMs
}
