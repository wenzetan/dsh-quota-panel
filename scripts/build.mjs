/**
 * Build: compile src/*.ts into lib/ (tsc, declarations included), then
 * copy the vendored runtime files (schemastery.mjs + cosmokit.js) into
 * lib/vendor/ so the compiled lib/index.js relative import resolves.
 * Declaration files stay in src/ — they are for type-checking only.
 */
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

execSync('tsc -p tsconfig.json', { stdio: 'inherit' });
mkdirSync('lib/vendor', { recursive: true });
for (const file of readdirSync('src/vendor')) {
	if (file.endsWith('.d.mts') || file.endsWith('.d.ts')) continue;
	cpSync(`src/vendor/${file}`, `lib/vendor/${file}`);
}
console.log('build: tsc ok, lib/vendor populated');