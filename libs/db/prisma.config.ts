import path from 'node:path';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { defineConfig } from 'prisma/config';
import { databaseUrl, isRemoteLibsqlUrl } from './src/env';

/**
 * Prisma CLI configuration. The libSQL driver adapter is what lets `prisma db push`,
 * `migrate` and `studio` talk to Turso, and using it for local `file:` databases too
 * means the CLI and the application both obey DATABASE_URL rather than the schema's
 * hardcoded default.
 */
export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
  experimental: { adapter: true },
  engine: 'js',
  adapter: async () => {
    const url = databaseUrl();
    return new PrismaLibSQL(
      isRemoteLibsqlUrl(url) ? { url, authToken: process.env.TURSO_AUTH_TOKEN } : { url },
    );
  },
});
