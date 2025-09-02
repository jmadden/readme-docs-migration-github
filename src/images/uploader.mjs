import { fetch, FormData, File } from 'undici';

const UPLOAD_CACHE = new Map(); // absLocalPath -> hostedURL

export async function uploadImageToReadme(fileAbsPath, apiKey) {
  if (UPLOAD_CACHE.has(fileAbsPath)) return UPLOAD_CACHE.get(fileAbsPath);

  const buf = await (
    await import('node:fs/promises')
  ).then(m => m.readFile(fileAbsPath));
  const filename = (await import('node:path')).then(m =>
    m.basename(fileAbsPath)
  );
  const name = (await filename).toString();

  const form = new FormData();
  form.append('file', new File([buf], name));

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

export async function uploadImagesForDocSmart(
  originalPaths,
  index,
  apiKey,
  { appendToLog, logPath, relFile }
) {
  const mapping = new Map();
  const uniq = Array.from(new Set(originalPaths.filter(Boolean)));

  for (const orig of uniq) {
    try {
      const { resolveLocalImageSmart } = await import('./indexer.mjs');
      const abs = resolveLocalImageSmart(orig, index);
      if (!abs) {
        await appendToLog(
          logPath,
          'LOCAL_IMAGE_NOT_FOUND',
          relFile,
          '',
          [],
          [orig]
        );
        continue;
      }
      const url = await uploadImageToReadme(abs, apiKey);
      mapping.set(orig, { local: abs, url });
    } catch (e) {
      await appendToLog(
        logPath,
        'REMOTE_IMAGE_UPLOAD_FAILED',
        relFile,
        String(e?.message || e),
        [],
        [orig]
      );
    }
  }

  return mapping;
}
