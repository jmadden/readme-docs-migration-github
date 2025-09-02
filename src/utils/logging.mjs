import fs from 'node:fs/promises';
import path from 'node:path';

export async function initLogs({
  destRoot,
  cwd,
  srcRoot,
  destRootAbs,
  copyRootAbs,
}) {
  const LOG_PATH = path.join(destRoot, '_log.csv');
  const REPORT_PATH = path.join(destRoot, 'migration-report.json');
  const IMAGES_CSV_PATH = path.join(destRoot, '_images.csv');

  await fs.mkdir(destRoot, { recursive: true });
  await fs
    .writeFile(
      LOG_PATH,
      `Type,File,Error Message,Removed Code,Missing Images\n`,
      'utf8'
    )
    .catch(() => {});
  await fs
    .writeFile(
      IMAGES_CSV_PATH,
      `File,Original Path,Local Path,Uploaded URL\n`,
      'utf8'
    )
    .catch(() => {});

  const report = {
    startedAt: new Date().toISOString(),
    cwd,
    srcRoot,
    destRoot: destRootAbs,
    copyRoot: copyRootAbs || null,
    files: [],
  };

  return { LOG_PATH, REPORT_PATH, IMAGES_CSV_PATH, report };
}

export async function finalizeReport(reportPath, report) {
  report.completedAt = new Date().toISOString();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

export async function appendToLog(
  logPath,
  type,
  file,
  errorMsg,
  removedCodeArr,
  missingImagesArr
) {
  const safe = val => {
    if (val == null) return '';
    let s = String(val).replace(/"/g, '""');
    if (/[",\n]/.test(s)) s = `"${s}"`;
    return s;
  };
  const filteredRemoved = (Array.isArray(removedCodeArr) ? removedCodeArr : [])
    .filter(snippet => {
      if (!snippet) return false;
      const s = String(snippet).trim();
      if (/^\s*import\s.+/m.test(s)) return true;
      if (/^SCRIPT (SRC|INLINE CODE)/.test(s) || /^INLINE HANDLERS/.test(s))
        return true;
      if (/^INLINE HANDLER removed/.test(s)) return true;
      if (/^<\s*[A-Z][A-Za-z0-9]*/.test(s)) return true;
      return false;
    })
    .join('\n---\n');

  const imgs = Array.isArray(missingImagesArr)
    ? missingImagesArr.join('\n')
    : '';
  const row = `${safe(type)},${safe(file)},${safe(errorMsg)},${safe(
    filteredRemoved
  )},${safe(imgs)}\n`;
  await fs.appendFile(logPath, row, 'utf8');
}

export async function appendImagesManifest(
  csvPath,
  { file, original, local, url }
) {
  const safe = v => {
    if (v == null) return '';
    let s = String(v).replace(/"/g, '""');
    if (/[",\n]/.test(s)) s = `"${s}"`;
    return s;
  };
  const line = `${safe(file)},${safe(original)},${safe(local)},${safe(url)}\n`;
  await fs.appendFile(csvPath, line, 'utf8');
}
