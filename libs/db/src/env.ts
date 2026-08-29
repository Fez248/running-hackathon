import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

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

export function loadDatabaseEnv(): void {
  const starts = [moduleDir(), process.cwd()].filter((dir): dir is string => dir !== undefined);
  const seen = new Set<string>();

  for (const start of starts) {
    const envFile = nearestEnvFile(start);
    if (!envFile || seen.has(envFile)) continue;
    seen.add(envFile);
    // dotenv never overwrites an existing variable, so a value supplied by the
    // process (CI, Vercel, dotenv-cli) always wins over the file.
    config({ path: envFile });
  }
}
