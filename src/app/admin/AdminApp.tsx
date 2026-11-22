'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

interface Summary {
  id: string
  ts: number
  route: string
  method: string
  status: number
  latency_ms: number
  request_id: string | null
  session_id: string
  client: string
  error_code: string | null
  findings: number | null
  has_image: boolean
  image_bytes: number | null
  response_bytes: number
  search: string
}

interface Detail {
  summary: Summary
  detail: {
    request: Record<string, unknown>
    response: Record<string, unknown>
    settings: Record<string, unknown>
    timing: Record<string, unknown>
    trigger: string | null
    has_model_image: boolean
  }
}

type Phase = 'checking' | 'login' | 'ready'

const imgUrl = (id: string, size: 'thumb' | 'full' | 'model') =>
  `/api/admin/logs/${id}/image?size=${size}`

function statusClass(status: number): string {
  if (status >= 500 || status === 0) return 'bg-rose-100 text-rose-800'
  if (status >= 400) return 'bg-amber-100 text-amber-800'
  return 'bg-emerald-100 text-emerald-800'
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded border border-line bg-zinc-50 p-2 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

function DetailView({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/admin/logs/${id}`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<Detail>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [id])
  if (error) return <p className="p-3 text-sm text-rose-700">Failed to load: {error}</p>
  if (!data) return <p className="p-3 text-sm text-zinc-500">Loading…</p>
  const { detail, summary } = data
  const resp = detail.response as { body?: { errors?: unknown[]; board_summary?: string } | null }
  return (
    <div className="grid gap-3 p-3 text-sm lg:grid-cols-2">
      {summary.has_image && (
        <section className="lg:col-span-2">
          <h3 className="mb-1 font-medium">Frames</h3>
          <div className="flex flex-wrap gap-3">
            <figure>
              <a href={imgUrl(id, 'full')} target="_blank" rel="noreferrer">
                <img src={imgUrl(id, 'full')} alt="Frame as uploaded" className="max-h-72 rounded border border-line" />
              </a>
              <figcaption className="text-xs text-zinc-500">As uploaded (click for full size)</figcaption>
            </figure>
            {detail.has_model_image && (
              <figure>
                <a href={imgUrl(id, 'model')} target="_blank" rel="noreferrer">
                  <img src={imgUrl(id, 'model')} alt="Frame as sent to the model" className="max-h-72 rounded border border-line" />
                </a>
                <figcaption className="text-xs text-zinc-500">Rectified, as sent to the model</figcaption>
              </figure>
            )}
          </div>
        </section>
      )}
      <section>
        <h3 className="mb-1 font-medium">Request</h3>
        <Json value={detail.request} />
      </section>
      <section>
        <h3 className="mb-1 font-medium">Response</h3>
        {resp.body?.board_summary && <p className="mb-1 text-xs text-zinc-600">Board: {resp.body.board_summary}</p>}
        <Json value={detail.response} />
      </section>
      <section>
        <h3 className="mb-1 font-medium">Settings &amp; timing (trigger: {detail.trigger ?? 'n/a'})</h3>
        <Json value={{ settings: detail.settings, timing: detail.timing }} />
      </section>
      <section>
        <h3 className="mb-1 font-medium">Raw entry</h3>
        <Json value={data} />
      </section>
    </div>
  )
}

export function AdminApp() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [token, setToken] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [entries, setEntries] = useState<Summary[]>([])
  const [meta, setMeta] = useState<string>('')
  const [query, setQuery] = useState('')
  const [route, setRoute] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/logs', { cache: 'no-store' })
      if (r.status === 401) {
        setPhase('login')
        return
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = (await r.json()) as { entries: Summary[]; storage: string | null }
      setEntries(body.entries)
      setMeta(body.storage ?? 'no storage configured — nothing is being recorded')
      setLoadError(null)
      setPhase('ready')
    } catch (e) {
      setLoadError(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (phase !== 'ready' || !auto) return
    const t = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(t)
  }, [phase, auto, load])

  const login = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginError(null)
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    setToken('')
    if (r.ok) await load()
    else setLoginError(r.status === 429 ? 'Too many attempts; wait a minute.' : 'Invalid token.')
  }

  const logout = async () => {
    await fetch('/api/admin/logout', { method: 'POST' })
    setEntries([])
    setPhase('login')
  }

  const clearAll = async () => {
    if (!window.confirm('Delete all stored debug logs and images?')) return
    await fetch('/api/admin/logs', { method: 'DELETE' })
    await load()
  }

  const routes = useMemo(() => Array.from(new Set(entries.map((e) => e.route))).sort(), [entries])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (route !== 'all' && e.route !== route) return false
      if (statusFilter === 'ok' && e.status >= 400) return false
      if (statusFilter === 'error' && e.status < 400) return false
      return !q || e.search.includes(q) || e.id.includes(q)
    })
  }, [entries, query, route, statusFilter])

  if (phase === 'checking') return <main className="p-6 text-sm text-zinc-500">Loading…</main>

  if (phase === 'login') {
    return (
      <main className="mx-auto mt-24 max-w-sm p-6">
        <form onSubmit={login} className="space-y-3 rounded-lg border border-line bg-panel p-5">
          <h1 className="text-lg font-medium">Chalkolate admin</h1>
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Admin token"
            aria-label="Admin token"
            className="w-full rounded border border-line px-3 py-2 text-sm"
          />
          {loginError && <p className="text-sm text-rose-700">{loginError}</p>}
          <button type="submit" className="w-full rounded bg-accent px-3 py-2 text-sm text-white">
            Sign in
          </button>
        </form>
      </main>
    )
  }

  return (
    <main className="p-4 text-sm">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-lg font-medium">Chalkolate admin</h1>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search id, session, error, finding, spoken text…"
          aria-label="Search logs"
          className="min-w-64 flex-1 rounded border border-line px-3 py-1.5"
        />
        <select value={route} onChange={(e) => setRoute(e.target.value)} aria-label="Route" className="rounded border border-line px-2 py-1.5">
          <option value="all">All routes</option>
          {routes.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status" className="rounded border border-line px-2 py-1.5">
          <option value="all">Any status</option>
          <option value="ok">Success</option>
          <option value="error">Errors (4xx/5xx)</option>
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh
        </label>
        <button onClick={() => void load()} className="rounded border border-line px-3 py-1.5">Refresh</button>
        <button onClick={() => void clearAll()} className="rounded border border-line px-3 py-1.5 text-rose-700">Clear</button>
        <button onClick={() => void logout()} className="rounded border border-line px-3 py-1.5">Sign out</button>
      </header>
      <p className="mb-2 text-xs text-zinc-500">
        {filtered.length} of {entries.length} entries · store: {meta}
        {loadError ? ` · last refresh failed: ${loadError}` : ''}
      </p>
      <div className="overflow-x-auto rounded border border-line bg-panel">
        <table className="w-full text-left">
          <thead className="bg-zinc-50 text-xs text-zinc-500">
            <tr>
              <th className="p-2">Time</th>
              <th className="p-2">Frame</th>
              <th className="p-2">Route</th>
              <th className="p-2">Status</th>
              <th className="p-2">Latency</th>
              <th className="p-2">Request</th>
              <th className="p-2">Session</th>
              <th className="p-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <FragmentRow key={e.id} e={e} open={expanded === e.id} toggle={() => setExpanded(expanded === e.id ? null : e.id)} />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-zinc-500">No matching requests.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}

function FragmentRow({ e, open, toggle }: { e: Summary; open: boolean; toggle: () => void }) {
  return (
    <>
      <tr onClick={toggle} className="cursor-pointer border-t border-line hover:bg-zinc-50" aria-expanded={open}>
        <td className="whitespace-nowrap p-2">{new Date(e.ts).toLocaleTimeString()}</td>
        <td className="p-2">
          {e.has_image ? (
            <img src={imgUrl(e.id, 'thumb')} alt="" loading="lazy" className="h-10 w-14 rounded object-cover" />
          ) : null}
        </td>
        <td className="p-2 font-mono text-xs">{e.method} {e.route}</td>
        <td className="p-2">
          <span className={`rounded px-1.5 py-0.5 text-xs ${statusClass(e.status)}`}>{e.status}</span>
        </td>
        <td className="p-2">{e.latency_ms} ms</td>
        <td className="p-2 font-mono text-xs">{e.request_id?.slice(0, 8) ?? '—'}</td>
        <td className="p-2 font-mono text-xs">{e.session_id.slice(0, 8) || '—'}</td>
        <td className="p-2 text-xs">
          {e.error_code ?? (e.findings !== null ? `${e.findings} finding(s)` : '')}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-line bg-white">
          <td colSpan={8}>
            <DetailView id={e.id} />
          </td>
        </tr>
      )}
    </>
  )
}
