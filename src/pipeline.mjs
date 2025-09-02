import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import pc from 'picocolors';

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkFrontmatter from 'remark-frontmatter';
import remarkStringify from 'remark-stringify';

import { buildReadmeFM } from './utils/frontmatter.mjs';
import { findMarkdownFilesRecursive } from './utils/fileops.mjs';
import { appendToLog, appendImagesManifest } from './utils/logging.mjs';

import { convertNoteTipBlocks } from './transform/callouts.mjs';
import { transformDocusaurusTabsToTarget } from './transform/tabs.mjs';
import { remarkConvertSelectedHtmlToMd } from './transform/htmlToMd.mjs';
import {
  remarkStripScriptsAndHandlers,
  mdFixBangAndHtmlComments,
} from './transform/scriptsAndHandlers.mjs';
import { remarkReplaceImageZoomWithPlaceholder } from './transform/imageZoom.mjs';
import {
  remarkCollectMarkdownImages,
  remarkCollectMdxComponentsComponentLike,
} from './transform/mdxCollect.mjs';

import { buildImageIndex } from './images/indexer.mjs';
import { uploadImagesForDocSmart } from './images/uploader.mjs';
import { rewriteAllImageOccurrences } from './images/rewrite.mjs';

export async function runPipeline({
  args,
  srcRoot,
  destRoot,
  copyRoot,
  logPath,
  imagesCsvPath,
  moveMap,
  moveDupes,
  report,
}) {
  const INCLUDE_MDX = !!args['include-mdx'];
  const UPLOAD_IMAGES = !!args['upload-images'];
  const IMAGES_SRC_ROOT = args['images-src']
    ? path.resolve(args['images-src'])
    : null;
  const README_API_KEY =
    process.env.README_API_KEY || args['readme-api-key'] || '';

  let IMAGE_INDEX = null;
  if (UPLOAD_IMAGES) {
    if (!IMAGES_SRC_ROOT)
      console.warn(
        pc.yellow('UPLOAD_IMAGES is on, but --images-src was not provided.')
      );
    else {
      IMAGE_INDEX = await buildImageIndex(IMAGES_SRC_ROOT, ['img', 'assets']);
      console.log(
        pc.gray(
          `Indexed ${IMAGE_INDEX.files.length} images from ${IMAGES_SRC_ROOT}`
        )
      );
    }
  }

  const allFiles = await findMarkdownFilesRecursive(srcRoot, {
    includeMdx: INCLUDE_MDX,
  });
  if (!allFiles.length) {
    console.log(
      pc.yellow('No .md files found (use --include-mdx to include .mdx).')
    );
    return { failed: 0 };
  }

  let failed = 0;

  for (const absSrc of allFiles) {
    const rel = path.relative(srcRoot, absSrc);
    const outRel = rel.replace(/\.(md|mdx)$/i, '.md');
    const defaultDestAbs = path.join(destRoot, outRel);
    const defaultCopyAbs = copyRoot ? path.join(copyRoot, outRel) : null;

    try {
      const raw = await fs.readFile(absSrc, 'utf8');

      // Convert :::note/tip/info first
      const preCallouts = convertNoteTipBlocks(raw);

      // Parse FM
      const fm = matter(preCallouts);
      const customerFM = fm.data ?? {};
      const content = fm.content ?? '';

      const title =
        customerFM.sidebar_label ||
        customerFM.title ||
        content.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() ||
        'Untitled';

      const readmeFM = buildReadmeFM(customerFM, title);
      const readmeYaml = yaml.dump(readmeFM, { lineWidth: 0 });

      const warnings = [];
      const strippedHtmlSnippets = [];
      const imageUrls = collectInlineImageUrlsFromText(content);
      const jsRemoved = [];
      const mdxRemoved = [];

      const vf = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkMdx)
        .use(remarkFrontmatter, ['yaml'])
        .use(remarkReplaceImageZoomWithPlaceholder, { imageUrls })
        .use(remarkCollectMarkdownImages, { images: imageUrls })
        .use(remarkCollectMdxComponentsComponentLike, { removed: mdxRemoved })
        .use(mdFixBangAndHtmlComments)
        .use(remarkStripScriptsAndHandlers, { jsRemoved, warnings })
        .use(remarkConvertSelectedHtmlToMd, {
          keepHtmlIf: rawHtml =>
            /<\s*(table|thead|tbody|tr|th|td)\b/i.test(rawHtml) ||
            /<\s*(Tabs|Tab|Callout)\b/.test(rawHtml) ||
            /<\s*[A-Z][A-Za-z0-9]*/.test(rawHtml),
          recordRaw: raw => strippedHtmlSnippets.push(raw.trim()),
        })
        .use(remarkStringify, {
          bullet: '-',
          fences: true,
          listItemIndent: 'one',
          rule: '-',
        })
        .process(content);

      let mdBody = String(vf);

      // Tabs → Tabs/Tab
      mdBody = transformDocusaurusTabsToTarget(mdBody);

      // Upload images & rewrite
      const uniqueImages = Array.from(new Set(imageUrls)).filter(Boolean);
      if (
        UPLOAD_IMAGES &&
        README_API_KEY &&
        IMAGE_INDEX &&
        uniqueImages.length
      ) {
        const mapping = await uploadImagesForDocSmart(
          uniqueImages,
          IMAGE_INDEX,
          README_API_KEY,
          {
            appendToLog,
            logPath,
            relFile: rel,
          }
        );
        if (mapping.size) {
          for (const [origPath, info] of mapping) {
            await appendImagesManifest(imagesCsvPath, {
              file: rel,
              original: origPath,
              local: info.local || '',
              url: info.url || '',
            });
          }
          mdBody = rewriteAllImageOccurrences(
            mdBody,
            new Map(Array.from(mapping).map(([orig, info]) => [orig, info.url]))
          );
        }
      } else if (uniqueImages.length && !UPLOAD_IMAGES) {
        await appendToLog(logPath, 'IMAGES', rel, '', [], uniqueImages);
      }

      // Strip import statements at top
      {
        const importRegex = /^(?:\s*import\s.+\n)+/;
        const m = (mdBody.match(importRegex) || [''])[0];
        mdBody = mdBody.replace(importRegex, '');
        if (m && m.trim())
          await appendToLog(
            logPath,
            'REMOVED_IMPORTS',
            rel,
            '',
            [m.trim()],
            []
          );
      }

      if (strippedHtmlSnippets.length) {
        await appendToLog(
          logPath,
          'STRIPPED_HTML',
          rel,
          strippedHtmlSnippets.join('\n---\n'),
          [],
          []
        );
      }
      if (jsRemoved.length)
        await appendToLog(logPath, 'REMOVED_JS', rel, '', jsRemoved, []);
      if (mdxRemoved.length)
        await appendToLog(logPath, 'REMOVED_MDX', rel, '', mdxRemoved, []);

      // Move-map
      const outFileName = path.basename(defaultDestAbs);
      const moveKey = outFileName.toLowerCase();

      let destAbs = defaultDestAbs;
      let copyAbs = defaultCopyAbs;

      if (moveMap && moveMap.has(moveKey)) {
        if (moveDupes.has(moveKey)) {
          await appendToLog(
            logPath,
            'MOVE_DUPLICATE',
            rel,
            `Multiple destinations found for ${outFileName}; not moved.`,
            [],
            []
          );
        } else {
          const mappedDir = moveMap.get(moveKey);
          destAbs = path.join(mappedDir, outFileName);
          if (copyRoot) {
            const relFromDest = path.relative(destRoot, destAbs);
            copyAbs = path.join(copyRoot, relFromDest);
          }
        }
      }

      const final = `---\n${readmeYaml}---\n\n${mdBody}`.trim() + '\n';

      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      await fs.writeFile(destAbs, final, 'utf8');
      if (copyAbs) {
        await fs.mkdir(path.dirname(copyAbs), { recursive: true });
        await fs.writeFile(copyAbs, final, 'utf8');
      }

      if (destAbs !== defaultDestAbs) {
        await appendToLog(
          logPath,
          'MOVED',
          rel,
          `Moved to ${path.relative(destRoot, destAbs)}`,
          [],
          []
        );
      }

      report.files.push({
        source: path.relative(srcRoot, absSrc),
        output: path.relative(destRoot, destAbs),
        copiedTo: copyRoot && copyAbs ? path.relative(copyRoot, copyAbs) : null,
        title: readmeFM.title ?? null,
        warnings,
        images: uniqueImages,
        moved: destAbs !== defaultDestAbs,
      });

      console.log(
        pc.cyan('Converted:'),
        path.relative(srcRoot, absSrc),
        '→',
        path.relative(destRoot, destAbs),
        pc.green('✓')
      );
    } catch (err) {
      failed++;
      console.warn(pc.red('Failed:'), path.relative(srcRoot, absSrc));
      console.warn(pc.gray(String(err && (err.stack || err.message || err))));
      await appendToLog(
        logPath,
        'FAILED',
        rel,
        String(err && (err.stack || err.message || err)),
        [],
        []
      );
      continue;
    }
  }

  return { failed };
}

function collectInlineImageUrlsFromText(source) {
  const urls = new Set();
  const mdImg = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^")]+["'])?\)/g;
  for (const m of source.matchAll(mdImg)) if (m[1]) urls.add(m[1].trim());
  const htmlImg = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const m of source.matchAll(htmlImg)) if (m[1]) urls.add(m[1].trim());
  const useBase = /useBaseUrl\(\s*(['"])(.*?)\1\s*\)/g;
  for (const m of source.matchAll(useBase)) if (m[2]) urls.add(m[2].trim());
  const placeholder = /<!--IMAGE_PLACEHOLDER:([^>]+)-->/g;
  for (const m of source.matchAll(placeholder)) if (m[1]) urls.add(m[1].trim());
  return Array.from(urls);
}
