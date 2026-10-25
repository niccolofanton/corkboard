// Copies the hand-written declaration of the standalone decode worker next to its JS in dist/.
import { copyFileSync } from 'node:fs';

copyFileSync('scripts/decode.worker.d.ts', 'dist/decode.worker.d.ts');
