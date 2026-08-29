import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
import { loadDatabaseEnv } from './env';

loadDatabaseEnv();

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const url = process.env.DATABASE_URL ?? '';
/** Turso (and any remote libSQL server) needs the driver adapter; plain files do not. */
const isRemoteLibsql = /^(libsql|wss?|https?):/.test(url);

function createClient(): PrismaClient {
  const log: ('warn' | 'error')[] =
    process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'];

  if (!isRemoteLibsql) {
    return new PrismaClient({ log });
  }

  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!authToken) {
    throw new Error('TURSO_AUTH_TOKEN is required when DATABASE_URL points at a remote libSQL database');
  }

  return new PrismaClient({ adapter: new PrismaLibSQL({ url, authToken }), log });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
