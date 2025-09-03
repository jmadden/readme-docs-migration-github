// src/utils/logging.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Normalize a path-like input to a string path.
 * Accepts plain strings or objects like { path: '...' } (defensive).
 */
function normalizePath(p) {
  if (typeof p === 'string') return p;
  if (p && typeof p.path === 'string') return p.path;
  return String(p ?? '');
}

/**
 * Initialize the CSV log by writing the header row.
 * @param {string} logPathLike - Absolute path (or path-like) to _log.csv
 * @returns {Promise<string>} The normalized log path
 */
export async function initLogs(logPathLike) {
  const logPath = normalizePath(logPathLike);
  if (!logPath) throw new TypeError('initLogs: logPath is empty');
  await writeLogHeader(logPath);
  return logPath;
}

/**
 * Write the CSV header row for the migration log.
 * Columns:
 *  - Type
 *  - File
 *  - Error Message
 *  - Removed Code
 *  - Missing Images
 * This overwrites any existing file at logPath.
 * @param {string} logPathLike
 */
export async function writeLogHeader(logPathLike) {
  const logPath = normalizePath(logPathLike);
  if (!logPath) throw new TypeError('writeLogHeader: logPath is empty');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const header = `Type,File,Error Message,Removed Code,Missing Images\n`;
  await fs.writeFile(logPath, header, 'utf8');
}

/**
 * Append one row to the migration CSV log.
 *
 * @param {string} logPathLike - Absolute path (or path-like) to _log.csv
 * @param {string} type - Category (e.g., FAILED, REMOVED_JS, IMAGES, MOVE_DUPLICATE)
 * @param {string} file - Source-relative file path being processed
 * @param {string} errorMsg - Human-readable message
 * @param {string[]} removedCodeArr - Snippets of removed code (we filter to interesting bits)
 * @param {string[]} missingImagesArr - Image paths/URLs associated with this row
 */
export async function appendToLog(
  logPathLike,
  type,
  file,
  errorMsg,
  removedCodeArr = [],
  missingImagesArr = [],
) {
  const logPath = normalizePath(logPathLike);
  if (!logPath) throw new TypeError('appendToLog: logPath is empty');

  const safe = (val) => {
    if (val == null) return '';
    let s = String(val).replace(/"/g, '""'); // CSV-escape quotes
    if (/[",\n]/.test(s)) s = `"${s}"`;
    return s;
  };

  // Only keep “interesting” removed code: imports, scripts, inline handlers, MDX-ish components
  const filteredRemoved = (Array.isArray(removedCodeArr) ? removedCodeArr : [])
    .filter((snippet) => {
      if (!snippet) return false;
      const s = String(snippet).trim();

      // import lines
      if (/^\s*import\s.+/m.test(s)) return true;

      // <script> removals
      if (/^SCRIPT (SRC|INLINE CODE)/.test(s)) return true;

      // inline DOM/JSX handlers note
      if (/^INLINE HANDLER removed/.test(s)) return true;

      // MDX component-ish (starts with capitalized tag)
      if (/^<\s*[A-Z][A-Za-z0-9]*/.test(s)) return true;

      return false;
    })
    .join('\n---\n');

  const imgs = Array.isArray(missingImagesArr) ? missingImagesArr.filter(Boolean).join('\n') : '';

  const row = `${safe(type)},${safe(file)},${safe(errorMsg)},${safe(filteredRemoved)},${safe(
    imgs,
  )}\n`;

  await fs.appendFile(logPath, row, 'utf8');
}

/**
 * Write the migration report JSON under the destination root.
 * @param {string} destRoot - Destination root directory
 * @param {object} reportObj - Report object to serialize
 * @returns {Promise<string>} Full path to the written report file
 */
export async function finalizeReport(destRoot, reportObj) {
  if (!destRoot) throw new TypeError('finalizeReport: destRoot is empty');
  const reportPath = path.join(destRoot, 'migration-report.json');
  await fs.writeFile(reportPath, JSON.stringify(reportObj, null, 2), 'utf8');
  return reportPath;
}
