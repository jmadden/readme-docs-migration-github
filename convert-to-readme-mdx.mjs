#!/usr/bin/env node
/**
 * Recursive MD → ReadMe-ready Markdown converter with:
 *  - Frontmatter mapping to ReadMe's FM (no sidebar_* fields)
 *  - Robust :::note / :::tip / :::info → <Callout> pre-pass
 *  - MD-only pipeline (no rehype) so JSX & HTML tables survive
 *  - <ImageZoom> → placeholder comment, later rewritten to <img src="...">
 *  - Tabs (Docusaurus) → Tabs/Tab post-process (textual) with label parsing (even JSX)
 *  - Strip <script> and inline handlers (onClick, etc.) from raw HTML blocks; log removals
 *  - Single consolidated _log.csv + migration-report.json at destination root
 *  - index.md creation & _order.yaml update (if present) across all created folders
 *  - Optional image upload to ReadMe Images API with recursive local index and manifest (_images.csv)
 *
 * Usage:
 *   node convert-to-readme-mdx.mjs \
 *     --cwd "/path/to/src-root" \
 *     --src . \
 *     --out "/path/to/dest-root" \
 *     [--include-mdx] [--copy "/optional/second/dest"] \
 *     [--upload-images] [--images-src "/path/to/static"] [--readme-api-key "XXX"]
 */

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
import { visit } from 'unist-util-visit';

import { fetch, FormData, File } from 'undici';

/* ---------------- CLI + paths ---------------- */

const rawArgs = parseArgs(process.argv.slice(2));
if (!rawArgs.cwd) {
  console.error(pc.red('Error: --cwd is required (root directory to scan).'));
  process.exit(1);
}
process.chdir(path.resolve(rawArgs.cwd));
console.log(pc.gray(`cwd => ${process.cwd()}`));

const args = rawArgs;
if (!args.src) {
  console.error(
    pc.red('Error: --src is required (starting folder, relative to --cwd).')
  );
  process.exit(1);
}
if (!args.out) {
  console.error(pc.red('Error: --out is required (destination root).'));
  process.exit(1);
}

const SRC_ROOT = path.resolve(args.src);
const DEST_ROOT = path.resolve(args.out);
const COPY_ROOT = args.copy ? path.resolve(args.copy) : null;
const INCLUDE_MDX = !!args['include-mdx'];

const UPLOAD_IMAGES = !!args['upload-images'];
const IMAGES_SRC_ROOT = args['images-src'] ? path.resolve(args['images-src']) : null;
const README_API_KEY = process.env.README_API_KEY || args['readme-api-key'] || '';

await fs.mkdir(DEST_ROOT, { recursive: true });
if (COPY_ROOT) await fs.mkdir(COPY_ROOT, { recursive: true });

const LOG_PATH = path.join(DEST_ROOT, '_log.csv');
await writeLogHeader(LOG_PATH);
const REPORT_PATH = path.join(DEST_ROOT, 'migration-report.json');

const IMAGES_MANIFEST_CSV = path.join(DEST_ROOT, '_images.csv');
const UPLOAD_CACHE = new Map(); // absLocalPath -> hostedURL
let IMAGE_INDEX = null; // populated if upload enabled

const report = {
  startedAt: new Date().toISOString(),
  cwd: process.cwd(),
  srcRoot: SRC_ROOT,
  destRoot: DEST_ROOT,
  copyRoot: COPY_ROOT,
  files: [],
};

if (UPLOAD_IMAGES) {
  await initImagesManifest(IMAGES_MANIFEST_CSV);
  if (!IMAGES_SRC_ROOT) {
    console.warn(pc.yellow('UPLOAD_IMAGES is on, but --images-src was not provided.'));
  } else {
    IMAGE_INDEX = await buildImageIndex(IMAGES_SRC_ROOT, ['img', 'assets']);
    console.log(pc.gray(`Indexed ${IMAGE_INDEX.files.length} images from ${IMAGES_SRC_ROOT}`));
  }
}

/* ---------------- discover files ---------------- */

const allFiles = await findMarkdownFilesRecursive(SRC_ROOT, {
  includeMdx: INCLUDE_MDX,
});
if (!allFiles.length) {
  console.log(
    pc.yellow('No .md files found (use --include-mdx to include .mdx).')
  );
  process.exit(0);
}

let failed = 0;

/* ---------------- main loop ---------------- */

for (const absSrc of allFiles) {
  const rel = path.relative(SRC_ROOT, absSrc);
  const destAbs = path.join(DEST_ROOT, rel.replace(/\.(md|mdx)$/i, '.md'));
  const copyAbs = COPY_ROOT
    ? path.join(COPY_ROOT, rel.replace(/\.(md|mdx)$/i, '.md'))
    : null;

  try {
    const raw = await fs.readFile(absSrc, 'utf8');

    // Pre-pass: :::note / :::tip / :::info → <Callout>
    const preCallouts = convertNoteTipBlocks(raw);

    // Parse frontmatter
    const fm = matter(preCallouts);
    const customerFM = fm.data ?? {};
    const content = fm.content ?? '';

    // Derive title
    const title =
      customerFM.sidebar_label ||
      customerFM.title ||
      content.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() ||
      'Untitled';

    // Build ReadMe frontmatter (no sidebar fields)
    const readmeFM = buildReadmeFM(customerFM, title);
    const readmeYaml = yaml.dump(readmeFM, { lineWidth: 0 });

    // Trackers
    const warnings = [];
    const strippedHtmlSnippets = [];
    const imageUrls = collectInlineImageUrlsFromText(content);
    const jsRemoved = [];
    const mdxRemoved = [];

    // MD-only transformation pipeline
    const vf = await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMdx)
      .use(remarkFrontmatter, ['yaml'])

      // Handle <ImageZoom> in mdast (replace with placeholder marker)
      .use(remarkReplaceImageZoomWithPlaceholder, { imageUrls })

      // Collect markdown images
      .use(remarkCollectMarkdownImages, { images: imageUrls })

      // Record MDX components that look like components (Uppercase) — for logging only
      .use(remarkCollectMdxComponentsComponentLike, { removed: mdxRemoved })

      // Fix MDX-unsafe HTML comments / <!…>
      .use(mdFixBangAndHtmlComments)

      // Strip <script>…</script> and inline handlers in html nodes; log removals
      .use(remarkStripScriptsAndHandlers, { jsRemoved, warnings })

      // Convert only a safe subset of HTML → Markdown; keep tables & JSX intact
      .use(remarkConvertSelectedHtmlToMd, {
        keepHtmlIf: rawHtml => {
          return (
            /<\s*(table|thead|tbody|tr|th|td)\b/i.test(rawHtml) ||
            /<\s*(Tabs|Tab|Callout)\b/.test(rawHtml) ||
            /<\s*[A-Z][A-Za-z0-9]*/.test(rawHtml)
          ); // any Capitalized JSX component
        },
        recordRaw: raw => strippedHtmlSnippets.push(raw.trim()),
      })

      // Stringify (no HAST round-trip)
      .use(remarkStringify, {
        bullet: '-',
        fences: true,
        listItemIndent: 'one',
        rule: '-',
      })
      .process(content);

    let mdBody = String(vf);

    // Post-process: transform Docusaurus Tabs to target Tabs/Tab
    mdBody = transformDocusaurusTabsToTarget(mdBody);

    // --- Upload & rewrite images, if enabled ---
    const uniqueImages = Array.from(new Set(imageUrls)).filter(Boolean);
    if (UPLOAD_IMAGES) {
      if (!README_API_KEY) {
        console.warn(pc.yellow('UPLOAD_IMAGES set, but no README_API_KEY provided.'));
      } else if (!IMAGE_INDEX) {
        console.warn(pc.yellow('UPLOAD_IMAGES set, but image index not available.'));
      } else if (uniqueImages.length) {
        const mapping = await uploadImagesForDocSmart(
          uniqueImages,
          IMAGE_INDEX,
          README_API_KEY,
          LOG_PATH,
          rel
        );
        if (mapping.size) {
          // record manifest
          for (const [origPath, info] of mapping) {
            await appendImagesManifest(IMAGES_MANIFEST_CSV, {
              file: rel,
              original: origPath,
              local: info.local || '',
              url: info.url || ''
            });
          }
          // rewrite occurrences (placeholders, markdown, html, useBaseUrl)
          mdBody = rewriteAllImageOccurrences(mdBody, new Map(
            Array.from(mapping).map(([orig, info]) => [orig, info.url])
          ));
        }
      }
    }

    // Strip top-of-body import statements (log)
    {
      const importRegex = /^(?:\s*import\s.+\n)+/;
      const m = (mdBody.match(importRegex) || [''])[0];
      mdBody = mdBody.replace(importRegex, '');
      if (m && m.trim()) {
        await appendToLog(LOG_PATH, 'REMOVED_IMPORTS', rel, '', [m.trim()], []);
      }
    }

    // Logging: residual HTML snippets (non-whitelisted ones that we converted)
    if (strippedHtmlSnippets.length) {
      await appendToLog(
        LOG_PATH,
        'STRIPPED_HTML',
        rel,
        strippedHtmlSnippets.join('\n---\n'),
        [],
        []
      );
    }
    if (jsRemoved.length) {
      await appendToLog(LOG_PATH, 'REMOVED_JS', rel, '', jsRemoved, []);
    }
    if (mdxRemoved.length) {
      await appendToLog(LOG_PATH, 'REMOVED_MDX', rel, '', mdxRemoved, []);
    }
    if (uniqueImages.length && !UPLOAD_IMAGES) {
      await appendToLog(LOG_PATH, 'IMAGES', rel, '', [], uniqueImages);
    }

    // Final doc
    const final = `---\n${readmeYaml}---\n\n${mdBody}`.trim() + '\n';

    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.writeFile(destAbs, final, 'utf8');
    if (COPY_ROOT) {
      await fs.mkdir(path.dirname(copyAbs), { recursive: true });
      await fs.writeFile(copyAbs, final, 'utf8');
    }

    report.files.push({
      source: path.relative(SRC_ROOT, absSrc),
      output: path.relative(DEST_ROOT, destAbs),
      copiedTo: COPY_ROOT ? path.relative(COPY_ROOT, copyAbs) : null,
      title: readmeFM.title ?? null,
      warnings,
      images: uniqueImages,
    });

    console.log(
      pc.cyan('Converted:'),
      path.relative(SRC_ROOT, absSrc),
      '→',
      path.relative(DEST_ROOT, destAbs),
      pc.green('✓')
    );
  } catch (err) {
    failed++;
    console.warn(pc.red('Failed:'), path.relative(SRC_ROOT, absSrc));
    console.warn(pc.gray(String(err && (err.stack || err.message || err))));
    await appendToLog(
      LOG_PATH,
      'FAILED',
      rel,
      String(err && (err.stack || err.message || err)),
      [],
      []
    );
    continue;
  }
}

/* ---------------- finalize: index, order, report ---------------- */

await ensureIndexesForCreatedDirs(DEST_ROOT);
await updateAllOrderYamlIfPresent(DEST_ROOT);

report.completedAt = new Date().toISOString();
await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

if (failed) {
  console.log(pc.red(`\nCompleted with ${failed} failure(s). See _log.csv.`));
} else {
  console.log(pc.green('\nCompleted with no failures.'));
}

/* ================= helpers ================= */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function buildReadmeFM(customerFM, title) {
  return {
    title,
    deprecated: false,
    hidden: false,
    metadata: { robots: 'index' },
  };
}

async function findMarkdownFilesRecursive(root, { includeMdx = false } = {}) {
  const out = [];
  async function walk(dir) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name === 'node_modules' || d.name.startsWith('.')) continue;
        await walk(p);
      } else if (d.isFile()) {
        const lower = p.toLowerCase();
        if (lower.endsWith('.md') || (includeMdx && lower.endsWith('.mdx')))
          out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

/* ---------- Pre-pass: :::note / :::tip / :::info → <Callout> ---------- */

function convertNoteTipBlocks(text) {
  const noteRe = /^:::note[^\n]*\n([\s\S]*?)\n:::\s*$/gim;
  const tipRe = /^:::tip[^\n]*\n([\s\S]*?)\n:::\s*$/gim;
  const infoRe = /^:::info[^\n]*\n([\s\S]*?)\n:::\s*$/gim;

  const toCallout = (inner, kind) => {
    const body = inner.trim();
    if (kind === 'note') {
      return [
        `<Callout icon="📘" theme="info">`,
        `  **NOTE**`,
        ``,
        indentBlock(body, '  '),
        `</Callout>`,
      ].join('\n');
    }
    if (kind === 'tip') {
      return [
        `<Callout icon="👍" theme="okay">`,
        `  Tip`,
        ``,
        indentBlock(body, '  '),
        `</Callout>`,
      ].join('\n');
    }
    // kind === 'info'
    return [
      `<Callout icon="ℹ️" theme="info">`,
      `  ${indentBlock(body, '  ').trimStart()}`,
      `</Callout>`,
    ].join('\n');
  };

  // Order of replacements doesn’t matter with these non-greedy, line-anchored patterns
  let out = text.replace(infoRe, (_, inner) => toCallout(inner, 'info'));
  out = out.replace(tipRe, (_, inner) => toCallout(inner, 'tip'));
  out = out.replace(noteRe, (_, inner) => toCallout(inner, 'note'));
  return out;
}

function indentBlock(s, pad = '  ') {
  return String(s)
    .split(/\r?\n/)
    .map(line => (line.length ? pad + line : ''))
    .join('\n');
}

/* ---------- Post-process Tabs transform (textual) ---------- */

function transformDocusaurusTabsToTarget(markdown) {
  return markdown.replace(/<Tabs\b[\s\S]*?<\/Tabs>/g, (whole) => {
    // 1) Extract values={[ ... ]} by balancing braces so JSX in labels doesn't break parsing
    const { arraySrc, openEndIndex } = extractValuesArrayFromTabsOpen(whole);
    const labelByValue = buildLabelMapFromValuesArray(arraySrc); // value -> cleaned label

    // 2) Compute the true inner content after the real end of the opening tag
    const innerStart = openEndIndex > -1 ? openEndIndex + 1 : whole.indexOf(">") + 1;
    const innerEnd = whole.lastIndexOf("</Tabs>");
    const inner = innerEnd > innerStart ? whole.slice(innerStart, innerEnd) : "";

    // 3) Replace each <TabItem ...>...</TabItem> with <Tab title="...">…</Tab>
    const tabs = [];
    inner.replace(/<TabItem\b([^>]*)>([\s\S]*?)<\/TabItem>/g, (m, tabAttrs, tabBody) => {
      const valueAttr = getAttr(tabAttrs, "value");        // supports "v", 'v', {v}
      const rawItemLabel = getAttr(tabAttrs, "label");     // supports label="…", label={<b>…</b>}
      const preferred = rawItemLabel || (valueAttr && labelByValue.get(valueAttr)) || "";
      const title = cleanLabel(preferred, valueAttr || "Tab"); // strip tags; fallback to value
      const body = tabBody.trim();

      tabs.push(
        [
          `  <Tab title="${escapeAttr(title)}">`,
          indentBlock(body, "   "),
          `  </Tab>`
        ].join("\n")
      );
      return m;
    });

    if (!tabs.length) return whole; // nothing to do; leave the original Tabs block intact
    return [`<Tabs>`, tabs.join("\n\n"), `</Tabs>`].join("\n");
  });
}

// Find values={ ...[ ... ]... } inside <Tabs …> by balancing braces.
// Returns the raw content between the [ and ] as `arraySrc`
// and the true index of the '>' that ends the opening tag as `openEndIndex`.
function extractValuesArrayFromTabsOpen(whole) {
  const start = whole.indexOf("<Tabs");
  if (start === -1) return { arraySrc: "", openEndIndex: whole.indexOf(">") };

  const valIdx = whole.indexOf("values", start);
  let openEndIndex = whole.indexOf(">");
  if (valIdx === -1) return { arraySrc: "", openEndIndex };

  const braceStart = whole.indexOf("{", valIdx);
  if (braceStart === -1) return { arraySrc: "", openEndIndex };

  // Balance { … } starting at the '{' after 'values='
  let i = braceStart, depth = 0;
  for (; i < whole.length; i++) {
    const ch = whole[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) break; }
  }
  const braceEnd = i;
  // The real end of the opening <Tabs …> is the first '>' after the closing '}'
  openEndIndex = whole.indexOf(">", braceEnd);

  const inside = whole.slice(braceStart + 1, braceEnd); // typically: [ {…}, {…} ]
  const lb = inside.indexOf("[");
  const rb = inside.lastIndexOf("]");
  const arraySrc = (lb !== -1 && rb !== -1 && rb > lb) ? inside.slice(lb + 1, rb) : inside;
  return { arraySrc, openEndIndex };
}

// Build a value -> label map from the values array source.
// Handles quoted labels, brace-wrapped labels, and raw JSX labels like <center>…</center>.
function buildLabelMapFromValuesArray(arraySrc) {
  const map = new Map();
  const objs = extractTopLevelObjects(arraySrc);
  for (const objStr of objs) {
    const value =
      ((/[\s,{]value\s*:\s*(['"])([\s\S]*?)\1/).exec(objStr) || [])[2] ||
      ((/[\s,{]value\s*:\s*\{([\s\S]*?)\}/).exec(objStr) || [])[1] ||
      ((/[\s,{]value\s*:\s*([^\s,}]+)/).exec(objStr) || [])[1] ||
      "";

    if (!value) continue;

    let rawLabel =
      ((/[\s,{]label\s*:\s*(['"])([\s\S]*?)\1/).exec(objStr) || [])[2];
    if (!rawLabel) {
      rawLabel = ((/[\s,{]label\s*:\s*\{([\s\S]*?)\}/).exec(objStr) || [])[1];
    }
    if (!rawLabel) {
      // JSX / bare: capture until first comma or closing brace
      rawLabel = ((/[\s,{]label\s*:\s*([\s\S]*?)(?:,|})/).exec(objStr) || [])[1] || "";
    }

    rawLabel = stripWrapping(rawLabel);
    const label = cleanLabel(rawLabel, value); // strip tags; fallback to value if empty
    map.set(value, label);
  }
  return map;
}

// Extract top-level {...} objects from a string like "{...}, {...}"
function extractTopLevelObjects(s) {
  const out = [];
  let depth = 0, start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1; } }
  }
  // Fallback if nothing balanced
  if (!out.length) {
    const re = /\{[\s\S]*?\}/g; let m;
    while ((m = re.exec(s)) !== null) out.push(m[0]);
  }
  return out;
}

// Read attribute from a tag attribute string.
// Supports name="...", name='...', name={ ... } (including JSX).
function getAttr(attrs, name) {
  if (!attrs) return "";
  let m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  if (m) return m[1].trim();
  m = new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(attrs);
  if (m) return m[1].trim();
  m = new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`).exec(attrs);
  if (m) return m[1].trim();
  return "";
}

function cleanLabel(raw, fallback = "") {
  const stripped = stripTagsInline(String(raw || "")).trim();
  return stripped || fallback;
}

function stripTagsInline(s) {
  // remove any HTML/JSX tags like <center>…</center>, <b>, etc.
  return String(s).replace(/<[^>]+>/g, "");
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ---------- remark helpers (mdast) ---------- */

// Collect markdown images
function remarkCollectMarkdownImages({ images = [] } = {}) {
  return tree => {
    visit(tree, 'image', node => {
      if (node && typeof node.url === 'string' && node.url.trim()) {
        images.push(node.url.trim());
      }
    });
  };
}

// Record MDX components that look like components (uppercase start)
function remarkCollectMdxComponentsComponentLike({ removed = [] } = {}) {
  return tree => {
    visit(tree, node => {
      if (
        node.type === 'mdxJsxFlowElement' ||
        node.type === 'mdxJsxTextElement'
      ) {
        const name = node.name || '';
        if (!/^[A-Z]/.test(name)) return;
        const attrs = (node.attributes || [])
          .map(a => {
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
        removed.push(
          `<${name}${attrs ? ' ' + attrs : ''}${
            node.children?.length ? ' …' : ''
          }/>`
        );
      }
    });
  };
}

// Fix MDX-unsafe comments/<!...>
function mdFixBangAndHtmlComments() {
  return tree => {
    visit(tree, node => {
      if (node.type === 'html' && typeof node.value === 'string') {
        const v = node.value;
        if (/^\s*<!--/.test(v) && /-->\s*$/.test(v)) {
          node.type = 'mdxFlowExpression';
          node.value = `{/*${v
            .replace(/^\s*<!--\s*/, '')
            .replace(/\s*-->\s*$/, '')}*/}`;
        } else if (/^\s*<![^-]/.test(v)) {
          node.value = v.replace(/^</, '&lt;');
        }
      }
    });
  };
}

// Replace <ImageZoom …> with a placeholder comment we can rewrite after upload
function remarkReplaceImageZoomWithPlaceholder({ imageUrls = [] } = {}) {
  return tree => {
    visit(tree, (node, index, parent) => {
      if (!parent) return;
      if (node.type === 'mdxJsxFlowElement' && node.name === 'ImageZoom') {
        let foundPath = '';
        for (const a of node.attributes || []) {
          if (a.name === 'src') {
            if (typeof a.value === 'string') {
              foundPath = a.value.trim();
            } else if (
              a.value &&
              a.value.type === 'mdxJsxAttributeValueExpression'
            ) {
              const m = /useBaseUrl\(\s*(['"])(.*?)\1\s*\)/.exec(
                a.value.value || ''
              );
              if (m && m[2]) foundPath = m[2].trim();
            }
          }
        }
        if (foundPath) imageUrls.push(foundPath);
        const replacement = {
          type: 'html',
          value: `<!--IMAGE_PLACEHOLDER:${foundPath}-->`
        };
        parent.children.splice(index, 1, replacement);
      }
    });
  };
}

/**
 * Strip <script>…</script> blocks and remove inline event handlers (onClick=, onChange=, …)
 * from raw HTML nodes. Record removals in jsRemoved + warnings.
 */
function remarkStripScriptsAndHandlers({ jsRemoved = [], warnings = [] } = {}) {
  return tree => {
    visit(tree, 'html', node => {
      if (!node || typeof node.value !== 'string') return;
      let html = node.value;

      // Remove <script ...>...</script>
      html = html.replace(
        /<\s*script\b([^>]*)>([\s\S]*?)<\s*\/\s*script\s*>/gi,
        (_, attrs, code) => {
          const srcMatch = attrs && attrs.match(/\bsrc\s*=\s*(['"])(.*?)\1/i);
          if (srcMatch && srcMatch[2]) {
            jsRemoved.push(`SCRIPT SRC: ${srcMatch[2]}`);
            warnings.push({
              type: 'script',
              message: `Removed <script src="${srcMatch[2]}">`,
            });
          } else if (code && code.trim()) {
            jsRemoved.push(`SCRIPT INLINE CODE:\n${code.trim()}`);
            warnings.push({
              type: 'script',
              message: 'Removed inline <script>',
            });
          } else {
            warnings.push({ type: 'script', message: 'Removed <script>' });
          }
          return '\n{/* ❗ Script removed: replace with an MDX component. */}\n';
        }
      );

      // Remove inline handlers (onClick, onChange, etc.) — keep the tag
      html = html.replace(
        /(<[A-Za-z][^>]*?)\s+on[A-Z][A-Za-z]+\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/g,
        (m, start) => {
          jsRemoved.push(`INLINE HANDLER removed in: ${truncate(start, 80)}`);
          warnings.push({
            type: 'inline-handler',
            message: 'Removed inline event handler',
          });
          return start; // drop the handler attribute
        }
      );

      node.value = html;
    });
  };
}

// Convert a safe subset of HTML → Markdown, leave tables/JSX untouched.
// We also surface the raw HTML we touched via recordRaw (for logging parity).
function remarkConvertSelectedHtmlToMd(options = {}) {
  const { keepHtmlIf, recordRaw } = options;
  return tree => {
    visit(tree, 'html', (node, index, parent) => {
      if (!parent || index == null) return;
      const raw = String(node.value || '');

      if (typeof keepHtmlIf === 'function' && keepHtmlIf(raw)) return;

      const html = raw.replace(/\r\n?/g, '\n');
      let changed = false;
      let out = html;

      // h1..h6
      out = out.replace(
        /<\s*h([1-6])\s*>\s*([\s\S]*?)\s*<\s*\/\s*h\1\s*>\s*/gi,
        (_, n, inner) => {
          changed = true;
          return `${'#'.repeat(Number(n))} ${stripTags(inner).trim()}\n\n`;
        }
      );

      // p
      out = out.replace(
        /<\s*p\s*>\s*([\s\S]*?)\s*<\s*\/\s*p\s*>\s*/gi,
        (_, inner) => {
          changed = true;
          return `${stripTags(inner).trim()}\n\n`;
        }
      );

      // br
      out = out.replace(/<\s*br\s*\/?\s*>\s*/gi, () => {
        changed = true;
        return '  \n';
      });

      // strong/b
      out = out.replace(
        /<\s*(b|strong)\s*>\s*([\s\S]*?)\s*<\s*\/\s*(b|strong)\s*>\s*/gi,
        (_, _t1, inner) => {
          changed = true;
          return `**${stripTags(inner).trim()}**`;
        }
      );

      // em/i
      out = out.replace(
        /<\s*(i|em)\s*>\s*([\s\S]*?)\s*<\s*\/\s*(i|em)\s*>\s*/gi,
        (_, _t1, inner) => {
          changed = true;
          return `*${stripTags(inner).trim()}*`;
        }
      );

      // ul > li
      out = out.replace(
        /<\s*ul\s*>\s*([\s\S]*?)\s*<\s*\/\s*ul\s*>\s*/gi,
        (_, inner) => {
          const items = Array.from(
            inner.matchAll(/<\s*li\s*>\s*([\s\S]*?)\s*<\s*\/\s*li\s*>/gi)
          ).map(m => m[1]);
          if (!items.length) return _;
          changed = true;
          return (
            items.map(it => `- ${stripTags(it).trim()}`).join('\n') + '\n\n'
          );
        }
      );

      // ol > li
      out = out.replace(
        /<\s*ol\s*>\s*([\s\S]*?)\s*<\s*\/\s*ol\s*>\s*/gi,
        (_, inner) => {
          const items = Array.from(
            inner.matchAll(/<\s*li\s*>\s*([\s\S]*?)\s*<\s*\/\s*li\s*>/gi)
          ).map(m => m[1]);
          if (!items.length) return _;
          changed = true;
          return (
            items
              .map((it, i) => `${i + 1}. ${stripTags(it).trim()}`)
              .join('\n') + '\n\n'
          );
        }
      );

      if (!changed) return;
      if (typeof recordRaw === 'function') recordRaw(raw);

      parent.children.splice(index, 1, { type: 'text', value: out });
    });
  };
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '');
}

/* ---------- index + order helpers ---------- */

async function ensureIndexesForCreatedDirs(root) {
  async function walk(dir) {
    const indexPath = path.join(dir, 'index.md');
    try {
      await fs.access(indexPath);
    } catch {
      const fm = {
        title: path.basename(dir),
        deprecated: false,
        hidden: false,
        metadata: { robots: 'index' },
      };
      const yamlStr = yaml.dump(fm, { lineWidth: 0 });
      await fs.writeFile(indexPath, `---\n${yamlStr}---\n`, 'utf8');
      console.log(pc.blue(`Created index.md in ${dir} (title: "${fm.title}")`));
    }
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      if (
        d.isDirectory() &&
        !d.name.startsWith('.') &&
        d.name !== 'node_modules'
      ) {
        await walk(path.join(dir, d.name));
      }
    }
  }
  await walk(root);
}

async function updateAllOrderYamlIfPresent(root) {
  async function processDir(dir) {
    const orderPath = path.join(dir, '_order.yaml');
    try {
      await fs.access(orderPath);
    } catch {
      return;
    }
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const items = dirents
      .filter(d => {
        const name = d.name;
        if (name === '_order.yaml') return false;
        if (name === '_log.csv') return false;
        if (name === 'migration-report.json') return false;
        if (name === '_images.csv') return false;
        if (name.toLowerCase() === 'index.md') return false;
        if (name.startsWith('.')) return false;
        if (name.startsWith('_')) return false;
        if (d.isDirectory()) return true;
        if (d.isFile() && path.extname(name).toLowerCase() === '.md')
          return true;
        return false;
      })
      .map(d => {
        let base = d.name;
        if (d.isFile()) base = path.basename(base, path.extname(base));
        const slug = base.toLowerCase().replace(/\s+/g, '-');
        return `- ${slug}`;
      })
      .sort((a, b) => a.localeCompare(b));
    const content = items.join('\n') + (items.length ? '\n' : '');
    await fs.writeFile(orderPath, content, 'utf8');
    console.log(pc.blue(`Updated _order.yaml in ${dir}`));
  }

  async function walk(dir) {
    await processDir(dir);
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      if (
        d.isDirectory() &&
        !d.name.startsWith('.') &&
        d.name !== 'node_modules'
      ) {
        await walk(path.join(dir, d.name));
      }
    }
  }

  await walk(root);
}

/* ---------- CSV logging ---------- */

async function writeLogHeader(logPath) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const header = `Type,File,Error Message,Removed Code,Missing Images\n`;
  await fs.writeFile(logPath, header, 'utf8');
}

async function appendToLog(
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
