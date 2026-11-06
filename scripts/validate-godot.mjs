#!/usr/bin/env node
/**
 * Validate the generated GDScript with a real Godot 4 executable.
 *
 *   GODOT_BIN=/path/to/godot npm run test:godot
 *
 * 1. Compiles every example graph (via the golden-file test with GODOT_OUT set) into a temporary
 *    Godot project.
 * 2. Runs `godot --headless --path <project> --check-only --script res://<file>.gd` on each file
 *    and fails on any parse/compile error.
 *
 * Without GODOT_BIN this exits with status 2 and says so — it never pretends validation happened.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const godot = process.env.GODOT_BIN;
if (!godot) {
  console.error('GODOT_BIN is not set: no Godot executable to validate against. Nothing was validated.');
  process.exit(2);
}
const version = spawnSync(godot, ['--headless', '--version'], { encoding: 'utf8' });
if (version.status !== 0 || !/^4\./.test(version.stdout.trim())) {
  console.error(`GODOT_BIN does not look like Godot 4 (got: ${version.stdout || version.stderr})`);
  process.exit(2);
}
console.log(`Godot ${version.stdout.trim()}`);

const dir = mkdtempSync(join(tmpdir(), 'cs-godot-'));
writeFileSync(join(dir, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Coding Studio validation"\n');
execFileSync('npx', ['vitest', 'run', 'tests/compiler/examples.test.ts'], { stdio: 'inherit', env: { ...process.env, GODOT_OUT: dir } });

const files = readdirSync(dir).filter((f) => f.endsWith('.gd'));
let failed = 0;
for (const f of files) {
  const r = spawnSync(godot, ['--headless', '--path', dir, '--check-only', '--script', `res://${f}`], { encoding: 'utf8', timeout: 60_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const bad = r.status !== 0 || /SCRIPT ERROR|Parse Error|Compile Error/i.test(out);
  console.log(`${bad ? 'FAIL' : 'ok  '} ${f}`);
  if (bad) {
    failed++;
    console.log(out.trim().split('\n').map((l) => `      ${l}`).join('\n'));
  }
}
console.log(`\n${files.length - failed}/${files.length} generated scripts passed Godot's checker.`);
process.exit(failed ? 1 : 0);
