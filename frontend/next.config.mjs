import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const apiBase = process.env.API_PROXY_URL || process.env.NEXT_PUBLIC_API_PROXY;
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

function normalizeApiBase(value) {
  if (!value) {
    return undefined;
  }

  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('API_PROXY_URL must use http or https.');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('API_PROXY_URL must use https in production.');
  }
  if (url.username || url.password) {
    throw new Error('API_PROXY_URL must not include credentials.');
  }
  if (url.pathname !== '/') {
    throw new Error('API_PROXY_URL must be an origin without a path.');
  }
  if (url.search || url.hash) {
    throw new Error('API_PROXY_URL must not include a query string or hash.');
  }

  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

const normalizedApiBase = normalizeApiBase(apiBase);

const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: projectRoot,
  },
  async rewrites() {
    if (!normalizedApiBase) {
      return [];
    }
    return [
      {
        source: '/api/:path*',
        destination: normalizedApiBase + '/api/:path*',
      },
    ];
  },
};

export default nextConfig;
