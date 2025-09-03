// src/moveMap.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';

/**
 * Read a move-map CSV and return:
 *  - map: filename(lowercased) -> absolute destination directory (string) or null
 *  - dupes: set of filenames(lowercased) that appear more than once in the CSV
 *
 * IMPORTANT:
 *  - We treat the destination column LITERALLY (no slugify, no lowercase, spaces preserved).
 *  - If destination is relative, we join it under `outRootDirectory` to make it absolute.
 */
export async function readMoveMapCsv(csvPath, outRootDirectory) {
  let raw = '';
  try {
    raw = await fs.readFile(csvPath, 'utf8');
  } catch (e) {
    console.warn(pc.yellow(`Could not read move map at ${csvPath}: ${e?.message || e}`));
    return { map: new Map(), dupes: new Set() };
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { map: new Map(), dupes: new Set() };

  // Detect header and column order (accepts file,destination OR destination,file)
  const headerParts = lines[0].split(',').map((s) => s.trim().toLowerCase());
  let hasHeader = false;
  let fileIdx = 0;
  let destIdx = 1;

  if (headerParts.includes('file') || headerParts.includes('destination')) {
    hasHeader = true;
    fileIdx = headerParts.indexOf('file');
    destIdx = headerParts.indexOf('destination');
    // If one is missing, assume the other order
    if (fileIdx === -1 && destIdx !== -1) fileIdx = destIdx === 0 ? 1 : 0;
    if (destIdx === -1 && fileIdx !== -1) destIdx = fileIdx === 0 ? 1 : 0;
  }

  const start = hasHeader ? 1 : 0;
  const map = new Map(); // filename(lowercased) -> absolute destination dir (string) or null
  const seen = new Map(); // filename(lowercased) -> count

  for (let i = start; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (!row.length) continue;

    const fileCol = (row[fileIdx] || '').trim();
    const destColRaw = (row[destIdx] || '').trim();

    if (!fileCol) continue; // require a filename
    const filenameKey = path.basename(fileCol).toLowerCase();

    // Destination can be empty: keep default location (store null)
    let absoluteDestinationDir = null;

    if (destColRaw) {
      // Preserve destination EXACTLY as written: case and spaces intact.
      // Only transform is: make it absolute under outRootDirectory if it's relative.
      // Also normalize redundant segments without changing case.
      const destLiteral = destColRaw.replace(/[/\\]+$/, ''); // drop trailing slashes, but keep spaces/case
      absoluteDestinationDir = path.isAbsolute(destLiteral)
        ? path.normalize(destLiteral)
        : path.normalize(path.join(outRootDirectory, destLiteral));
    }

    map.set(filenameKey, absoluteDestinationDir);
    seen.set(filenameKey, (seen.get(filenameKey) || 0) + 1);
  }

  const dupes = new Set([...seen.keys()].filter((k) => seen.get(k) > 1));
  return { map, dupes };
}

/**
 * Apply the move mapping for a single output file.
 * Returns the FINAL absolute file path where the doc should be written.
 *
 * - defaultDestAbs: the default absolute file path (what you'd use without a move-map)
 * - fileName: just the basename (e.g., "readme.md")
 * - moveMap: Map from readMoveMapCsv()
 * - moveDupes: Set of duplicate filenames (from readMoveMapCsv())
 * - onDuplicate: optional callback for logging
 */
export function applyMoveMapping({ defaultDestAbs, fileName, moveMap, moveDupes, onDuplicate }) {
  // Start with default path
  let finalAbsPath = defaultDestAbs;

  if (!moveMap || !fileName) return finalAbsPath;

  const key = fileName.toLowerCase();

  if (moveDupes && moveDupes.has(key)) {
    // Duplicate filename present in CSV: do NOT move; caller can log it
    if (typeof onDuplicate === 'function') {
      onDuplicate(fileName);
    }
    return finalAbsPath;
  }

  if (moveMap.has(key)) {
    const mappedDir = moveMap.get(key); // absolute directory (string) or null
    if (typeof mappedDir === 'string' && mappedDir.trim()) {
      // Preserve as-is: NO slugify, NO lowercase, spaces/case intact
      finalAbsPath = path.join(mappedDir, fileName);
    }
  }

  return finalAbsPath;
}

/* ---------------- internal: tiny CSV parser ---------------- */

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
