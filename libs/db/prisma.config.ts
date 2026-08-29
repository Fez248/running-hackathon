import path from 'node:path';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { defineConfig } from 'prisma/config';
import { databaseUrl, isRemoteLibsqlUrl } from './src/env';

/**
 * Prisma CLI configuration. The libSQL driver adapter is what lets `prisma db push`,
 * `migrate` and `studio` talk to Turso, and using it for local `file:` databases too
 * means the CLI and the application both obey DATABASE_URL rather than the schema's
 * hardcoded default.
 *
 * `migrate` is the exception: its wasm schema engine cannot create `_prisma_migrations`
 * through the libSQL adapter, so migrations run on the built-in SQLite connector — which
 * only reads the URL written in the schema.
 */
const url = databaseUrl();
const schemaUrl = `file:${path.join(__dirname, 'prisma', 'dev.db')}`;
const isMigrateCommand = process.argv.includes('migrate');
const useAdapter = isRemoteLibsqlUrl(url) || !isMigrateCommand;

if (isMigrateCommand && !isRemoteLibsqlUrl(url) && url !== schemaUrl) {
  console.warn(
    `prisma migrate ignores DATABASE_URL (${url}) and targets the schema's database instead.`,
  );
}

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
  ...(useAdapter
    ? {
        experimental: { adapter: true },
        engine: 'js' as const,
        adapter: async () =>
          new PrismaLibSQL(
            isRemoteLibsqlUrl(url) ? { url, authToken: process.env.TURSO_AUTH_TOKEN } : { url },
          ),
      }
    : {}),
});
