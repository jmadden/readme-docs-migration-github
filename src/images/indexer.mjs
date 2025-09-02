import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {Object} ImageIndex
 * @property {string} root - The root directory where images live (e.g. `/static`).
 * @property {Map<string,string>} byRelative - Map of relative paths (`/img/foo.png`) → absolute local file paths.
 * @property {Map<string,string[]>} byBasename - Map of basenames (`foo.png`) → list of absolute local file paths.
 */

/**
 * Build an index of images under a root directory (recursively).
 * Useful for resolving image references like `/img/foo.png` back to disk.
 *
 * @param {string} rootDirectory - Absolute path to the root folder containing `img/` and `assets/` directories.
 * @returns {Promise<ImageIndex>} An index object for fast lookups.
 */
export async function buildImageIndex(root, subdirs = ['img', 'assets']) {
  const files = [];

  async function walk(directoryPath) {
    let list;
    try {
      list = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of list) {
      const p = path.join(directoryPath, d.name);
      if (d.isDirectory()) await walk(p);
      else if (d.isFile() && /\.(png|jpe?g|gif|svg|webp|avif)$/i.test(d.name)) files.push(p);
    }
  }

  let any = false;
  for (const sub of subdirs) {
    const p = path.join(root, sub);
    try {
      const st = await fs.stat(p);
      if (st.isDirectory()) {
        any = true;
        await walk(p);
      }
    } catch {}
  }
  if (!any) await walk(root);

  const byRelFromRoot = new Map();
  const byBasename = new Map();
  for (const abs of files) {
    const relFromRoot = path.relative(root, abs).replace(/\\/g, '/').replace(/^\/+/, '');
    byRelFromRoot.set(relFromRoot, abs);
    const base = path.basename(abs);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(abs);
  }
  return { root, files, byRelFromRoot, byBasename };
}

/**
 * Resolve an image path from a document into a local absolute file path.
 * Prefers exact relative matches (`/img/foo.png`), falls back to basename search.
 *
 * @param {string} originalPath - The path as written in the doc (e.g. `/img/foo.png`).
 * @param {ImageIndex} index - The index created by `buildImageIndex()`.
 * @returns {string|null} Absolute path to the local file, or null if not found.
 */
export function resolveLocalImageSmart(originalPath, index) {
  if (!originalPath) return '';
  const relNoLead = String(originalPath).replace(/\\/g, '/').replace(/^\/+/, '');

  const exact = index.byRelFromRoot.get(relNoLead);
  if (exact) return exact;

  const parts = relNoLead.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const sub = parts.slice(i).join('/');
    const match = index.byRelFromRoot.get(sub);
    if (match) return match;
  }

  const base = parts[parts.length - 1];
  const candidates = index.byBasename.get(base) || [];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const scored = candidates.map((abs) => ({
      abs,
      score: longestCommonSuffix(abs.replace(/\\/g, '/'), relNoLead),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored[0].abs;
  }

  return '';
}

function longestCommonSuffix(a, b) {
  let i = a.length - 1,
    j = b.length - 1,
    n = 0;
  while (i >= 0 && j >= 0 && a[i] === b[j]) {
    i--;
    j--;
    n++;
  }
  return n;
}
