import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { LineChart, Line, YAxis, ResponsiveContainer } from 'recharts'

/* ===========================================================================
   SHARD FLEET CONSOLE — Discordeno big-bot topology
   10 hosts x 500 shards = 5,000 shards, 5.2M guilds

   Reads a packed SSE stream (4 bytes/shard) from the BFF in
   gateway-control-plane.ts. Runs on simulated telemetry here so you can drive
   it before wiring the backend — swap connectTelemetry() for the real EventSource.
   =========================================================================== */

const C = {
  ink: '#07080F',
  panel: '#10121E',
  panelHi: '#161A2B',
  line: '#1E2233',
  bone: '#E6E8F0',
  muted: '#6C7391',
  blurple: '#5865F2',
  // Healthy is deliberately quiet. In a 5,000-cell field, green vibrates and
  // hides the anomalies. Only trouble is allowed to be loud.
  connected: '#7C9BFF',
  transitional: '#C084FC',
  degraded: '#FFB84D',
  dead: '#FF4D6D',
  unspawned: '#1C2035',
}

const STATE = {
  UNSPAWNED: 0, OFFLINE: 1, CONNECTING: 2, UNIDENTIFIED: 3,
  IDENTIFYING: 4, RESUMING: 5, CONNECTED: 6, DISCONNECTED: 7,
}

const STATE_META = {
  [STATE.UNSPAWNED]:    { label: 'Unspawned',    color: C.unspawned,     bucket: 'idle' },
  [STATE.OFFLINE]:      { label: 'Offline',      color: C.dead,          bucket: 'down' },
  [STATE.CONNECTING]:   { label: 'Connecting',   color: C.transitional,  bucket: 'moving' },
  [STATE.UNIDENTIFIED]: { label: 'Unidentified', color: C.transitional,  bucket: 'moving' },
  [STATE.IDENTIFYING]:  { label: 'Identifying',  color: C.transitional,  bucket: 'moving' },
  [STATE.RESUMING]:     { label: 'Resuming',     color: C.transitional,  bucket: 'moving' },
  [STATE.CONNECTED]:    { label: 'Connected',    color: C.connected,     bucket: 'up' },
  [STATE.DISCONNECTED]: { label: 'Disconnected', color: C.dead,          bucket: 'down' },
}

const HOSTS = 10
const SHARDS_PER_HOST = 500
const WORKERS_PER_HOST = 50
const TOTAL_SHARDS = HOSTS * SHARDS_PER_HOST
const COLS = 25
const ROWS = SHARDS_PER_HOST / COLS
const MAX_CONCURRENCY = 16
const FLAG_STALE = 1

/* --------------------------------------------------------------------------
   Simulated telemetry. Mirrors the packed 4-byte record the BFF emits.
   -------------------------------------------------------------------------- */
function useFleet() {
  const shards = useRef(null)
  const [, forceTick] = useState(0)

  if (!shards.current) {
    shards.current = new Array(TOTAL_SHARDS).fill(0).map((_, id) => ({
      id,
      host: Math.floor(id / SHARDS_PER_HOST),
      worker: Math.floor((id % SHARDS_PER_HOST) / (SHARDS_PER_HOST / WORKERS_PER_HOST)),
      state: STATE.CONNECTED,
      rtt: 40 + Math.round(Math.random() * 90),
      flags: 0,
      guilds: 900 + Math.round(Math.random() * 400),
      phase: Math.random() * Math.PI * 2,
    }))
    // A fleet is never perfectly clean. Seed the failures you'd actually see.
    for (let i = 0; i < 34; i++) {
      const s = shards.current[Math.floor(Math.random() * TOTAL_SHARDS)]
      s.state = Math.random() > 0.4 ? STATE.RESUMING : STATE.DISCONNECTED
    }
    for (let i = 0; i < 60; i++) {
      shards.current[Math.floor(Math.random() * TOTAL_SHARDS)].rtt = 320 + Math.random() * 500
    }
    // Host 6 is having a bad afternoon.
    for (let i = 3000; i < 3070; i++) {
      shards.current[i].state = STATE.DISCONNECTED
      shards.current[i].flags = FLAG_STALE
    }
  }

  useEffect(() => {
    const t = setInterval(() => {
      const arr = shards.current
      for (let i = 0; i < 45; i++) {
        const s = arr[Math.floor(Math.random() * TOTAL_SHARDS)]
        s.rtt = Math.max(25, s.rtt + (Math.random() - 0.5) * 60)
        if (s.state === STATE.RESUMING && Math.random() > 0.55) s.state = STATE.CONNECTED
        else if (s.state === STATE.IDENTIFYING && Math.random() > 0.6) s.state = STATE.CONNECTED
        else if (s.state === STATE.CONNECTED && Math.random() > 0.993) s.state = STATE.RESUMING
      }
      forceTick((n) => n + 1)
    }, 1000)
    return () => clearInterval(t)
  }, [])

  return shards
}

/* --------------------------------------------------------------------------
   Host heatmap. One canvas per host — 500 cells, cheap hit-testing, no DOM.
   -------------------------------------------------------------------------- */
function HostGrid({ hostId, shards, selection, onSelect, onHover, reduceMotion }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const rafRef = useRef(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const dpr = window.devicePixelRatio || 1
    const cell = Math.max(4, Math.floor(wrap.clientWidth / COLS))
    const w = cell * COLS
    const h = cell * ROWS

    if (canvas.width !== w * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }

    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const t = Date.now() / 1000
    const base = hostId * SHARDS_PER_HOST

    for (let i = 0; i < SHARDS_PER_HOST; i++) {
      const s = shards.current[base + i]
      const x = (i % COLS) * cell
      const y = Math.floor(i / COLS) * cell

      let color = STATE_META[s.state].color
      // A connected shard with a bad RTT isn't healthy — surface it as degraded.
      if (s.state === STATE.CONNECTED && s.rtt > 300) color = C.degraded

      let alpha = 1
      if (!reduceMotion && s.state === STATE.CONNECTED && color === C.connected) {
        // Heartbeat cadence, phase-offset per shard. Ambient, not decorative:
        // a frozen region reads instantly as a stalled worker.
        alpha = 0.62 + 0.2 * Math.sin(t * 0.6 + s.phase)
      }

      ctx.globalAlpha = alpha
      ctx.fillStyle = color
      ctx.fillRect(x, y, cell - 1, cell - 1)

      if (s.flags & FLAG_STALE) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = C.bone
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, y + 0.5, cell - 2, cell - 2)
      }
      if (selection.kind === 'shard' && selection.id === s.id) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = C.bone
        ctx.lineWidth = 2
        ctx.strokeRect(x - 1, y - 1, cell + 1, cell + 1)
      }
    }
    ctx.globalAlpha = 1
    rafRef.current = requestAnimationFrame(draw)
  }, [hostId, shards, selection, reduceMotion])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  const cellFromEvent = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const cell = rect.width / COLS
    const col = Math.floor((e.clientX - rect.left) / cell)
    const row = Math.floor((e.clientY - rect.top) / cell)
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null
    return hostId * SHARDS_PER_HOST + row * COLS + col
  }

  const stats = useMemo(() => {
    const base = hostId * SHARDS_PER_HOST
    let up = 0, moving = 0, down = 0, degraded = 0
    for (let i = 0; i < SHARDS_PER_HOST; i++) {
      const s = shards.current[base + i]
      const b = STATE_META[s.state].bucket
      if (b === 'up') { if (s.rtt > 300) degraded++; else up++ }
      else if (b === 'moving') moving++
      else if (b === 'down') down++
    }
    return { up, moving, down, degraded }
  }, [hostId, shards, selection])

  const isSelected = selection.kind === 'host' && selection.id === hostId
  const alarm = stats.down > 5

  return (
    <div
      className="rounded-sm p-3 transition-colors"
      style={{
        background: isSelected ? C.panelHi : C.panel,
        border: `1px solid ${isSelected ? C.blurple : alarm ? C.dead : C.line}`,
      }}
    >
      <button
        onClick={() => onSelect({ kind: 'host', id: hostId })}
        className="w-full flex items-baseline justify-between mb-2 text-left focus:outline-none focus-visible:ring-2 rounded-sm"
        style={{ '--tw-ring-color': C.blurple }}
      >
        <span
          className="text-[10px] uppercase tracking-[0.18em]"
          style={{ color: isSelected ? C.bone : C.muted, fontFamily: 'var(--cond)' }}
        >
          Host {String(hostId).padStart(2, '0')}
        </span>
        <span className="text-[11px] tabular-nums" style={{ fontFamily: 'var(--mono)', color: stats.down ? C.dead : C.muted }}>
          {stats.down ? `${stats.down} down` : `${stats.up}/${SHARDS_PER_HOST}`}
        </span>
      </button>

      <div ref={wrapRef} className="w-full">
        <canvas
          ref={canvasRef}
          className="block cursor-crosshair"
          onMouseMove={(e) => {
            const id = cellFromEvent(e)
            onHover(id === null ? null : { shard: shards.current[id], x: e.clientX, y: e.clientY })
          }}
          onMouseLeave={() => onHover(null)}
          onClick={(e) => {
            const id = cellFromEvent(e)
            if (id !== null) onSelect({ kind: 'shard', id })
          }}
        />
      </div>

      <div className="flex gap-2 mt-2 text-[10px] tabular-nums" style={{ fontFamily: 'var(--mono)' }}>
        {stats.degraded > 0 && <span style={{ color: C.degraded }}>{stats.degraded} slow</span>}
        {stats.moving > 0 && <span style={{ color: C.transitional }}>{stats.moving} moving</span>}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------
   Session start budget. The constraint that gates every destructive action.
   -------------------------------------------------------------------------- */
function BudgetMeter({ remaining, total, pendingCost }) {
  const pct = (remaining / total) * 100
  const afterPct = ((remaining - pendingCost) / total) * 100
  const low = pct < 25

  return (
    <div className="min-w-[190px]">
      <div className="flex justify-between items-baseline mb-1.5">
        <span className="text-[10px] uppercase tracking-[0.18em]" style={{ color: C.muted, fontFamily: 'var(--cond)' }}>
          Session starts
        </span>
        <span className="text-[12px] tabular-nums" style={{ fontFamily: 'var(--mono)', color: low ? C.degraded : C.bone }}>
          {remaining - pendingCost}<span style={{ color: C.muted }}>/{total}</span>
        </span>
      </div>
      <div className="h-1.5 w-full rounded-sm overflow-hidden relative" style={{ background: C.unspawned }}>
        <div className="h-full absolute left-0 top-0" style={{ width: `${afterPct}%`, background: low ? C.degraded : C.blurple }} />
        {pendingCost > 0 && (
          <div className="h-full absolute top-0" style={{ left: `${afterPct}%`, width: `${pct - afterPct}%`, background: C.dead, opacity: 0.75 }} />
        )}
      </div>
      <div className="text-[10px] mt-1" style={{ color: C.muted, fontFamily: 'var(--mono)' }}>
        resets in 6h 12m · {MAX_CONCURRENCY} buckets
      </div>
    </div>
  )
}

function Stat({ label, value, unit, tone }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] mb-1" style={{ color: C.muted, fontFamily: 'var(--cond)' }}>
        {label}
      </div>
      <div className="text-[20px] leading-none tabular-nums" style={{ fontFamily: 'var(--mono)', color: tone || C.bone }}>
        {value}
        {unit && <span className="text-[11px] ml-1" style={{ color: C.muted }}>{unit}</span>}
      </div>
    </div>
  )
}

/* ========================================================================== */

export default function ShardFleetConsole() {
  const shards = useFleet()
  const [selection, setSelection] = useState({ kind: 'none' })
  const [hover, setHover] = useState(null)
  const [budget, setBudget] = useState({ remaining: 840, total: 1000 })
  const [jobs, setJobs] = useState([])
  const [notice, setNotice] = useState(null)
  const [eventRate, setEventRate] = useState(() =>
    Array.from({ length: 60 }, (_, i) => ({ i, v: 118000 + Math.random() * 14000 })),
  )

  const reduceMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  useEffect(() => {
    const t = setInterval(() => {
      setEventRate((prev) => [...prev.slice(1), { i: prev[prev.length - 1].i + 1, v: 118000 + Math.random() * 16000 }])
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // Drain the action queue at the governor's pace: 16 buckets, 5s apart.
  useEffect(() => {
    if (jobs.length === 0) return
    const t = setInterval(() => {
      setJobs((prev) => {
        const next = prev.slice(MAX_CONCURRENCY)
        prev.slice(0, MAX_CONCURRENCY).forEach((j) => {
          const s = shards.current[j.shardId]
          s.state = j.action === 'IDENTIFY_SHARD' ? STATE.IDENTIFYING : STATE.RESUMING
          s.flags = 0
        })
        return next
      })
    }, 1200)
    return () => clearInterval(t)
  }, [jobs.length, shards])

  const fleet = useMemo(() => {
    let up = 0, moving = 0, down = 0, degraded = 0, guilds = 0
    const rtts = []
    for (const s of shards.current) {
      const b = STATE_META[s.state].bucket
      guilds += s.guilds
      if (b === 'up') { rtts.push(s.rtt); if (s.rtt > 300) degraded++; else up++ }
      else if (b === 'moving') moving++
      else if (b === 'down') down++
    }
    rtts.sort((a, b) => a - b)
    return { up, moving, down, degraded, guilds, p99: Math.round(rtts[Math.floor(rtts.length * 0.99)] || 0) }
  }, [shards, eventRate])

  const targets = useMemo(() => {
    if (selection.kind === 'shard') return [selection.id]
    if (selection.kind === 'host')
      return Array.from({ length: SHARDS_PER_HOST }, (_, i) => selection.id * SHARDS_PER_HOST + i)
    return []
  }, [selection])

  const pendingCost = jobs.filter((j) => j.action === 'IDENTIFY_SHARD').length

  function runAction(action) {
    const cost = action === 'IDENTIFY_SHARD' ? targets.length : 0
    const reserve = Math.ceil(budget.remaining * 0.1)
    if (cost > budget.remaining - pendingCost - reserve) {
      setNotice({
        tone: 'block',
        text: `Needs ${cost} session starts, ${budget.remaining - pendingCost - reserve} available after reserve. Reconnect instead — it resumes the session and costs none.`,
      })
      return
    }
    setBudget((b) => ({ ...b, remaining: b.remaining - cost }))
    setJobs((prev) => [...prev, ...targets.map((shardId) => ({ shardId, action }))])
    setNotice({
      tone: 'ok',
      text: `Queued ${targets.length} ${targets.length === 1 ? 'shard' : 'shards'} for ${action === 'IDENTIFY_SHARD' ? 're-identify' : 'reconnect'}.`,
    })
  }

  const hovered = hover?.shard

  return (
    <div className="min-h-screen w-full" style={{ background: C.ink, color: C.bone }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500&display=swap');
        :root {
          --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
          --cond: 'IBM Plex Sans Condensed', 'Helvetica Neue', sans-serif;
          --body: 'IBM Plex Sans', system-ui, sans-serif;
        }
      `}</style>

      <div style={{ fontFamily: 'var(--body)' }}>
        {/* Header ---------------------------------------------------------- */}
        <header
          className="px-5 py-4 flex flex-wrap items-end gap-x-8 gap-y-4 sticky top-0 z-20"
          style={{ background: C.ink, borderBottom: `1px solid ${C.line}` }}
        >
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] mb-1" style={{ color: C.blurple, fontFamily: 'var(--cond)' }}>
              Gateway fleet
            </div>
            <div className="text-[19px] leading-none tracking-tight" style={{ fontFamily: 'var(--cond)', fontWeight: 600 }}>
              {TOTAL_SHARDS.toLocaleString()} shards · {HOSTS} hosts
            </div>
          </div>

          <div className="flex gap-7 flex-wrap">
            <Stat label="Guilds" value={(fleet.guilds / 1e6).toFixed(2)} unit="M" />
            <Stat label="Connected" value={fleet.up.toLocaleString()} />
            <Stat label="Degraded" value={fleet.degraded} tone={fleet.degraded ? C.degraded : C.bone} />
            <Stat label="Down" value={fleet.down} tone={fleet.down ? C.dead : C.bone} />
            <Stat label="p99 heartbeat" value={fleet.p99} unit="ms" />
          </div>

          <div className="ml-auto flex items-end gap-7">
            <div className="w-[150px] hidden sm:block">
              <div className="text-[10px] uppercase tracking-[0.18em] mb-1" style={{ color: C.muted, fontFamily: 'var(--cond)' }}>
                Events/sec
              </div>
              <div className="h-8">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={eventRate}>
                    <YAxis hide domain={['dataMin - 8000', 'dataMax + 8000']} />
                    <Line type="monotone" dataKey="v" stroke={C.blurple} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <BudgetMeter remaining={budget.remaining} total={budget.total} pendingCost={pendingCost} />
          </div>
        </header>

        <div className="flex flex-col lg:flex-row">
          {/* Heatmap ------------------------------------------------------- */}
          <main className="flex-1 p-5">
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
              {Array.from({ length: HOSTS }, (_, h) => (
                <HostGrid
                  key={h}
                  hostId={h}
                  shards={shards}
                  selection={selection}
                  onSelect={setSelection}
                  onHover={setHover}
                  reduceMotion={reduceMotion}
                />
              ))}
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-2 mt-5 text-[11px]" style={{ color: C.muted, fontFamily: 'var(--mono)' }}>
              {[
                ['Connected', C.connected], ['Slow (>300ms)', C.degraded],
                ['Identify / resume', C.transitional], ['Down', C.dead],
              ].map(([label, color]) => (
                <span key={label} className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-[1px]" style={{ background: color }} />
                  {label}
                </span>
              ))}
              <span className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-[1px]" style={{ border: `1px solid ${C.bone}` }} />
                No heartbeat ACK
              </span>
            </div>
          </main>

          {/* Action rail --------------------------------------------------- */}
          <aside
            className="w-full lg:w-[340px] shrink-0 p-5"
            style={{ borderLeft: `1px solid ${C.line}`, background: C.panel }}
          >
            <div className="text-[10px] uppercase tracking-[0.22em] mb-3" style={{ color: C.blurple, fontFamily: 'var(--cond)' }}>
              Control
            </div>

            {selection.kind === 'none' ? (
              <p className="text-[13px] leading-relaxed" style={{ color: C.muted }}>
                Pick a shard from the grid, or a host header to take the whole host. Actions are priced in session starts before they run.
              </p>
            ) : (
              <>
                <div className="mb-4">
                  <div className="text-[17px] tracking-tight" style={{ fontFamily: 'var(--cond)', fontWeight: 600 }}>
                    {selection.kind === 'shard'
                      ? `Shard ${selection.id}`
                      : `Host ${String(selection.id).padStart(2, '0')}`}
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: C.muted, fontFamily: 'var(--mono)' }}>
                    {selection.kind === 'shard'
                      ? `host ${shards.current[selection.id].host} · worker ${shards.current[selection.id].worker} · ${Math.round(shards.current[selection.id].rtt)}ms · ${shards.current[selection.id].guilds} guilds`
                      : `${SHARDS_PER_HOST} shards · ${WORKERS_PER_HOST} workers`}
                  </div>
                </div>

                <div className="space-y-2">
                  <button
                    onClick={() => runAction('RECONNECT_SHARD')}
                    className="w-full text-left px-3 py-2.5 rounded-sm transition-colors focus:outline-none focus-visible:ring-2"
                    style={{ background: C.blurple, '--tw-ring-color': C.bone }}
                  >
                    <div className="text-[13px]" style={{ fontWeight: 500 }}>Reconnect</div>
                    <div className="text-[11px] opacity-80" style={{ fontFamily: 'var(--mono)' }}>
                      resumes session · 0 starts
                    </div>
                  </button>

                  <button
                    onClick={() => runAction('IDENTIFY_SHARD')}
                    className="w-full text-left px-3 py-2.5 rounded-sm transition-colors focus:outline-none focus-visible:ring-2"
                    style={{ background: C.panelHi, border: `1px solid ${C.line}`, '--tw-ring-color': C.blurple }}
                  >
                    <div className="text-[13px]" style={{ fontWeight: 500 }}>Re-identify</div>
                    <div className="text-[11px]" style={{ color: C.degraded, fontFamily: 'var(--mono)' }}>
                      fresh session · {targets.length} start{targets.length === 1 ? '' : 's'}
                    </div>
                  </button>

                  <button
                    onClick={() => setNotice({ tone: 'ok', text: 'Rolling redeploy started. Workers cycle one at a time; shards resume as they come back.' })}
                    className="w-full text-left px-3 py-2.5 rounded-sm focus:outline-none focus-visible:ring-2"
                    style={{ background: C.panelHi, border: `1px solid ${C.line}`, '--tw-ring-color': C.blurple }}
                  >
                    <div className="text-[13px]" style={{ fontWeight: 500 }}>Rolling redeploy</div>
                    <div className="text-[11px]" style={{ color: C.muted, fontFamily: 'var(--mono)' }}>
                      one worker at a time · 0 starts
                    </div>
                  </button>
                </div>
              </>
            )}

            {notice && (
              <div
                className="mt-4 px-3 py-2.5 rounded-sm text-[12px] leading-relaxed"
                style={{
                  background: C.panelHi,
                  borderLeft: `2px solid ${notice.tone === 'block' ? C.dead : C.blurple}`,
                  color: notice.tone === 'block' ? C.degraded : C.bone,
                }}
              >
                {notice.text}
              </div>
            )}

            {/* Queue ------------------------------------------------------- */}
            <div className="mt-7">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-[10px] uppercase tracking-[0.22em]" style={{ color: C.muted, fontFamily: 'var(--cond)' }}>
                  Queue
                </span>
                <span className="text-[11px] tabular-nums" style={{ fontFamily: 'var(--mono)', color: C.muted }}>
                  {jobs.length} pending
                </span>
              </div>

              {jobs.length === 0 ? (
                <p className="text-[12px]" style={{ color: C.muted }}>Nothing queued.</p>
              ) : (
                <>
                  <div className="grid gap-[2px] mb-2" style={{ gridTemplateColumns: `repeat(${MAX_CONCURRENCY}, 1fr)` }}>
                    {Array.from({ length: MAX_CONCURRENCY }, (_, b) => (
                      <div key={b} className="h-6 rounded-[1px]" style={{ background: b < Math.min(jobs.length, MAX_CONCURRENCY) ? C.transitional : C.unspawned }} />
                    ))}
                  </div>
                  <p className="text-[11px] leading-relaxed" style={{ color: C.muted, fontFamily: 'var(--mono)' }}>
                    {MAX_CONCURRENCY} buckets · 5s apart · ~{Math.ceil(jobs.length / MAX_CONCURRENCY * 5)}s remaining
                  </p>
                </>
              )}
            </div>
          </aside>
        </div>
      </div>

      {/* Hover readout ------------------------------------------------------ */}
      {hovered && (
        <div
          className="fixed z-30 pointer-events-none px-2.5 py-2 rounded-sm text-[11px] leading-snug"
          style={{
            left: Math.min(hover.x + 14, window.innerWidth - 190),
            top: hover.y + 14,
            background: C.panelHi,
            border: `1px solid ${C.line}`,
            fontFamily: 'var(--mono)',
          }}
        >
          <div style={{ color: C.bone }}>shard {hovered.id}</div>
          <div style={{ color: STATE_META[hovered.state].color }}>{STATE_META[hovered.state].label}</div>
          <div style={{ color: C.muted }}>
            {Math.round(hovered.rtt)}ms · w{hovered.worker} · {hovered.guilds} guilds
          </div>
        </div>
      )}
    </div>
  )
}
