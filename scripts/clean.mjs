// Removes build outputs before a fresh build (cross-platform `rm -rf`).
import { rmSync } from 'node:fs';

for (const dir of ['dist', '.types']) rmSync(dir, { recursive: true, force: true });
