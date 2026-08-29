import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
import { databaseUrl, isRemoteLibsqlUrl } from './env';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const url = databaseUrl();
  const log: ('warn' | 'error')[] =
    process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'];

  if (!isRemoteLibsqlUrl(url)) {
    return new PrismaClient({ datasources: { db: { url } }, log });
  }

  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!authToken) {
    throw new Error(
      'TURSO_AUTH_TOKEN is required when DATABASE_URL points at a remote libSQL database',
    );
  }

  return new PrismaClient({ adapter: new PrismaLibSQL({ url, authToken }), log });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
