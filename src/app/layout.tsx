import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import 'katex/dist/katex.min.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'Chalkolate',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-surface text-zinc-900 antialiased">
        {children}
      </body>
    </html>
  )
}
