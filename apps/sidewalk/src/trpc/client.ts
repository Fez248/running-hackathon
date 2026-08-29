'use client';

import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@sidewalk/api';

export const api = createTRPCReact<AppRouter>();
