import type { NextConfig } from 'next'

// Temporary: calibrated analysis and board detection still run on the Python backend.
// Remove once warp/projection/detection are ported and `backend/` is deleted.
const legacyBackend = process.env['CHALKOLATE_API_PROXY_TARGET'] ?? 'http://127.0.0.1:8000'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/api/legacy/:path*', destination: `${legacyBackend}/api/:path*` }]
  },
}

export default nextConfig
