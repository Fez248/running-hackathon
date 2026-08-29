import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';

/**
 * The monorepo keeps one .env at the repository root, but this client is
 * instantiated from several working directories (the Next dev server in
 * apps/sidewalk, Prisma scripts in libs/db, tsx scripts anywhere) and by child
 * processes that never see a parent's dotenv call. Walking up from the current
 * directory finds that single file from all of them.
 */
export function loadDatabaseEnv(): void {
  if (process.env.DATABASE_URL) return;

  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      config({ path: candidate });
      if (process.env.DATABASE_URL) return;
    }

    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
