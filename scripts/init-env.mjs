import { copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every workspace reads the repository-root .env, so this is the only file to create.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, '.env');

if (existsSync(target)) {
  console.log('.env already exists, leaving it untouched');
} else {
  copyFileSync(resolve(root, '.env.example'), target);
  console.log('created .env from .env.example');
}
