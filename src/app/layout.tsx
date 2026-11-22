import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { Fredericka_the_Great } from 'next/font/google'
import 'katex/dist/katex.min.css'
import './globals.css'

// Chalk handwriting font for the TopBar wordmark only (self-hosted by next/font).
const chalk = Fredericka_the_Great({ weight: '400', subsets: ['latin'], display: 'swap', variable: '--font-fredericka' })

export const metadata: Metadata = {
  title: 'Chalkolate',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={chalk.variable}>
      <body className="bg-surface text-zinc-900 antialiased">
        {children}
      </body>
    </html>
  )
}
