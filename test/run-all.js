'use strict';

/*
 * Test runner: compiles the orderbook server sources into test/.build (outside
 * the main build output) and runs every scenario file in its own process.
 *
 * The compile emits even when type errors exist (noEmitOnError is off in
 * test/tsconfig.json), but any error other than the known pre-existing TBILL
 * errors in src/services/markets/manager.class.ts fails the run.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(__dirname, '.build');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const KNOWN_ERROR = /src\/services\/markets\/manager\.class\.ts\(\d+,\d+\): error TS2304: Cannot find name 'TBILL'\./;

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
    console.error(`tests need Node >= 22 (global WebSocket); running ${process.version}`);
    process.exit(1);
}

console.log('== build: tsc -p test/tsconfig.json ==');
fs.rmSync(BUILD_DIR, { recursive: true, force: true });
const build = spawnSync(process.execPath, [TSC, '-p', path.join(__dirname, 'tsconfig.json')], { encoding: 'utf8', cwd: ROOT });
const errorLines = (build.stdout + build.stderr).split('\n').filter((l) => l.includes('error TS'));
const unexpected = errorLines.filter((l) => !KNOWN_ERROR.test(l.trim()));
if (unexpected.length) {
    console.error('UNEXPECTED COMPILE ERRORS:');
    unexpected.forEach((l) => console.error('  ' + l.trim()));
    process.exit(1);
}
console.log(`compile OK — ${errorLines.length} known pre-existing TBILL error(s), 0 new`);
if (!fs.existsSync(path.join(BUILD_DIR, 'services', 'socket', 'manager.class.js'))) {
    console.error('build output missing');
    process.exit(1);
}

const tests = fs.readdirSync(__dirname)
    .filter((f) => /^\d\d-.*\.test\.js$/.test(f))
    .sort();

let failed = 0;
const results = [];
for (const t of tests) {
    console.log(`\n== ${t} ==`);
    const res = spawnSync(process.execPath, [path.join(__dirname, t)], {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 90000,
        env: { ...process.env },
    });
    process.stdout.write(res.stdout || '');
    process.stderr.write(res.stderr || '');
    const ok = res.status === 0;
    if (!ok) failed++;
    results.push({ t, ok, status: res.status, signal: res.signal });
}

console.log('\n== SUMMARY ==');
results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.t}${r.ok ? '' : ` (exit ${r.status}${r.signal ? ' ' + r.signal : ''})`}`));
console.log(failed === 0 ? `\nALL ${results.length} SCENARIOS PASS` : `\n${failed}/${results.length} SCENARIOS FAILED`);
process.exit(failed === 0 ? 0 : 1);
