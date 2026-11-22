import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import localFont from 'next/font/local'
import 'katex/dist/katex.min.css'
import './globals.css'

const bodyFont = localFont({
  src: './fonts/dm-sans.woff2',
  weight: '100 1000',
  variable: '--font-body',
  display: 'swap',
})
const chalk = localFont({
  src: './fonts/fredericka-the-great.woff2',
  weight: '400',
  variable: '--font-fredericka',
  adjustFontFallback: 'Times New Roman',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Chalkolate',
  icons: { icon: '/icon.svg' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f4f6f2',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={bodyFont.variable + ' ' + chalk.variable}>
      <body className="bg-surface text-ink antialiased">
        {children}
      </body>
    </html>
  )
}
