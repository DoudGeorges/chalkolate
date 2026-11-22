'use client'

import { ArrowLeft, ChevronDown, CircleAlert, KeyRound, LoaderCircle, LogOut, RefreshCw, Search, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { Brand } from '../../components/Brand'

const SummarySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  ts: z.number(),
  route: z.string(),
  method: z.string(),
  status: z.number(),
  latency_ms: z.number(),
  request_id: z.string().nullable(),
  session_id: z.string(),
  error_code: z.string().nullable(),
  findings: z.number().nullable(),
  has_image: z.boolean(),
  search: z.string(),
})
type Summary = z.infer<typeof SummarySchema>

const DetailSchema = z.looseObject({
  summary: SummarySchema.passthrough(),
  detail: z.looseObject({
    request: z.looseObject({ image: z.object({ stored: z.boolean() }).nullable().optional() }),
    response: z.record(z.string(), z.unknown()),
    settings: z.record(z.string(), z.unknown()),
    timing: z.record(z.string(), z.unknown()),
    trigger: z.string().nullable(),
    has_model_image: z.boolean(),
  }),
})
const LogListSchema = z.object({ entries: z.array(SummarySchema), storage: z.string().nullable() })
type Detail = z.infer<typeof DetailSchema>

type Phase = 'checking' | 'login' | 'ready'

const imgUrl = (id: string, size: 'thumb' | 'full' | 'model') =>
  '/api/admin/logs/' + id + '/image?size=' + size

function adminFetch(path: string, init: RequestInit = {}) {
  const deadline = AbortSignal.timeout(15_000)
  return fetch(`/api/admin/${path}`, {
    ...init,
    cache: 'no-store',
    signal: init.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
  })
}

function statusClass(status: number): string {
  if (status >= 500 || status === 0) return 'bg-danger-soft text-danger'
  if (status >= 400) return 'bg-warn-soft text-warn'
  return 'bg-moss-soft text-moss'
}

function AdminFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <Brand />
          <Link href="/" className="ui-button" data-variant="quiet">
            <ArrowLeft aria-hidden="true" /> Back to studio
          </Link>
        </div>
      </header>
      {children}
    </>
  )
}

function AdminNotice({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm text-danger">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>{children}</p>
    </div>
  )
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-panel p-3 font-sans text-xs leading-relaxed tabular-nums text-ink">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

function DetailView({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    const request = new AbortController()
    adminFetch(`logs/${id}`, { signal: request.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Request unavailable')
        return DetailSchema.parse(await response.json())
      })
      .then((detail) => {
        if (!request.signal.aborted) setData(detail)
      })
      .catch(() => {
        if (!request.signal.aborted) setError(true)
      })
    return () => request.abort()
  }, [id])

  if (error) return <div className="p-4"><AdminNotice>This request could not be loaded. Reopen it to try again.</AdminNotice></div>
  if (!data) return <p role="status" className="p-4 text-sm text-muted">Loading request…</p>

  const { detail, summary } = data
  const frameSizes: Array<'full' | 'model' | 'thumb'> = []
  if (summary.has_image) frameSizes.push(detail.request.image?.stored === false ? 'thumb' : 'full')
  if (detail.has_model_image) frameSizes.push('model')

  return (
    <div className="grid max-w-[calc(100vw-3rem)] gap-4 p-4 text-sm md:max-w-none lg:grid-cols-2">
      {frameSizes.length > 0 && (
        <section className="lg:col-span-2">
          <h3 className="mb-2 font-semibold text-ink">Board images</h3>
          <div className="flex flex-wrap gap-4">
            {frameSizes.map((size) => {
              const label = size === 'model' ? 'Frame sent to the model' : size === 'thumb' ? 'Uploaded frame thumbnail' : 'Uploaded frame'
              return (
                <figure key={size}>
                  <a href={imgUrl(id, size)} target="_blank" rel="noreferrer" className="inline-block rounded-lg">
                    <img src={imgUrl(id, size)} alt={label} className="max-h-60 rounded-lg border border-line object-contain" />
                  </a>
                  <figcaption className="mt-1 text-xs text-muted">{label}</figcaption>
                </figure>
              )
            })}
          </div>
        </section>
      )}
      <section className="min-w-0">
        <h3 className="mb-2 font-semibold text-ink">Request</h3>
        <Json value={detail.request} />
      </section>
      <section className="min-w-0">
        <h3 className="mb-2 font-semibold text-ink">Response</h3>
        <Json value={detail.response} />
      </section>
      <section className="min-w-0">
        <h3 className="mb-2 font-semibold text-ink">Settings and timing</h3>
        <Json value={{ trigger: detail.trigger, settings: detail.settings, timing: detail.timing }} />
      </section>
      <section className="min-w-0">
        <h3 className="mb-2 font-semibold text-ink">Raw entry</h3>
        <Json value={data} />
      </section>
    </div>
  )
}

export function AdminApp() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [token, setToken] = useState('')
  const [action, setAction] = useState<'login' | 'logout' | 'clear' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [entries, setEntries] = useState<Summary[]>([])
  const [storage, setStorage] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [route, setRoute] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const pendingLoad = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    pendingLoad.current?.abort()
    const request = new AbortController()
    pendingLoad.current = request
    try {
      const result = await adminFetch('logs', { signal: request.signal })
      if (request.signal.aborted) return
      if (result.status === 401) {
        setEntries([])
        setExpanded(null)
        setStorage(null)
        setLoadError(false)
        setPhase('login')
        return
      }
      if (!result.ok) throw new Error('Request log unavailable')
      const body = LogListSchema.parse(await result.json())
      if (request.signal.aborted) return
      setEntries(body.entries)
      setStorage(body.storage)
      setLoadError(false)
      setPhase('ready')
    } catch {
      if (!request.signal.aborted) setLoadError(true)
    } finally {
      if (pendingLoad.current === request) pendingLoad.current = null
    }
  }, [])

  useEffect(() => {
    void load()
    return () => pendingLoad.current?.abort()
  }, [load])

  useEffect(() => {
    if (phase !== 'ready' || !auto || action) return
    const timer = window.setInterval(() => {
      if (!pendingLoad.current) void load()
    }, 4000)
    return () => window.clearInterval(timer)
  }, [phase, auto, action, load])

  const login = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!token || action) return
    setAction('login')
    setActionError(null)
    try {
      const response = await adminFetch('login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (response.ok) {
        setPhase('checking')
        await load()
      } else if (response.status === 401 || response.status === 429) {
        setActionError(response.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'The admin token is incorrect.')
      } else {
        throw new Error('Sign-in unavailable')
      }
    } catch {
      setActionError('Couldn’t sign in. Check your connection and try again.')
    } finally {
      setToken('')
      setAction(null)
    }
  }

  const updateLogs = async (operation: 'logout' | 'clear') => {
    if (action) return
    if (operation === 'clear' && !window.confirm('Delete all stored request logs and board images?')) return
    pendingLoad.current?.abort()
    setAction(operation)
    setActionError(null)
    try {
      const response = operation === 'logout'
        ? await adminFetch('logout', { method: 'POST' })
        : await adminFetch('logs', { method: 'DELETE' })
      if (!response.ok) throw new Error('Operation unavailable')
      setExpanded(null)
      if (operation === 'logout') {
        setEntries([])
        setPhase('login')
      } else {
        await load()
      }
    } catch {
      setActionError(operation === 'logout' ? 'Couldn’t sign out. Try again.' : 'Couldn’t clear the logs. Try again.')
    } finally {
      setAction(null)
    }
  }

  const routes = useMemo(() => Array.from(new Set(entries.map((entry) => entry.route))).sort(), [entries])
  const activeRoute = routes.includes(route) ? route : 'all'
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return entries.filter((entry) => {
      if (activeRoute !== 'all' && entry.route !== activeRoute) return false
      const failed = entry.status === 0 || entry.status >= 400
      if (statusFilter === 'ok' && failed) return false
      if (statusFilter === 'error' && !failed) return false
      return !term || entry.search.includes(term) || entry.id.includes(term)
    })
  }, [activeRoute, entries, query, statusFilter])

  if (phase !== 'ready') {
    return (
      <AdminFrame>
        <main className="mx-auto max-w-md px-5 py-14 sm:py-24">
          <section className="rounded-2xl border border-line bg-panel p-5 shadow-pop sm:p-8">
            <KeyRound className="mb-4 size-5 text-moss" aria-hidden="true" />
            <h1 className="ui-title">Admin console</h1>
            {phase === 'login' ? (
              <form onSubmit={login} className="mt-6 space-y-4">
                <label className="ui-label block">
                  Admin token
                  <input
                    type="password"
                    autoComplete="off"
                    required
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    className="ui-field mt-2"
                  />
                </label>
                {actionError && <AdminNotice>{actionError}</AdminNotice>}
                <button type="submit" disabled={!token || action !== null} className="ui-button min-h-10 w-full" data-variant="primary">
                  {action === 'login' ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            ) : loadError ? (
              <div className="mt-5 space-y-3">
                <AdminNotice>Couldn’t connect to the admin console.</AdminNotice>
                <button type="button" onClick={() => void load()} className="ui-button">
                  <RefreshCw aria-hidden="true" /> Retry
                </button>
              </div>
            ) : (
              <p role="status" className="mt-5 flex items-center gap-2 text-sm text-muted">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Checking access…
              </p>
            )}
          </section>
        </main>
      </AdminFrame>
    )
  }

  return (
    <AdminFrame>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="ui-title">Request log</h1>
            <p className="ui-copy mt-2">
              {storage ? 'Log storage: ' + storage : 'Log storage is unavailable.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void updateLogs('clear')} disabled={!entries.length || action !== null} className="ui-button" data-variant="danger">
              <Trash2 aria-hidden="true" /> {action === 'clear' ? 'Clearing…' : 'Clear logs'}
            </button>
            <button type="button" onClick={() => void updateLogs('logout')} disabled={action !== null} className="ui-button">
              <LogOut aria-hidden="true" /> {action === 'logout' ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>

        <section aria-label="Request log filters" className="mb-3 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-panel p-3">
          <label className="ui-label min-w-40 flex-[2]">
            Search
            <span className="relative mt-2 block">
              <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Request ID, error, or finding"
                className="ui-field pl-9 font-normal"
              />
            </span>
          </label>
          <label className="ui-label min-w-32 flex-1">
            Route
            <select value={activeRoute} onChange={(event) => setRoute(event.target.value)} className="ui-field mt-2 font-normal">
              <option value="all">All routes</option>
              {routes.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="ui-label min-w-28 flex-1">
            Status
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="ui-field mt-2 font-normal">
              <option value="all">All statuses</option>
              <option value="ok">Success</option>
              <option value="error">Error</option>
            </select>
          </label>
          <label className="flex min-h-10 items-center gap-2 px-1 text-sm text-muted">
            <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} className="size-4 accent-accent" />
            Refresh automatically
          </label>
          <button type="button" onClick={() => void load()} disabled={action !== null} className="ui-button min-h-10">
            <RefreshCw aria-hidden="true" /> Refresh
          </button>
        </section>

        <div className="mb-3 space-y-2">
          <p className="tabular-nums text-xs font-medium text-muted">
            {filtered.length} of {entries.length} {entries.length === 1 ? 'request' : 'requests'}
          </p>
          {actionError && <AdminNotice>{actionError}</AdminNotice>}
          {loadError && <AdminNotice>Couldn’t refresh the request log. Select Refresh to try again.</AdminNotice>}
        </div>

        <div role="region" aria-label="Request log table" tabIndex={0} className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">Captured requests</caption>
            <thead className="border-b border-line bg-surface text-xs text-muted">
              <tr>
                {['Time', 'Frame', 'Route', 'Status', 'Latency', 'Request ID', 'Session', 'Result'].map((label) => (
                  <th key={label} scope="col" className="px-3 py-3 font-semibold">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <RequestRow key={entry.id} entry={entry} open={expanded === entry.id} toggle={() => setExpanded(expanded === entry.id ? null : entry.id)} />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-sm text-muted">
                    {entries.length ? 'No requests match these filters.' : 'No requests recorded yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </AdminFrame>
  )
}

function RequestRow({ entry, open, toggle }: { entry: Summary; open: boolean; toggle: () => void }) {
  const result = entry.findings === null
    ? null
    : entry.findings + (entry.findings === 1 ? ' finding' : ' findings')
  return (
    <>
      <tr className="border-t border-line first:border-t-0 hover:bg-surface">
        <td className="tabular-nums whitespace-nowrap px-3 py-2">{new Date(entry.ts).toLocaleTimeString()}</td>
        <td className="px-3 py-2">
          {entry.has_image && <img src={imgUrl(entry.id, 'thumb')} alt="" loading="lazy" className="h-9 w-13 max-w-none rounded object-cover" />}
        </td>
        <td className="px-3 py-2">
          <button type="button" onClick={toggle} aria-expanded={open} className="flex min-h-9 items-center gap-2 rounded-sm text-sm font-semibold text-ink">
            <ChevronDown className={open ? 'size-3.5 rotate-180 text-moss' : 'size-3.5 text-muted'} aria-hidden="true" />
            {entry.method} {entry.route}
          </button>
        </td>
        <td className="px-3 py-2">
          <span className={'tabular-nums rounded-md px-1.5 py-0.5 text-xs font-medium ' + statusClass(entry.status)}>
            {entry.status || 'Failed'}
          </span>
        </td>
        <td className="tabular-nums whitespace-nowrap px-3 py-2">{entry.latency_ms} ms</td>
        <td className="px-3 py-2 text-xs tabular-nums text-muted">{entry.request_id?.slice(0, 8) ?? 'None'}</td>
        <td className="px-3 py-2 text-xs tabular-nums text-muted">{entry.session_id.slice(0, 8) || 'None'}</td>
        <td className="px-3 py-2 text-xs">{entry.error_code ?? result}</td>
      </tr>
      {open && (
        <tr className="border-t border-line bg-surface">
          <td colSpan={8}><DetailView id={entry.id} /></td>
        </tr>
      )}
    </>
  )
}
