import path from 'node:path';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration. The libSQL driver adapter is what lets `prisma db push`,
 * `migrate` and `studio` talk to Turso; a plain `file:` DATABASE_URL keeps using the
 * built-in SQLite connector so local development is unchanged.
 */
const url = process.env.DATABASE_URL ?? '';
const isRemoteLibsql = /^(libsql|wss?|https?):/.test(url);

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
  ...(isRemoteLibsql
    ? {
        experimental: { adapter: true },
        engine: 'js' as const,
        adapter: async () => new PrismaLibSQL({ url, authToken: process.env.TURSO_AUTH_TOKEN }),
      }
    : {}),
});
