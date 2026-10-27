#!/usr/bin/env node
// Line and function coverage of the public API code (server/src/api/v1) by its test suite, from
// V8's built-in coverage: no instrumentation and no dependencies. The test starts the SAS as a
// child process, which inherits NODE_V8_COVERAGE and writes its coverage when it exits.
//
//   npm run api:coverage                      # run server/test/api-v1.test.ts, print a summary
//   npm run api:coverage -- --uncovered       # also list the uncovered lines and unrun functions
//   npm run api:coverage -- --min 95          # exit non-zero below 95 % line coverage
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCOPE = path.join(ROOT, 'server', 'src', 'api', 'v1') + path.sep;
const args = process.argv.slice(2);
const showUncovered = args.includes('--uncovered');
const min = args.includes('--min') ? Number(args[args.indexOf('--min') + 1]) : null;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sasbench-coverage-'));
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'server/test/api-v1.test.ts'], {
  cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: dir },
});
if (run.status !== 0) {
  console.error(`\nThe test run failed (exit ${run.status}); coverage not computed.`);
  process.exit(run.status ?? 1);
}

/** Per file: a count per source character, merged across processes (covered if any process ran it).
 * V8 offsets count UTF-16 code units, the same as JavaScript string indexes, not bytes. */
const files = new Map();
for (const f of fs.readdirSync(dir)) {
  const { result } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const script of result) {
    if (!script.url.startsWith('file://')) continue;
    const file = fileURLToPath(script.url);
    if (!file.startsWith(SCOPE)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const len = src.length;
    const counts = new Int32Array(len).fill(0);
    // Outer ranges first; nested (block) ranges override the enclosing function's count.
    const ranges = script.functions.flatMap((fn) => fn.ranges).sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
    for (const r of ranges) counts.fill(r.count, r.startOffset, Math.min(r.endOffset, len));
    const prev = files.get(file);
    if (prev) for (let i = 0; i < len; i++) prev.counts[i] = Math.max(prev.counts[i], counts[i]);
    else files.set(file, { src, counts, fns: new Map() });
    const entry = files.get(file);
    for (const fn of script.functions) {
      if (!fn.functionName && fn.ranges[0].startOffset === 0) continue; // the module itself
      const key = fn.ranges[0].startOffset;
      const seen = entry.fns.get(key);
      entry.fns.set(key, { name: fn.functionName, count: Math.max(seen?.count ?? 0, fn.ranges[0].count) });
    }
  }
}
fs.rmSync(dir, { recursive: true, force: true });

// A line is code when it has something other than whitespace, comments and lone brackets.
const isCode = (line) => {
  const t = line.trim();
  return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !/^[\]})>,;]+$/.test(t) && !/^(import|export \{|export type|type |interface )/.test(t);
};

const all = [];
for (const f of fs.readdirSync(SCOPE, { recursive: true })) {
  if (f.endsWith('.ts')) all.push(path.join(SCOPE, f));
}
let totalLines = 0, totalCovered = 0, totalFns = 0, totalFnsCovered = 0;
const rows = [];
for (const file of all.sort()) {
  const e = files.get(file);
  const src = e?.src ?? fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  let offset = 0, code = 0, covered = 0;
  const uncovered = [];
  lines.forEach((line, i) => {
    const chars = line.length + 1;
    if (isCode(line)) {
      code++;
      const first = offset + (line.length - line.trimStart().length);
      if (e && e.counts[first] > 0) covered++;
      else uncovered.push(i + 1);
    }
    offset += chars;
  });
  const fns = e ? [...e.fns.values()].map((f) => f.count) : [];
  // Unrun functions as "line:name"; an inline callback on a line that ran is listed only here.
  const lineAt = (offset) => src.slice(0, offset).split('\n').length;
  const unrunFns = e ? [...e.fns].filter(([, f]) => f.count === 0).map(([off, f]) => `${lineAt(off)}:${f.name || '(anonymous)'}`) : [];
  totalLines += code; totalCovered += covered; totalFns += fns.length; totalFnsCovered += fns.filter((c) => c > 0).length;
  rows.push({ file: path.relative(ROOT, file), code, covered, fns: fns.length, fnsCovered: fns.filter((c) => c > 0).length, uncovered, unrunFns });
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '100.0').padStart(6);
console.log('\nAPI v1 coverage (V8)\n');
console.log(`${'file'.padEnd(48)} ${'lines'.padStart(13)} ${'functions'.padStart(13)}`);
for (const r of rows) {
  console.log(`${r.file.padEnd(48)} ${pct(r.covered, r.code)} % ${String(r.code).padStart(4)}  ${pct(r.fnsCovered, r.fns)} % ${String(r.fns).padStart(4)}`);
  if (showUncovered && r.uncovered.length) {
    const spans = [];
    for (const n of r.uncovered) {
      const last = spans[spans.length - 1];
      if (last && n === last[1] + 1) last[1] = n;
      else spans.push([n, n]);
    }
    console.log(`  uncovered: ${spans.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')}`);
  }
  if (showUncovered && r.unrunFns.length) console.log(`  functions never run: ${r.unrunFns.join(', ')}`);
}
const linePct = (100 * totalCovered) / totalLines;
console.log(`${'total'.padEnd(48)} ${pct(totalCovered, totalLines)} % ${String(totalLines).padStart(4)}  ${pct(totalFnsCovered, totalFns)} % ${String(totalFns).padStart(4)}\n`);
if (min !== null && linePct < min) {
  console.error(`Line coverage ${linePct.toFixed(1)} % is below ${min} %`);
  process.exit(1);
}
