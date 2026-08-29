import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';

// Next only reads .env files inside apps/sidewalk, so the repository-root file has to
// be loaded here for build-time values such as NEXT_PUBLIC_APP_URL to be inlined.
// Server-side database access does not rely on this: libs/db loads the same file at
// runtime, where the config is no longer in play.
nextEnv.loadEnvConfig(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // libs/* are shipped as TypeScript source and compiled by Next.
  transpilePackages: ['@sidewalk/api', '@sidewalk/core', '@sidewalk/db'],
  // Prisma and the libSQL driver load native/optional bindings at runtime, which webpack
  // cannot bundle; keep them as plain server-side requires.
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-libsql', '@libsql/client', 'libsql'],
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
