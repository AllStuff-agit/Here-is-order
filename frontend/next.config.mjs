/** @type {import('next').NextConfig} */
const apiBase = process.env.NEXT_PUBLIC_API_PROXY;

const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
  async rewrites() {
    if (!apiBase) {
      return [];
    }
    return [
      {
        source: '/api/:path*',
        destination: `${apiBase.replace(/\/$/, '')}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
