#!/usr/bin/env node
/**
 * Fails when a production build contains sample data (ARCHITECTURE.md rule 1: the fictional data of
 * src/sample is a dev and test tool and never ships). Run after `npm run build`:
 *
 *   npm run check:dist                        # checks dist/
 *   node scripts/check-dist.mjs out           # checks another build folder
 *   node scripts/check-dist.mjs --verbose     # also lists the strings it looks for
 *
 * Two checks, both derived from src/sample at run time so they follow the sample data as it changes:
 * - no file is a chunk named after a src/sample module (e.g. `sampleSource-<hash>.js`);
 * - no built file contains a distinctive string of src/sample: its fictional file names and project
 *   names. Strings that also occur in other source files (which may legitimately be bundled) are
 *   left out, so the check has no false alarms from shared words.
 * Exit codes: 0 clean, 1 sample data found, 2 the check could not run.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const SAMPLE = join(SRC, 'sample');
const DIN_ASSETS = resolve(ROOT, '..', 'assets', 'din4023_patterns');
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const DIST = resolve(args.find((a) => !a.startsWith('--')) ?? join(ROOT, 'dist'));

/** Built files that are text and could carry a string (fonts and images are skipped). */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.svg', '.map', '.txt', '.webmanifest', '.xml']);
/** Source files whose strings may legitimately reach the bundle. */
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.json', '.svg', '.html']);
/** A fictional document file name, e.g. "example_report_2019.pdf". */
const FILE_NAME = /^[A-Za-z0-9][\w .()-]*\.(pdf|docx?|xlsx?|csv|tiff?|png|jpe?g)$/i;
/** A project name: the value of a `project` / `name` property or a `…PROJECT…` constant. */
const PROJECT_NAME = /\b(?:project|name|[A-Z][A-Z_]*PROJECT[A-Z_]*)\s*[:=]\s*(['"])([^'"\\\r\n]+)\1/g;
/** Single- or double-quoted string literals, and template literals without placeholders. */
const STRING_LITERAL = /(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1|`([^`$\\]*)`/g;
const MIN_NEEDLE_LENGTH = 8;

function fail(code, message) {
  console.error(`check:dist: ${message}`);
  process.exit(code);
}

/** Every file below a folder (absolute paths). */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
const moduleName = (path) => basename(path, extname(path));
/** Printable ASCII only: minifiers may escape other characters, which would hide a match. */
const isPlainAscii = (s) => /^[\x20-\x7e]+$/.test(s);

if (!existsSync(SAMPLE)) fail(2, `no sample folder at ${relative(ROOT, SAMPLE)}; nothing to check against`);
if (!existsSync(DIST) || !statSync(DIST).isDirectory()) fail(2, `no build at ${DIST}; run the build first`);

const sampleFiles = walk(SAMPLE).filter((p) => SOURCE_EXT.has(extname(p)) && !isTest(p));
const otherSources = [
  ...walk(SRC).filter((p) => !p.startsWith(SAMPLE + sep) && SOURCE_EXT.has(extname(p)) && !isTest(p)),
  ...(existsSync(DIN_ASSETS) ? walk(DIN_ASSETS).filter((p) => SOURCE_EXT.has(extname(p))) : []),
  join(ROOT, 'index.html'),
].filter((p) => existsSync(p));
/** Source text without comments (a doc comment may quote a sample name; minified code has none). */
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const otherText = otherSources.map((p) => withoutComments(readFileSync(p, 'utf8'))).join('\n');
const otherModules = new Set(otherSources.map(moduleName));

// Distinctive strings of the sample data.
const candidates = new Set();
for (const file of sampleFiles) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(STRING_LITERAL)) {
    const s = (m[2] ?? m[3] ?? '').trim();
    if (FILE_NAME.test(s)) candidates.add(s);
  }
  for (const m of text.matchAll(PROJECT_NAME)) candidates.add(m[2].trim());
}
const needles = [...candidates]
  .filter((s) => s.length >= MIN_NEEDLE_LENGTH && isPlainAscii(s) && !otherText.includes(s))
  .sort();
if (needles.length < 3) {
  fail(2, `found only ${needles.length} distinctive sample strings in ${relative(ROOT, SAMPLE)}; the check would prove nothing`);
}

// Chunks named after a sample module, unless another source module has the same name.
const sampleModules = [...new Set(sampleFiles.map(moduleName))].filter((m) => !otherModules.has(m));
const chunkPattern = new RegExp(`^(${sampleModules.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([-.][\\w-]+)?\\.[cm]?js$`);
if (VERBOSE) {
  console.log(`check:dist: sample strings: ${needles.map((n) => JSON.stringify(n)).join(', ')}`);
  console.log(`check:dist: sample chunk names: ${sampleModules.join(', ')}`);
}

const built = walk(DIST);
const problems = [];
for (const file of built) {
  const rel = relative(DIST, file).split('\\').join('/');
  if (sampleModules.length && chunkPattern.test(basename(file))) problems.push(`${rel}: chunk named after a src/sample module`);
  if (!TEXT_EXT.has(extname(file).toLowerCase())) continue;
  const text = readFileSync(file, 'utf8');
  for (const needle of needles) {
    if (text.includes(needle)) problems.push(`${rel}: contains sample string "${needle}"`);
  }
}

if (problems.length) {
  console.error(`check:dist: sample data found in ${relative(process.cwd(), DIST) || DIST}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `check:dist: ok, ${built.length} files in ${relative(process.cwd(), DIST) || DIST} hold no sample data ` +
    `(${needles.length} sample strings, chunk names ${sampleModules.join(', ')})`,
);
