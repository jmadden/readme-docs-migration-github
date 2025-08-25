
  await fs.appendFile(logPath, row, 'utf8');
}

/* ---------- lightweight text sweep for image URLs ---------- */

function collectInlineImageUrlsFromText(source) {
  const urls = new Set();
  const mdImg = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^")]+["'])?\)/g;
  for (const m of source.matchAll(mdImg)) if (m[1]) urls.add(m[1].trim());
  const htmlImg = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const m of source.matchAll(htmlImg)) if (m[1]) urls.add(m[1].trim());
  const useBase = /useBaseUrl\(\s*(['"])(.*?)\1\s*\)/g;
  for (const m of source.matchAll(useBase)) if (m[2]) urls.add(m[2].trim());
  // Also collect placeholders from previous runs
  const placeholder = /<!--IMAGE_PLACEHOLDER:([^>]+)-->/g;
  for (const m of source.matchAll(placeholder)) if (m[1]) urls.add(m[1].trim());
  return Array.from(urls);
}

function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/* ---------- Image index & smart resolution ---------- */

async function buildImageIndex(root, subdirs = ['img', 'assets']) {
  const files = [];
  const wanted = new Set(subdirs.map(s => path.join(root, s)));

  async function walk(dir) {
    let list;
    try { list = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(p);
      } else if (d.isFile()) {
        if (/\.(png|jpe?g|gif|svg|webp|avif)$/i.test(d.name)) {
          files.push(p);
        }
      }
    }
  }

  let any = false;
  for (const sub of subdirs) {
    const p = path.join(root, sub);
    try {
      const st = await fs.stat(p);
      if (st.isDirectory()) { any = true; await walk(p); }
    } catch {}
  }
  if (!any) await walk(root);

  const byRelFromRoot = new Map();
  const byBasename = new Map();
  for (const abs of files) {
    const relFromRoot = path.relative(root, abs);
    byRelFromRoot.set(normalizeSlashes(relFromRoot), abs);

    const base = path.basename(abs);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(abs);
  }

  return { root, files, byRelFromRoot, byBasename };
}

function normalizeSlashes(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Try to find the best local file for an original doc path.
 * 1) Exact relative match from images root (e.g. "/img/x.png" -> "img/x.png")
 * 2) Suffix match on path segments
 * 3) Fallback: basename match (choose the one with longest common suffix)
 */
function resolveLocalImageSmart(originalPath, index) {
  if (!originalPath) return '';
  const orig = normalizeSlashes(originalPath);
  const relNoLead = orig.replace(/^\/+/, ''); // "/img/x.png" -> "img/x.png"

  const exact = index.byRelFromRoot.get(relNoLead);
  if (exact) return exact;

  const parts = relNoLead.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const sub = parts.slice(i).join('/');
    const match = index.byRelFromRoot.get(sub);
    if (match) return match;
  }

  const base = path.basename(relNoLead);
  const candidates = index.byBasename.get(base) || [];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const scored = candidates.map(abs => ({
      abs,
      score: longestCommonSuffix(normalizeSlashes(abs), relNoLead)
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored[0].abs;
  }

  return '';
}

function longestCommonSuffix(a, b) {
  let i = a.length - 1, j = b.length - 1, n = 0;
  while (i >= 0 && j >= 0 && a[i] === b[j]) { i--; j--; n++; }
  return n;
}

/* ---------- ReadMe Images API + per-doc upload ---------- */

async function uploadImageToReadme(fileAbsPath, apiKey) {
  if (UPLOAD_CACHE.has(fileAbsPath)) return UPLOAD_CACHE.get(fileAbsPath);

  const buf = await fs.readFile(fileAbsPath);
  const filename = path.basename(fileAbsPath);
  const form = new FormData();
  form.append('file', new File([buf], filename));

  const res = await fetch('https://api.readme.com/v2/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upload failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  const url = json?.data?.url || '';
  if (!url) throw new Error('Upload succeeded but no URL returned.');
  UPLOAD_CACHE.set(fileAbsPath, url);
  return url;
}

/**
 * For the given doc's original image paths, resolve locally (smart), upload, and return:
 * Map(originalDocPath -> { local: absLocalPath, url: hostedURL })
 */
async function uploadImagesForDocSmart(originalPaths, index, apiKey, logPath, relFileForLog) {
  const mapping = new Map();
  const uniq = Array.from(new Set(originalPaths.filter(Boolean)));

  for (const orig of uniq) {
    try {
      const abs = resolveLocalImageSmart(orig, index);
      if (!abs) {
        await appendToLog(logPath, 'LOCAL_IMAGE_NOT_FOUND', relFileForLog, '', [], [orig]);
        continue;
      }
      const url = await uploadImageToReadme(abs, apiKey);
      mapping.set(orig, { local: abs, url });
    } catch (e) {
      await appendToLog(
        logPath,
        'REMOTE_IMAGE_UPLOAD_FAILED',
        relFileForLog,
        String(e?.message || e),
        [],
        [orig]
      );
    }
  }

  return mapping;
}

/* ---------- Images manifest CSV ---------- */

async function initImagesManifest(csvPath) {
  const header = `File,Original Path,Local Path,Uploaded URL\n`;
  await fs.writeFile(csvPath, header, 'utf8').catch(() => {});
}

async function appendImagesManifest(csvPath, row) {
  const safe = (v) => {
    if (v == null) return '';
    let s = String(v).replace(/"/g, '""');
    if (/[",\n]/.test(s)) s = `"${s}"`;
    return s;
  };
  const line = `${safe(row.file)},${safe(row.original)},${safe(row.local)},${safe(row.url)}\n`;
  await fs.appendFile(csvPath, line, 'utf8');
}

/* ---------- Rewriting placeholders and image occurrences ---------- */

function rewriteAllImageOccurrences(md, mapping) {
  let out = md;

  for (const [orig, url] of mapping) {
    if (!orig || !url) continue;

    // 0) Replace IMAGE_PLACEHOLDER comments with <img>
    const placeholderRe = new RegExp(`<!--IMAGE_PLACEHOLDER:${escapeRegex(orig)}-->`, 'g');
    out = out.replace(placeholderRe, `<img src="${url}" alt="" />`);

    // 1) Replace any "**MISSING IMAGE!** path" (legacy) with <img>
    const missingRe = new RegExp(`\\*\\*MISSING IMAGE!\\*\\*\\s+${escapeRegex(orig)}`, 'g');
    out = out.replace(missingRe, `<img src="${url}" alt="" />`);

    // 2) Markdown image syntax: ![alt](orig)
    const mdImgRe = new RegExp(`(!\\[[^\\]]*\\]\\()${escapeRegex(orig)}(\\))`, 'g');
    out = out.replace(mdImgRe, `$1${url}$2`);

    // 3) HTML <img src="orig" ...>
    const htmlImgRe = new RegExp(`(<img\\b[^>]*\\bsrc=)(["'])${escapeRegex(orig)}\\2`, 'g');
    out = out.replace(htmlImgRe, `$1"${url}"`);

    // 4) useBaseUrl("orig") occurrences
    const useBaseRe = new RegExp(`useBaseUrl\\(\\s*(['"])${escapeRegex(orig)}\\1\\s*\\)`, 'g');
    out = out.replace(useBaseRe, `"${url}"`);
  }

  return out;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export {};
