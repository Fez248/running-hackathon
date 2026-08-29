/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // libs/* are shipped as TypeScript source and compiled by Next.
  transpilePackages: ['@sidewalk/api', '@sidewalk/core', '@sidewalk/db'],
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
