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
  icons: {
    icon: [
      { url: '/favicon-96x96.png', sizes: '96x96', type: 'image/png' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/favicon.ico',
    apple: { url: '/apple-touch-icon.png', sizes: '180x180' },
  },
  appleWebApp: { title: 'Chalkolate' },
  manifest: '/site.webmanifest',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#FFF5E8',
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
