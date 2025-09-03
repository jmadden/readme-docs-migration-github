// src/images/uploader.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetch, FormData, File } from 'undici';

/**
 * Simple in-memory cache so we don't re-upload the same local file.
 * Key: absolute local file path
 * Val: hosted URL returned by ReadMe
 */
const UPLOAD_CACHE = new Map();

/**
 * Upload a single image file to ReadMe v2 Images API.
 * Uses Bearer auth and multipart/form-data with field "file".
 *
 * @param {string} absolutePath - Absolute local path to image
 * @param {string} apiKey - ReadMe API key (Bearer)
 * @returns {Promise<string>} hosted image URL
 */
export async function uploadImageToReadme(absolutePath, apiKey) {
  if (!absolutePath) throw new Error('uploadImageToReadme: absolutePath is required.');
  if (!apiKey) throw new Error('uploadImageToReadme: README API key is missing.');

  // Cache hit?
  const cached = UPLOAD_CACHE.get(absolutePath);
  if (cached) return cached;

  const buffer = await fs.readFile(absolutePath);
  const form = new FormData();
  form.append('file', new File([buffer], path.basename(absolutePath)));

  const res = await fetch('https://api.readme.com/v2/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upload failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`);
  }

  const json = await res.json().catch(() => ({}));
  const url = json?.data?.url || json?.url;
  if (!url) throw new Error('Upload succeeded but no URL was returned by ReadMe.');
  UPLOAD_CACHE.set(absolutePath, url);
  return url;
}

/**
 * Resolve a set of original doc image paths (e.g., "/img/foo.png") to local files,
 * upload them if found, and return a mapping origPath -> { local, url }.
 * Logs missing locals or remote upload failures.
 *
 * @param {string[]} originalPaths - Paths as referenced in docs ("/img/...", "/assets/...", etc.)
 * @param {import('./indexer.mjs').ImageIndex} imageIndex - Built by buildImageIndex(root)
 * @param {string} apiKey - ReadMe API key
 * @param {Object} opts
 * @param {Function} opts.appendToLog - (logPath, type, file, errorMsg, removedCodeArr, missingImagesArr) => Promise<void>
 * @param {string} opts.logPath - Absolute path to _log.csv
 * @param {string} opts.relFile - Current doc's relative path (for logging context)
 * @returns {Promise<Map<string, {local: string, url: string}>>}
 */
export async function uploadImagesForDocSmart(originalPaths, imageIndex, apiKey, opts = {}) {
  const { appendToLog, logPath, relFile } = opts;
  const results = new Map();
  const unique = Array.from(new Set((originalPaths || []).filter(Boolean)));

  // Lazy import to avoid circular deps on some setups
  const { resolveLocalImageSmart } = await import('./indexer.mjs');

  for (const orig of unique) {
    try {
      const localAbs = resolveLocalImageSmart(orig, imageIndex);

      if (!localAbs) {
        if (appendToLog) {
          await appendToLog(logPath, 'LOCAL_IMAGE_NOT_FOUND', relFile || '', '', [], [orig]);
        }
        continue;
      }

      const hostedUrl = await uploadImageToReadme(localAbs, apiKey);
      results.set(orig, { local: localAbs, url: hostedUrl });

      // Optional: log success for auditing (comment out if too chatty)
      // if (appendToLog) {
      //   await appendToLog(logPath, 'IMAGE_UPLOADED', relFile || '', '', [], [`${orig} => ${hostedUrl}`]);
      // }
    } catch (err) {
      if (appendToLog) {
        await appendToLog(
          logPath,
          'REMOTE_IMAGE_UPLOAD_FAILED',
          relFile || '',
          String(err && (err.message || err)),
          [],
          [orig],
        );
      }
    }
  }

  return results;
}

/**
 * Expose cache operations for testing or multi-run orchestration.
 */
export function _clearUploadCache() {
  UPLOAD_CACHE.clear();
}
export function _getUploadCacheSnapshot() {
  return new Map(UPLOAD_CACHE);
}
