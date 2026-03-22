import { cpSync, existsSync, rmSync } from 'fs';
import { resolve } from 'path';

const sourceDir = resolve('src/public');
const targetDir = resolve('dist/public');

if (!existsSync(sourceDir)) {
    throw new Error(`Missing admin public assets at ${sourceDir}`);
}

rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, { recursive: true });
