import superjson from 'superjson';

/**
 * Shared by the tRPC server and the browser client so Date values survive the
 * wire. It lives in @sidewalk/core because the client must not import
 * @sidewalk/api (that would pull @trpc/server and Prisma into the browser
 * bundle).
 */
export const transformer = superjson;
