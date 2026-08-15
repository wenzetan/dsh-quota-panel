/**
 * CI gate wrapper around @deepseek-ai/dsh-plugin-check (omdsh-dev).
 *
 * Runs the checker's programmatic checkRepo() against this repository
 * and prints the full JSON report. Any ERROR or WARNING fails the gate
 * (strict-ish: the repo follows the org TypeScript tool-bundle template —
 * src/*.ts sources, tsconfig compiling into lib/, build/prepack scripts —
 * so every finding is a real defect, nothing is waived).
 *
 * Usage:
 *   PLUGIN_CHECK_DEPS=<dir with node_modules/@deepseek-ai/dsh-plugin-check> \
 *     node scripts/plugin-check.mjs [repoDir]
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoDir = process.argv[2] ?? process.cwd();
const depsRoot = process.env.PLUGIN_CHECK_DEPS ?? repoDir;
const entry = join(depsRoot, 'node_modules', '@deepseek-ai', 'dsh-plugin-check', 'lib', 'index.js');

const { checkRepo } = await import(pathToFileURL(entry).href);
const report = await checkRepo(repoDir, false);

console.log(JSON.stringify(report, null, 2));

const errors = report.errors ?? [];
const warnings = report.warnings ?? [];

if (errors.length > 0) {
	console.error(`plugin-check: FAIL — ${errors.length} error(s):`);
	for (const e of errors) console.error(`  - [${e.code}] ${e.detail}`);
}
if (warnings.length > 0) {
	console.error(`plugin-check: FAIL — ${warnings.length} warning(s):`);
	for (const w of warnings) console.error(`  - [${w.code}] ${w.detail}`);
}
if (errors.length > 0 || warnings.length > 0) process.exit(1);
console.log(`plugin-check: PASS (verdict=${report.verdict}, checks=${report.checks.passed}/${report.checks.total} passed)`);
