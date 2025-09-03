// src/pipeline.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import pc from 'picocolors';

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkFrontmatter from 'remark-frontmatter';
import remarkStringify from 'remark-stringify';
import matter from 'gray-matter';
import { visit } from 'unist-util-visit';

import {
  findMarkdownFilesRecursive,
  ensureIndexesForCreatedDirs,
  updateAllOrderYamlIfPresent,
} from './utils/fileops.mjs';

import { transformDocusaurusTabsToTarget } from './transform/tabs.mjs';
import { convertNoteTipBlocks } from './transform/callouts.mjs';

import {
  remarkCollectMarkdownImages,
  remarkReplaceImageZoom,
  mdFixBangAndHtmlComments,
  remarkStripScriptsAndHandlers,
  remarkConvertSelectedHtmlToMd,
} from './transform/mdastPlugins.mjs';

import { writeLogHeader, appendToLog } from './utils/logging.mjs';

import { buildImageIndex } from './images/indexer.mjs';

import { readMoveMapCsv } from './moveMap.mjs';

/* ========================================================================== */
/*                              PUBLIC ENTRYPOINT                              */
/* ========================================================================== */

/**
 * Run the migration pipeline.
 *
 * @param {Object} options
 * @param {string} options.cwd
 * @param {string} options.srcRoot
 * @param {string} options.destRoot
 * @param {boolean} [options.includeMdx=false]
 * @param {string|null} [options.copyRoot=null]
 * @param {string|null} [options.imagesSrc=null]
 * @param {boolean} [options.uploadImages=false]
 * @param {string|null} [options.readmeApiKey=null]
 * @param {string|null} [options.moveMapCsv=null] - CSV: file,destination (destination is a directory path)
 */
export async function runPipeline(options) {
  const {
    cwd,
    srcRoot,
    destRoot,
    includeMdx = false,
    copyRoot = null,
    imagesSrc = null,
    uploadImages = false,
    readmeApiKey = null,
    moveMapCsv = null,
  } = options;

  await fs.mkdir(destRoot, { recursive: true });
  if (copyRoot) await fs.mkdir(copyRoot, { recursive: true });

  const logPath = path.join(destRoot, '_log.csv');
  await writeLogHeader(logPath);
  const imagesMapPath = path.join(destRoot, 'images-map.csv');
  await ensureImagesMapHeader(imagesMapPath);

  const report = {
    startedAt: new Date().toISOString(),
    cwd,
    srcRoot,
    destRoot,
    copyRoot,
    imagesSrc,
    uploadImages,
    moveMapCsv,
    files: [],
  };

  // Read move-map once (no slugify; literal folder names)
  let moveMap = null;
  let moveDupes = null;
  if (moveMapCsv) {
    const { map, dupes } = await readMoveMapCsv(moveMapCsv, destRoot);
    moveMap = map;
    moveDupes = dupes;
    console.log(
      pc.gray(`Move-map loaded: ${map.size} entries, ${dupes.size} duplicate filename(s).`),
    );
  }

  const discovered = await findMarkdownFilesRecursive(srcRoot, { includeMdx });
  if (!discovered.length) {
    console.log(pc.yellow('No Markdown files found.'));
    return report;
  }
  console.log(pc.gray(`Found ${discovered.length} file(s).`));

  let imageIndex = null;
  if (imagesSrc) {
    imageIndex = await buildImageIndex(imagesSrc);
    console.log(pc.gray(`Image index built under ${imagesSrc}`));
  } else if (uploadImages) {
    console.log(
      pc.yellow(
        'Warning: --upload-images enabled but --images-src not provided; uploads may fail.',
      ),
    );
  }

  let failures = 0;

  for (const absoluteSourcePath of discovered) {
    const relativeFromSrc = path.relative(srcRoot, absoluteSourcePath);

    // Default output behavior for *unmapped* files:
    // - If flatOutput = true  → put just the file in destRoot (flat)
    // - If flatOutput = false → mirror source subfolders under destRoot (mirrored)
    const defaultRelative = (
      options.flatOutput ? path.basename(relativeFromSrc) : relativeFromSrc
    ).replace(/\.(md|mdx)$/i, '.md');
    const defaultDestAbs = path.join(destRoot, defaultRelative);

    const mirrorDestAbs = copyRoot
      ? path.join(copyRoot, relativeFromSrc.replace(/\.(md|mdx)$/i, '.md'))
      : null;

    try {
      const rawText = await fs.readFile(absoluteSourcePath, 'utf8');

      // Pre-pass: :::note/tip/info → <Callout>
      const preprocessedText = convertNoteTipBlocks(rawText);

      // Frontmatter
      const fm = matter(preprocessedText);
      const customerFM = fm.data ?? {};
      const bodyContent = fm.content ?? '';

      const derivedTitle =
        customerFM.sidebar_label ||
        customerFM.title ||
        bodyContent.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() ||
        'Untitled';

      const readmeFrontmatter = buildReadmeFrontmatter(derivedTitle);
      const readmeYaml = yaml.dump(readmeFrontmatter, { lineWidth: 0 });

      const warnings = [];
      const removedJsSnippets = [];
      const strippedHtmlSnippets = [];
      const referencedImagePaths = collectInlineImageUrlsFromText(bodyContent);
      const removedMdxComponents = [];

      const processed = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkMdx)
        .use(remarkFrontmatter, ['yaml'])

        .use(remarkReplaceImageZoom, { imageUrls: referencedImagePaths })
        .use(remarkCollectMarkdownImages, { images: referencedImagePaths })
        .use(remarkCollectMdxComponentsComponentLike, {
          removed: removedMdxComponents,
        })
        .use(mdFixBangAndHtmlComments)
        .use(remarkStripScriptsAndHandlers, {
          jsRemoved: removedJsSnippets,
          warnings,
        })
        .use(remarkConvertSelectedHtmlToMd, {
          keepHtmlIf: (rawHtml) =>
            /<\s*(table|thead|tbody|tr|th|td)\b/i.test(rawHtml) ||
            /<\s*(Tabs|Tab|Callout)\b/.test(rawHtml) ||
            /<\s*[A-Z][A-Za-z0-9]*/.test(rawHtml),
          recordRaw: (raw) => strippedHtmlSnippets.push(raw.trim()),
        })
        .use(remarkStringify, {
          bullet: '-',
          fences: true,
          listItemIndent: 'one',
          rule: '-',
        })
        .process(bodyContent);

      let markdownBody = String(processed);

      // Tabs post-process
      markdownBody = transformDocusaurusTabsToTarget(markdownBody);

      // Strip top-of-body imports
      {
        const importRegex = /^(?:\s*import\s.+\n)+/;
        const m = (markdownBody.match(importRegex) || [''])[0];
        markdownBody = markdownBody.replace(importRegex, '');
        if (m && m.trim()) {
          await appendToLog(logPath, 'REMOVED_IMPORTS', relativeFromSrc, '', [m.trim()], []);
        }
      }

      // ---- Replace ALL image mentions with placeholders (manual wiring later) ----
      markdownBody = replaceAllImagesWithPlaceholder(markdownBody);

      // Log collected info
      if (strippedHtmlSnippets.length) {
        await appendToLog(
          logPath,
          'STRIPPED_HTML',
          relativeFromSrc,
          strippedHtmlSnippets.join('\n---\n'),
          [],
          [],
        );
      }
      if (removedJsSnippets.length) {
        await appendToLog(logPath, 'REMOVED_JS', relativeFromSrc, '', removedJsSnippets, []);
      }
      if (removedMdxComponents.length) {
        await appendToLog(logPath, 'REMOVED_MDX', relativeFromSrc, '', removedMdxComponents, []);
      }
      const uniqueImages = Array.from(new Set(referencedImagePaths)).filter(Boolean);
      if (uniqueImages.length) {
        await appendToLog(logPath, 'IMAGES', relativeFromSrc, '', [], uniqueImages);
        await appendImagesMapRows(imagesMapPath, relativeFromSrc, uniqueImages, imageIndex);
      }

      const finalDoc = `---\n${readmeYaml}---\n\n${markdownBody}`.trim() + '\n';

      // ===================== MAPPING LOGIC (NO NEW FOLDERS) =====================
      const outFileName = path.basename(defaultDestAbs);
      const moveKey = outFileName.toLowerCase();

      let finalAbsolute = defaultDestAbs;
      let usedMapping = false;

      if (moveMap && moveMap.has(moveKey) && !(moveDupes && moveDupes.has(moveKey))) {
        const mappedDir = moveMap.get(moveKey); // absolute string or null
        if (typeof mappedDir === 'string' && mappedDir.trim()) {
          // Only use mapping if the directory ALREADY exists and is a directory.
          try {
            const st = await fs.stat(mappedDir);
            if (st.isDirectory()) {
              finalAbsolute = path.join(mappedDir, outFileName);
              usedMapping = true;
            } else {
              await appendToLog(
                logPath,
                'MOVE_DEST_NOT_DIR',
                relativeFromSrc,
                `Mapped destination exists but is not a directory: ${mappedDir}`,
                [],
                [],
              );
            }
          } catch {
            // Directory does not exist; do NOT create it. Keep default location.
            await appendToLog(
              logPath,
              'MOVE_DEST_MISSING',
              relativeFromSrc,
              `Mapped destination directory not found: ${mappedDir}`,
              [],
              [],
            );
          }
        }
      } else if (moveMap && moveDupes && moveDupes.has(moveKey)) {
        await appendToLog(
          logPath,
          'MOVE_DUPLICATE',
          relativeFromSrc,
          `Multiple destinations for ${outFileName}; not moved.`,
          [],
          [],
        );
      }
      // ========================================================================

      // Write outputs
      if (usedMapping) {
        // Do NOT create the mapped folder; we already checked it exists.
        await fs.writeFile(finalAbsolute, finalDoc, 'utf8');
      } else {
        // Default path: mirror source tree under dest, we can create needed folders.
        await fs.mkdir(path.dirname(finalAbsolute), { recursive: true });
        await fs.writeFile(finalAbsolute, finalDoc, 'utf8');
      }

      if (copyRoot) {
        await fs.mkdir(path.dirname(mirrorDestAbs), { recursive: true });
        await fs.writeFile(mirrorDestAbs, finalDoc, 'utf8');
      }

      report.files.push({
        source: relativeFromSrc,
        output: path.relative(destRoot, finalAbsolute),
        copiedTo: copyRoot ? path.relative(copyRoot, mirrorDestAbs) : null,
        title: readmeFrontmatter.title,
        warnings,
        images: uniqueImages,
      });

      console.log(
        pc.cyan('Converted:'),
        relativeFromSrc,
        '→',
        path.relative(destRoot, finalAbsolute),
        pc.green('✓'),
      );
    } catch (err) {
      failures++;
      console.warn(pc.red('Failed:'), relativeFromSrc);
      console.warn(pc.gray(String(err && (err.stack || err.message || err))));
      await appendToLog(
        logPath,
        'FAILED',
        relativeFromSrc,
        String(err && (err.stack || err.message || err)),
        [],
        [],
      );
      continue;
    }
  }

  // Finalization
  await ensureIndexesForCreatedDirs(destRoot);
  await updateAllOrderYamlIfPresent(destRoot);

  report.completedAt = new Date().toISOString();
  const reportPath = path.join(destRoot, 'migration-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  if (failures) {
    console.log(pc.red(`\nCompleted with ${failures} failure(s). See _log.csv.`));
  } else {
    console.log(pc.green('\nCompleted with no failures.'));
  }

  return report;
}

/* ========================================================================== */
/*                                 HELPERS                                    */
/* ========================================================================== */

function buildReadmeFrontmatter(title) {
  return {
    title,
    deprecated: false,
    hidden: false,
    metadata: { robots: 'index' },
  };
}

function collectInlineImageUrlsFromText(source) {
  const urls = new Set();
  const mdImg = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^")]+["'])?\)/g;
  for (const m of source.matchAll(mdImg)) if (m[1]) urls.add(m[1].trim());
  const htmlImg = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const m of source.matchAll(htmlImg)) if (m[1]) urls.add(m[1].trim());
  const useBase = /useBaseUrl\(\s*(['"])(.*?)\1\s*\)/g;
  for (const m of source.matchAll(useBase)) if (m[2]) urls.add(m[2].trim());
  return Array.from(urls);
}

function replaceImageMentions(markdownBody, imageUrlMap) {
  if (!imageUrlMap || !imageUrlMap.size) return markdownBody;
  let out = markdownBody;

  out = out.replace(/(\*\*MISSING IMAGE!\*\*)\s+([^\s]+)\s*$/gm, (whole, _label, originalPath) => {
    const entry = imageUrlMap.get(originalPath);
    if (!entry || !entry.url) return whole;
    return `<img src="${entry.url}" />`;
  });

  out = out.replace(
    /src=\{\s*useBaseUrl\(\s*(['"])(.*?)\1\s*\)\s*\}/g,
    (whole, _q, originalPath) => {
      const entry = imageUrlMap.get(originalPath);
      if (!entry || !entry.url) return whole;
      return `src="${entry.url}"`;
    },
  );

  out = out.replace(
    /!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^")]+["'])?\)/g,
    (whole, altText, originalPath) => {
      const entry = imageUrlMap.get(originalPath);
      if (!entry || !entry.url) return whole;
      return `![${altText}](${entry.url})`;
    },
  );

  return out;
}

/* ---------------- MDX component collection (for logging only) -------------- */
function remarkCollectMdxComponentsComponentLike({ removed = [] } = {}) {
  return (tree) => {
    visit(tree, (node) => {
      if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
        const name = node.name || '';
        if (!/^[A-Z]/.test(name)) return;
        const attrs = (node.attributes || [])
          .map((a) => {
            if (!a || !a.name) return '';
            if (typeof a.value === 'string') return `${a.name}="${a.value}"`;
            if (
              a.value &&
              typeof a.value === 'object' &&
              a.value.type === 'mdxJsxAttributeValueExpression'
            ) {
              return `${a.name}={${a.value.value}}`;
            }
            return a.name;
          })
          .filter(Boolean)
          .join(' ');
        removed.push(`<${name}${attrs ? ' ' + attrs : ''}${node.children?.length ? ' …' : ''}/>`);
      }
    });
  };
}

/** Replace ALL image mentions with a consistent placeholder. */
function replaceAllImagesWithPlaceholder(markdownBody) {
  let out = markdownBody;

  // 1) Markdown images: ![alt](url "title")
  out = out.replace(
    /!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^")]+["'])?\)/g,
    (_whole, _alt, url) => `**MISSING IMAGE!** ${url}`,
  );

  // 2) HTML <img src="...">
  out = out.replace(
    /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
    (_whole, url) => `**MISSING IMAGE!** ${url}`,
  );

  // 3) Existing ImageZoom placeholder is already "**MISSING IMAGE!** /path" (kept as-is)

  // 4) Docusaurus useBaseUrl() patterns inside src={...}
  out = out.replace(
    /src=\{\s*useBaseUrl\(\s*(['"])(.*?)\1\s*\)\s*\}/g,
    (_whole, _q, url) => `**MISSING IMAGE!** ${url}`,
  );

  return out;
}

/** Ensure images-map.csv has a header. */
async function ensureImagesMapHeader(csvPath) {
  try {
    await fs.access(csvPath);
    return; // already exists
  } catch {
    const header = 'File,Image Path,Local Candidate,Note\n';
    await fs.writeFile(csvPath, header, 'utf8');
  }
}

/**
 * Append rows to images-map.csv for manual wiring later.
 * - fileRel: doc’s relative path (from src root)
 * - imagePaths: array of referenced image paths found in the doc
 * - imageIndex: optional, if provided we’ll try to hint a local absolute match
 */
async function appendImagesMapRows(csvPath, fileRel, imagePaths, imageIndex) {
  const rows = [];
  for (const p of imagePaths) {
    const { localAbs, note } = tryResolveLocal(imageIndex, p);
    rows.push(
      `${csvSafe(fileRel)},${csvSafe(p)},${csvSafe(localAbs || '')},${csvSafe(note || '')}\n`,
    );
  }
  if (rows.length) {
    await fs.appendFile(csvPath, rows.join(''), 'utf8');
  }
}

function tryResolveLocal(imageIndex, imagePath) {
  if (!imageIndex) return { localAbs: '', note: 'no imagesSrc index' };
  try {
    // optional: lazy import to avoid circular deps
    // but since we didn’t import resolve helper here, do a simple lookup:
    const hit = imageIndex.get(imagePath) || imageIndex.get(decodeURIComponent(imagePath));
    if (hit) return { localAbs: hit, note: 'indexed' };
  } catch {}
  return { localAbs: '', note: 'not indexed' };
}

function csvSafe(v) {
  if (v == null) return '';
  let s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}
