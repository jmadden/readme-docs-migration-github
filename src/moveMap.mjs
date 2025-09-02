import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';

export async function readMoveMapCsv(csvPath, destRoot) {
  let raw = '';
  try {
    raw = await fs.readFile(csvPath, 'utf8');
  } catch (e) {
    console.warn(
      pc.yellow(`Could not read move map at ${csvPath}: ${e?.message || e}`)
    );
    return { map: new Map(), dupes: new Set() };
  }
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return { map: new Map(), dupes: new Set() };

  let startIdx = 0;
  const header = lines[0].trim().toLowerCase();
  if (header.includes('dest') && header.includes('file')) startIdx = 1;

  const map = new Map();
  const seen = new Map();
  for (let i = startIdx; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (!row.length) continue;
    const [destCol, fileCol] = row.length >= 2 ? row : ['', ''];
    const dest = (destCol || '').trim();
    const file = (fileCol || '').trim();
    if (!dest || !file) continue;

    const filename = path.basename(file).toLowerCase();
    const absDestDir = path.isAbsolute(dest) ? dest : path.join(destRoot, dest);
    const normalized = path.resolve(absDestDir);

    map.set(filename, normalized);
    seen.set(filename, (seen.get(filename) || 0) + 1);
  }
  const dupes = new Set([...seen.keys()].filter(k => seen.get(k) > 1));
  return { map, dupes };
}

function parseCsvLine(line) {
  const out = [];
  let cur = '',
    inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}
