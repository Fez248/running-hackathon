import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const SCHEMA_RELATIVE_PATH = join('libs', 'db', 'prisma', 'schema.prisma');

/**
 * The monorepo keeps one .env at the repository root, but this client is
 * instantiated from several working directories (the Next dev server in
 * apps/sidewalk, Prisma scripts in libs/db, tsx scripts anywhere) and by child
 * processes that never see a parent's dotenv call. Walking up from both this
 * module's directory and the working directory finds that single file from all
 * of them, including servers started outside the repository.
 */
function nearestEnvFile(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

function moduleDir(): string | undefined {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

function searchStarts(): string[] {
  return [moduleDir(), process.cwd()].filter((dir): dir is string => dir !== undefined);
}

export function loadDatabaseEnv(): void {
  const seen = new Set<string>();

  for (const start of searchStarts()) {
    const envFile = nearestEnvFile(start);
    if (!envFile || seen.has(envFile)) continue;
    seen.add(envFile);
    // dotenv never overwrites an existing variable, so a value supplied by the
    // process (CI, Vercel, dotenv-cli) always wins over the file.
    config({ path: envFile });
  }
}

/** Remote libSQL/Turso servers need the driver adapter; local files do not. */
export function isRemoteLibsqlUrl(url: string): boolean {
  return /^(libsql|wss?|https?):/.test(url);
}

function schemaDir(): string | undefined {
  for (const start of searchStarts()) {
    for (let dir = start; ; dir = dirname(dir)) {
      if (existsSync(resolve(dir, SCHEMA_RELATIVE_PATH))) {
        return resolve(dir, dirname(SCHEMA_RELATIVE_PATH));
      }
      if (dirname(dir) === dir) break;
    }
  }
  return undefined;
}

/**
 * Relative `file:` URLs are documented as relative to the Prisma schema, which
 * Prisma only honours for the URL written in the schema itself. Making them
 * absolute here keeps a `DATABASE_URL` override pointing at the same database
 * for the CLI, the dev server and one-off scripts.
 */
export function databaseUrl(): string {
  loadDatabaseEnv();

  const url = process.env.DATABASE_URL ?? '';
  if (!url.startsWith('file:')) return url;

  const filePath = url.slice('file:'.length);
  if (isAbsolute(filePath)) return url;

  const dir = schemaDir();
  return dir ? `file:${resolve(dir, filePath)}` : url;
}
