#!/usr/bin/env node
/**
 * Recursively convert Docusaurus-style NOTE blocks:
 *
 *   :::note
 *   ...content...
 *   :::
 *
 * into ReadMe-style MDX Callouts:
 *
 *   <Callout icon="📘" theme="info">
 *     **NOTE**
 *
 *     ...content...
 *   </Callout>
 *
 * Usage:
 *   node convert-notes-to-callouts.mjs --cwd "/path/to/start" [--dry-run] [--backup]
 *
 * Flags:
 *   --cwd      Root directory to start scanning (required).
 *   --dry-run  Show what would change but do not write files.
 *   --backup   Write a .bak copy of each file before modifying.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.cwd) {
  console.error('Error: --cwd is required (root directory to scan).');
  process.exit(1);
}
const ROOT = path.resolve(String(args.cwd));
const DRY = !!args['dry-run'];
const BACKUP = !!args.backup;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.next',
  'dist',
  'build',
]);

const NOTE_BLOCK_RE = /^:::note[^\n]*\n([\s\S]*?)\n:::\s*$/gim;

(async () => {
  const files = await findMarkdownFiles(ROOT);
  if (!files.length) {
    console.log('No .md files found.');
    return;
  }

  let changedFiles = 0;
  let totalReplacements = 0;

  for (const file of files) {
    const original = await fs.readFile(file, 'utf8');
    const { replaced, count } = transformNotes(original);

    if (count > 0) {
      totalReplacements += count;
      changedFiles += 1;

      if (DRY) {
        console.log(`[DRY] ${file} — ${count} replacement(s)`);
      } else {
        if (BACKUP) {
          await fs.writeFile(file + '.bak', original, 'utf8');
        }
        await fs.writeFile(file, replaced, 'utf8');
        console.log(`${file} — ${count} replacement(s)`);
      }
    }
  }

  if (changedFiles === 0) {
    console.log('No NOTE blocks found.');
  } else {
    console.log(
      `\nDone. Files changed: ${changedFiles}, total NOTE blocks replaced: ${totalReplacements}${
        DRY ? ' (dry run)' : ''
      }.`
    );
  }
})().catch(err => {
  console.error(err.stack || String(err));
  process.exit(1);
});

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

async function findMarkdownFiles(root) {
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
        if (SKIP_DIRS.has(d.name) || d.name.startsWith('.')) continue;
        await walk(p);
      } else if (d.isFile()) {
        if (p.toLowerCase().endsWith('.md')) out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Replace NOTE blocks with Callout components, preserving inner content.
 * We indent the inner content by two spaces so it nests nicely inside <Callout>.
 */
function transformNotes(text) {
  let count = 0;
  const replaced = text.replace(NOTE_BLOCK_RE, (_, inner) => {
    count++;
    const body = indentBlock(inner.trim(), '  ');
    return [
      `<Callout icon="📘" theme="info">`,
      `  **NOTE**`,
      ``,
      body,
      `</Callout>`,
    ].join('\n');
  });
  return { replaced, count };
}

function indentBlock(s, pad = '  ') {
  return s
    .split(/\r?\n/)
    .map(line => (line.length ? pad + line : ''))
    .join('\n');
}
