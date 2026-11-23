import type { NextConfig } from 'next'

// Local development: proxy /api/* to the FastAPI backend (`uv run uvicorn main:app --app-dir server --port 8000`).
// In production, set CHALKOLATE_API_PROXY_TARGET explicitly when serving behind a separate backend.
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
