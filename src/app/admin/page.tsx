import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { AdminApp } from './AdminApp'

export const metadata: Metadata = {
  title: 'Chalkolate admin',
  robots: { index: false, follow: false },
}

// Owner-only debugging console. Returns a real 404 unless debug logging is explicitly enabled
// (docs/admin.md). The env is read per request so toggling it needs no rebuild.
export default async function AdminPage() {
  await connection()
  const enabled =
    process.env['ADMIN_DEBUG_LOGGING'] === '1' && (process.env['ADMIN_TOKEN'] ?? '').length >= 16
  if (!enabled) notFound()
  return <AdminApp />
}
