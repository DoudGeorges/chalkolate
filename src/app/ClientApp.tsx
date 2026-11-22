'use client'

import dynamic from 'next/dynamic'

// The studio depends on camera, screen capture, canvas, and audio browser APIs, so it
// renders on the client only. Monitoring still starts stopped and never auto-requests media.
const App = dynamic(() => import('../App'), {
  ssr: false,
  loading: () => (
    <main className="grid min-h-dvh place-items-center bg-surface text-sm text-muted">
      <p role="status">Loading Chalkolate…</p>
    </main>
  ),
})

export function ClientApp() {
  return <App />
}
