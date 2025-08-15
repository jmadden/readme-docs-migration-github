#!/usr/bin/env node
/**
 * Merge all `_log.csv` files under a directory tree into one CSV.
 *
 * Usage:
 *   node merge-logs.mjs --root "/path/to/root" [--out "/path/to/output.csv"]
 *
 * Defaults:
 *   --out          => <root>/_log.all.csv
 *
 * Behavior:
 *   - Recursively scans `--root` for files named `_log.csv`
 *   - Skips each file's header row so the final output has a single header
 *   - Creates the output directory if needed
 *   - Skips hidden folders and `node_modules`
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ---- CLI parsing -----------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (!args.root) {
  console.error(
    'Usage: node merge-logs.mjs --root "/path/to/root" [--out "/path/to/output.csv"]'
  );
  process.exit(1);
}
const ROOT = path.resolve(String(args.root));
const OUT = args.out
  ? path.resolve(String(args.out))
  : path.join(ROOT, '_log.all.csv');

(async () => {
  const header = 'Type,File,Error Message,Removed Code,Missing Images';
  const logPaths = await findFilesRecursive(ROOT, '_log.csv');

  if (!logPaths.length) {
    console.error(`No _log.csv files found under: ${ROOT}`);
    process.exit(2);
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true });

  let combined = header + '\n';
  let mergedCount = 0;
  for (const p of logPaths) {
    try {
      const txt = await fs.readFile(p, 'utf8');
      const lines = txt.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (!lines.length) continue;

      // Skip header row if present
      const startIdx = lines[0].trim().toLowerCase().startsWith('type,file,')
        ? 1
        : 0;
      if (startIdx >= lines.length) continue;

      combined += lines.slice(startIdx).join('\n') + '\n';
      mergedCount++;
    } catch (e) {
      console.warn(`Warn: failed reading ${p}: ${e.message || e}`);
      continue;
    }
  }

  await fs.writeFile(OUT, combined, 'utf8');
  console.log(`Merged ${mergedCount} file(s) into: ${OUT}`);
})().catch(err => {
  console.error(err.stack || String(err));
  process.exit(1);
});

// ---- helpers ---------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

async function findFilesRecursive(root, filename) {
  const out = [];
  async function walk(dir) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        // Skip hidden directories and node_modules
        if (d.name === 'node_modules' || d.name.startsWith('.')) continue;
        await walk(p);
      } else if (d.isFile() && d.name === filename) {
        out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}
