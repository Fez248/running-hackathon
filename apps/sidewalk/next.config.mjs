import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';

// The monorepo keeps a single .env at the repository root; Next would only look
// inside apps/sidewalk, so load the root file before the config is used.
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
