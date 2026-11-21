import type { NextConfig } from 'next'

// Local development: proxy /api/* to the FastAPI backend (`uv run uvicorn` on :8000).
// On Vercel, /api/* is routed to the Python service by the root vercel.json, so no rewrite is needed
// unless CHALKOLATE_API_PROXY_TARGET is set explicitly.
const explicitTarget = process.env['CHALKOLATE_API_PROXY_TARGET']
const apiProxyTarget =
  explicitTarget ?? (process.env.NODE_ENV === 'production' ? undefined : 'http://127.0.0.1:8000')

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return apiProxyTarget ? [{ source: '/api/:path*', destination: `${apiProxyTarget}/api/:path*` }] : []
  },
}

export default nextConfig
