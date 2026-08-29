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
