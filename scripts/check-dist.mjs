// The published bundle must not carry the test hooks (they are dead code behind `__CORKBOARD_TEST__`, which the
// library build sets to `false`; only the e2e build keeps them), neither in the JS nor in the type declarations
// (no `declare global` for a hook).
import { readdirSync, readFileSync } from 'node:fs';

const hooks = ['__corkboardForcePublicUpload', '__CORKBOARD_TEST__'];
const bad = [];
for (const f of readdirSync('dist').filter((n) => n.endsWith('.js') || n.endsWith('.d.ts'))) {
  const code = readFileSync(`dist/${f}`, 'utf8');
  for (const h of hooks) if (code.includes(h)) bad.push(`dist/${f}: ${h}`);
}
if (bad.length) {
  console.error(`Test hooks shipped in the library build:\n${bad.join('\n')}`);
  process.exit(1);
}
console.log('check-dist: no test hooks in dist/*.js or dist/*.d.ts');
