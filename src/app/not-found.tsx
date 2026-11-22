import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 shadow-soft sm:p-8">
        <h1 className="ui-title">Page not found</h1>
        <p className="ui-copy mt-2">Check the address or return to the studio.</p>
        <Link href="/" className="ui-button mt-6" data-variant="primary">Back to studio</Link>
      </div>
    </main>
  )
}
