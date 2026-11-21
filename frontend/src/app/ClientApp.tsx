'use client'

import dynamic from 'next/dynamic'

// The studio depends on camera, screen capture, canvas, and audio browser APIs, so it
// renders on the client only. Monitoring still starts stopped and never auto-requests media.
const App = dynamic(() => import('../App'), { ssr: false })

export function ClientApp() {
  return <App />
}
