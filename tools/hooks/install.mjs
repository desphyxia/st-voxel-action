/** Installs the repo's git hooks. Run once per clone: node tools/hooks/install.mjs */
import { copyFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gitHooks = resolve(here, '../../.git/hooks');
if (!existsSync(gitHooks)) {
  console.error('no .git/hooks directory — not a git clone?');
  process.exit(1);
}
const dest = join(gitHooks, 'pre-push');
copyFileSync(join(here, 'pre-push'), dest);
chmodSync(dest, 0o755);
console.log(`installed ${dest}`);
