#!/usr/bin/env node
const path = require('path');
const { splitComponentFile } = require('./lib/splitComponent');
const { loadConfig } = require('./lib/config');

function printHelp() {
  console.log(`
Component Splitter v3 — AST-based, project-aware React/React Native splitter

Usage:
  node index.js <file> [options]

Options:
  --dry-run               Analyze only, don't write any files
  --max-lines=<n>         Flag components whose JSX body is longer than this (default 150)
  --min-block-lines=<n>   Minimum size of a block to bother extracting (default 12)
  --out=<dir>             Where to write extracted components (default: ./components next to the file)
  --no-styles             Don't extract inline styles at all
  --no-shared-styles       Extract styles per-file instead of into a shared project-wide registry
  --with-tests            Also generate a basic test stub for each extracted component
  --no-recursive          Don't recursively split extracted components that are still too big
  --max-depth=<n>          How many recursive split passes to allow (default 2)
  --no-format              Skip the code-formatting pass
  --no-self-check          Skip the automatic type-check-before-committing safety net
  --no-backup              Don't back up the original file before rewriting it

A project can also set defaults in an "rn-splitter.config.json" file (searched
upward from the target file) using the same option names in camelCase, e.g.:
  { "maxComponentLines": 100, "withTests": true, "sharedStyles": true }

Example:
  node index.js ./src/screens/HomeScreen.tsx --dry-run --with-tests
`);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const filePath = args.find((a) => !a.startsWith('--'));
if (!filePath) {
  console.error('Error: no file path given.\n');
  printHelp();
  process.exit(1);
}

const resolvedPath = path.resolve(filePath);
const fileConfig = loadConfig(path.dirname(resolvedPath));

const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const found = args.find((a) => a.startsWith(`${name}=`));
  return found ? found.split('=')[1] : undefined;
};

const options = {
  ...fileConfig,
  dryRun: flag('--dry-run') || fileConfig.dryRun || false,
  extractStyles: flag('--no-styles') ? false : (fileConfig.extractStyles ?? true),
  sharedStyles: flag('--no-shared-styles') ? false : (fileConfig.sharedStyles ?? true),
  withTests: flag('--with-tests') || fileConfig.withTests || false,
  recursive: flag('--no-recursive') ? false : (fileConfig.recursive ?? true),
  format: flag('--no-format') ? false : (fileConfig.format ?? true),
  selfCheck: flag('--no-self-check') ? false : (fileConfig.selfCheck ?? true),
  backup: flag('--no-backup') ? false : (fileConfig.backup ?? true),
};
if (valueOf('--max-lines')) options.maxComponentLines = parseInt(valueOf('--max-lines'), 10);
if (valueOf('--min-block-lines')) options.minBlockLinesToExtract = parseInt(valueOf('--min-block-lines'), 10);
if (valueOf('--max-depth')) options.maxDepth = parseInt(valueOf('--max-depth'), 10);
if (valueOf('--out')) options.outputDir = path.resolve(valueOf('--out'));

const report = splitComponentFile(resolvedPath, options);
printReport(report, options.dryRun, 0);

function printReport(report, dryRun, depth) {
  const pad = '  '.repeat(depth);
  console.log(`\n${pad}File: ${report.file}`);
  console.log(`${pad}Total lines: ${report.totalLines}`);

  if (report.skippedReason) {
    console.log(`${pad}Skipped: ${report.skippedReason}`);
    return;
  }

  if (report.rolledBack) {
    console.log(`${pad}⚠ Self-check failed — changes were rolled back. Nothing was written.`);
    for (const p of report.selfCheck.problems) {
      console.log(`${pad}  ${p.file} (${p.kind}):`);
      for (const d of p.diagnostics) console.log(`${pad}    ${d}`);
    }
    return;
  }

  console.log(`${pad}Extracted ${report.extracted.length} component(s):`);
  for (const e of report.extracted) {
    const propsStr = e.props.length ? e.props.map((p) => `${p.name}: ${p.type}`).join(', ') : 'none detected';
    console.log(`${pad}  - ${e.name}  (${e.linesExtracted} lines, props: [${propsStr}], local styles: ${e.localStylesExtracted})`);
    console.log(`${pad}      -> ${e.newFile}${dryRun ? '  (dry run, not written)' : ''}`);
    if (e.testFile) console.log(`${pad}      -> ${e.testFile}${dryRun ? '  (dry run, not written)' : ''}`);
  }

  if (report.selfCheck && !report.selfCheck.skipped && !dryRun) {
    console.log(`${pad}Self-check: ${report.selfCheck.ok ? 'passed ✓' : 'FAILED'}`);
  }

  if (dryRun) {
    console.log(`${pad}--- Dry run: no files were written. ---`);
  } else if (report.outputDir) {
    console.log(`${pad}Done. Components written to: ${report.outputDir}`);
  }

  for (const nested of report.nested || []) {
    console.log(`${pad}  -- recursively splitting further --`);
    printReport(nested, dryRun, depth + 1);
  }
}
