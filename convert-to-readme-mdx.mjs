#!/usr/bin/env node
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
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeRemark from 'rehype-remark';
import remarkStringify from 'remark-stringify';
import { visit } from 'unist-util-visit';

/**
 * Usage examples:
 *   node convert-to-readme-mdx.mjs \
 *     --cwd "./customer-repo/docs" \
 *     --src . \
 *     --out "../readme-ready" \
 *     --dest-name content \
 *     --copy "../github-synced-project"
 *
 * Flags:
 *   --cwd           working directory to chdir into (optional)
 *   --src           source directory, relative to cwd (required unless --in-place)
 *   --out           output base directory (required unless --in-place)
 *   --dest-name     subdirectory under --out (and --copy) to write into (optional)
 *   --copy          also copy converted files to this directory (optional)
 *   --config        path to JSON config (optional)
 *   --include-mdx   also process .mdx files in the SAME folder (non-recursive)
 *   --in-place      write back into --src (dangerous; not recommended)
 */

const rawArgs = parseArgs(process.argv.slice(2));
if (rawArgs.cwd) {
  process.chdir(path.resolve(rawArgs.cwd));
  console.log(pc.gray(`cwd => ${process.cwd()}`));
}
const args = rawArgs;

if (!args.src && !args['in-place']) {
  console.error(pc.red('Error: --src is required unless you use --in-place.'));
  process.exit(1);
}
if (!args.out && !args['in-place']) {
  console.error(pc.red('Error: --out is required unless you use --in-place.'));
  process.exit(1);
}

const SRC_DIR = path.resolve(args.src || '.');
const OUT_BASE = args['in-place'] ? SRC_DIR : path.resolve(args.out);
const DEST_DIR_NAME = args['dest-name'] ? sanitizeDir(args['dest-name']) : null;
const OUT_DIR = DEST_DIR_NAME ? path.join(OUT_BASE, DEST_DIR_NAME) : OUT_BASE;

const COPY_BASE = args.copy ? path.resolve(args.copy) : null;
const COPY_DIR = COPY_BASE
  ? DEST_DIR_NAME
    ? path.join(COPY_BASE, DEST_DIR_NAME)
    : COPY_BASE
  : null;

const CONFIG = await loadConfig(args.config);

// CSV log lives alongside output
const LOG_PATH = path.join(OUT_DIR, '_log.csv');

const report = {
  startedAt: new Date().toISOString(),
  cwd: process.cwd(),
  src: SRC_DIR,
  out: OUT_DIR,
  copy: COPY_DIR,
  destName: DEST_DIR_NAME,
  files: [],
};

(async () => {
  // NON-RECURSIVE: only files directly in SRC_DIR
  const includeMdx = !!args['include-mdx'];
  const dirents = await fs.readdir(SRC_DIR, { withFileTypes: true });
  const files = dirents
    .filter(d => d.isFile())
    .map(d => d.name)
    .filter(name => {
      const n = name.toLowerCase();
      return n.endsWith('.md') || (includeMdx && n.endsWith('.mdx'));
    });

  if (!files.length) {
    console.log(
      pc.yellow(
        'No .md files found in source (use --include-mdx to include .mdx).'
      )
    );
    process.exit(0);
  }

  // ensure output destinations exist
  await fs.mkdir(OUT_DIR, { recursive: true });
  if (COPY_DIR) await fs.mkdir(COPY_DIR, { recursive: true });

  // reset _log.csv at start
  await writeLogHeader(LOG_PATH);

  let failedCount = 0;

  for (const rel of files) {
    try {
      const abs = path.join(SRC_DIR, rel);
      const raw = await fs.readFile(abs, 'utf8');

      // 0) Collect image URLs directly from source text (regex sweep)
      const preCollectedImages = collectInlineImageUrlsFromText(raw);

      // 1) Parse frontmatter
      const fm = matter(raw);
      const customerFM = fm.data ?? {};
      const content = fm.content ?? '';

      // 2) Title
      const title = deriveTitle(customerFM, content, CONFIG);

      // 3) ReadMe FM
      const readmeFM = buildReadmeFM(customerFM, title, CONFIG);

      // 4) Transform → sanitize, collect images, convert HTML → Markdown
      const warnings = [];
      const htmlToMdStrips = [];
      const imageUrls = [...preCollectedImages]; // seed with regex-found
      const jsRemoved = []; // JavaScript we strip (scripts, handlers)
      const mdxRemoved = []; // MDX/JSX components that won’t survive

      const toMarkdown = unified()
        // Parse markdown (+ GFM)
        .use(remarkParse)
        .use(remarkGfm)

        // Fix MDX-unsafe comments/bang tags in mdast
        .use(mdFixBangAndHtmlComments)

        // Collect markdown images (mdast `image` nodes)
        .use(remarkCollectMarkdownImages, { images: imageUrls })

        // Collect any MDX/JSX elements (so we can log them as removed)
        .use(remarkCollectMdxComponents, { removed: mdxRemoved })

        // Allow MDX syntax (we’ll still emit .md filenames)
        .use(remarkMdx)
        .use(remarkFrontmatter, ['yaml'])

        // Move to HTML (hast), allow raw HTML
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(rehypeRaw)

        // Unwrap neutral containers so inner headings/lists convert cleanly
        .use(rehypeUnwrapNeutralContainers)

        // Flatten links (HTML <a> and React <Link>) to plain text
        .use(rehypeFlattenLinksToText)

        // Collect <img> sources and src={useBaseUrl("...")} from HTML/JSX
        .use(rehypeCollectImgSources, { images: imageUrls })

        // Sanitize disallowed JS and *record* what we strip
        .use(rehypeDisallowAndReplaceJS, { warnings, jsRemoved })

        // Convert HTML → Markdown AST (headings, strong/em, lists, paras, hr/br)
        .use(rehypeRemark, {
          handlers: {
            br() {
              return { type: 'break' };
            },
            hr() {
              return { type: 'thematicBreak' };
            },
            // Ensure <b> maps to strong (some HTML uses <b>)
            b(h, node) {
              return h(node, 'strong', { children: allTextChildren(node) });
            },
          },
        })

        // Strip any residual HTML nodes that couldn’t be bridged
        .use(remarkRemoveResidualHtml, { strips: htmlToMdStrips })

        // Stringify back to Markdown
        .use(remarkStringify, {
          bullet: '-',
          fences: true,
          listItemIndent: 'one',
          rule: '-',
        });

      const vf = await toMarkdown.process(content);
      let mdxBody = String(vf);

      // 4.5) Strip top-of-body import statements; record as removed code
      const importRegex = /^(?:\s*import\s.+\n)+/; // strictly at top
      const importMatches = mdxBody.match(importRegex) || [];
      mdxBody = mdxBody.replace(importRegex, '');
      if (importMatches.length) {
        await appendToLog('REMOVED_IMPORTS', rel, '', importMatches, []);
      }

      // Log any residual HTML that had to be stripped to plaintext
      if (htmlToMdStrips.length) {
        await appendToLog(
          'STRIPPED_HTML',
          rel,
          htmlToMdStrips.join('\n---\n'),
          [],
          []
        );
      }

      // Log any *removed JS* (scripts + inline handlers)
      if (jsRemoved.length) {
        await appendToLog('REMOVED_JS', rel, '', jsRemoved, []);
      }

      // Log any MDX/JSX components we saw (treated as "removed")
      if (mdxRemoved.length) {
        await appendToLog('REMOVED_MDX', rel, '', mdxRemoved, []);
      }

      // Log any images found (dedup)
      const uniqueImages = Array.from(new Set(imageUrls)).filter(Boolean);
      if (uniqueImages.length) {
        await appendToLog('IMAGES', rel, '', [], uniqueImages);
      }

      // 5) Prepend ReadMe YAML FM
      const readmeYaml = yaml.dump(readmeFM, { lineWidth: 0 });
      const final = `---\n${readmeYaml}---\n\n${mdxBody}`.trim() + '\n';

      // 6) Always write with .md extension
      const outRel = rel.replace(/\.(mdx|md)$/i, '.md');
      const outAbs = path.join(OUT_DIR, outRel);
      await fs.mkdir(path.dirname(outAbs), { recursive: true });
      await fs.writeFile(outAbs, final, 'utf8');

      // 7) Optional copy destination (e.g., your GitHub-synced project)
      if (COPY_DIR) {
        const copyAbs = path.join(COPY_DIR, outRel);
        await fs.mkdir(path.dirname(copyAbs), { recursive: true });
        await fs.writeFile(copyAbs, final, 'utf8');
      }

      report.files.push({
        file: rel,
        output: path.relative(process.cwd(), outAbs),
        copiedTo: COPY_DIR
          ? path.relative(process.cwd(), path.join(COPY_DIR, outRel))
          : null,
        title: readmeFM.title ?? null,
        warnings,
        images: uniqueImages,
      });

      const w = warnings.length
        ? pc.yellow(` (${warnings.length} warnings)`)
        : pc.green(' ✓');
      console.log(pc.cyan('Converted:'), rel, '→', outRel, w);
    } catch (err) {
      failedCount++;
      console.warn(pc.red(`Failed:`), rel);
      console.warn(pc.gray(String(err && (err.stack || err.message || err))));
      await appendToLog(
        'FAILED',
        rel,
        String(err && (err.stack || err.message || err)),
        [],
        []
      );
      continue; // proceed to next file
    }
  }

  // Ensure index.md exists with title = EXACT parent directory name
  await ensureIndexMdIfMissing(OUT_DIR);
  if (COPY_DIR) await ensureIndexMdIfMissing(COPY_DIR);

  // Update _order.yaml if present (OUT_DIR and COPY_DIR)
  await updateOrderYamlIfExists(OUT_DIR);
  if (COPY_DIR) await updateOrderYamlIfExists(COPY_DIR);

  const reportPath = path.join(OUT_DIR, 'migration-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(pc.magenta(`\nReport: ${reportPath}`));
  console.log(pc.magenta(`Log:    ${LOG_PATH}`));
  if (failedCount) {
    console.log(
      pc.red(`Completed with ${failedCount} failed file(s). See _log.csv.`)
    );
  } else {
    console.log(pc.green('Completed with no failures.'));
  }
})().catch(async err => {
  try {
    await appendToLog(
      'FATAL',
      '(script)',
      String(err && (err.stack || err.message || err)),
      [],
      []
    );
  } catch {}
  console.error(pc.red(err.stack || String(err)));
  process.exit(1);
});

/* ---------------- helpers ---------------- */

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
function sanitizeDir(name) {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'output';
}

async function loadConfig(p) {
  if (!p) {
    return {
      defaultReadmeFrontmatter: {
        deprecated: false,
        hidden: false,
        metadata: { robots: 'index' },
      },
      titleFrom: ['sidebar_label', 'h1'],
      replacements: [],
    };
  }
  const abs = path.resolve(p);
  const raw = await fs.readFile(abs, 'utf8');
  return JSON.parse(raw);
}

function deriveTitle(customerFM, content, CONFIG) {
  for (const pref of CONFIG.titleFrom || []) {
    if (pref === 'sidebar_label' && customerFM.sidebar_label)
      return String(customerFM.sidebar_label);
    if (pref === 'title' && customerFM.title) return String(customerFM.title);
    if (pref === 'h1') {
      const m = content.match(/^\s*#\s+(.+?)\s*$/m);
      if (m) return m[1].trim();
    }
  }
  return customerFM.sidebar_label || customerFM.title || 'Untitled';
}

function buildReadmeFM(customerFM, title, CONFIG) {
  const base = { title, ...CONFIG.defaultReadmeFrontmatter };
  const meta = base.metadata || {};
  if (customerFM.sidebar_position != null)
    meta.sidebar_position = customerFM.sidebar_position;
  if (customerFM.sidebar_label) meta.sidebar_label = customerFM.sidebar_label;
  base.metadata = meta;
  return base;
}

// Fix HTML comments and <! ... > sequences that MDX dislikes (mdast stage)
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
          node.value = v.replace(/^</, '&lt;'); // escape e.g., <!DOCTYPE>
        }
      }
    });
  };
}

// Collect markdown images (mdast `image` nodes)
function remarkCollectMarkdownImages({ images = [] } = {}) {
  return tree => {
    visit(tree, 'image', node => {
      if (node && typeof node.url === 'string' && node.url.trim()) {
        images.push(node.url.trim());
      }
    });
  };
}

// Collect MDX/JSX elements so we can report them as "removed"
function remarkCollectMdxComponents({ removed = [] } = {}) {
  return tree => {
    visit(tree, node => {
      if (
        node.type === 'mdxJsxFlowElement' ||
        node.type === 'mdxJsxTextElement'
      ) {
        const name = node.name || '<unnamed>';
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

// Unwrap neutral containers so nested headings/lists convert to MD cleanly
function rehypeUnwrapNeutralContainers() {
  const neutral = new Set(['div', 'section', 'article']);
  return tree => {
    visit(tree, 'element', (node, index, parent) => {
      if (!parent) return;
      if (neutral.has(node.tagName)) {
        const children = node.children || [];
        parent.children.splice(index, 1, ...children);
      }
    });
  };
}

// Flatten HTML <a> and React <Link> to plain text (keep inner content)
function rehypeFlattenLinksToText() {
  return tree => {
    visit(tree, (node, index, parent) => {
      if (!parent || index == null) return;

      // HTML <a>
      if (node.type === 'element' && node.tagName === 'a') {
        const kids = node.children || [];
        parent.children.splice(index, 1, ...kids);
        return;
      }

      // MDX JSX <Link> … </Link> or <Link />
      if (
        (node.type === 'mdxJsxFlowElement' ||
          node.type === 'mdxJsxTextElement') &&
        node.name === 'Link'
      ) {
        const kids = node.children || [];
        parent.children.splice(index, 1, ...kids);
        return;
      }
    });
  };
}

// Collect <img> sources and src={useBaseUrl("...")} (hast stage)
function rehypeCollectImgSources({ images = [] } = {}) {
  return tree => {
    visit(tree, node => {
      if (node && node.type === 'element' && node.tagName === 'img') {
        const src = node.properties && node.properties.src;
        if (typeof src === 'string' && src.trim()) {
          images.push(src.trim());
        } else if (
          src &&
          typeof src === 'object' &&
          src.type === 'mdxJsxAttributeValueExpression'
        ) {
          const m = /useBaseUrl\(\s*(['"])(.*?)\1\s*\)/.exec(src.value || '');
          if (m && m[2]) images.push(m[2].trim());
        }
      }
      // Also catch MDX JSX elements like <Image src={useBaseUrl("...")} />
      if (
        (node && node.type === 'mdxJsxFlowElement') ||
        (node && node.type === 'mdxJsxTextElement')
      ) {
        const attrs = node.attributes || [];
        for (const a of attrs) {
          if (a.name === 'src') {
            if (typeof a.value === 'string') {
              images.push(a.value.trim());
            } else if (
              a.value &&
              typeof a.value === 'object' &&
              a.value.type === 'mdxJsxAttributeValueExpression'
            ) {
              const m = /useBaseUrl\(\s*(['"])(.*?)\1\s*\)/.exec(
                a.value.value || ''
              );
              if (m && m[2]) images.push(m[2].trim());
            }
          }
        }
      }
    });
  };
}

// Strip/replace disallowed JS and warn on risky embeds (hast stage)
// Also RECORD what was removed into jsRemoved[]
function rehypeDisallowAndReplaceJS({ warnings = [], jsRemoved = [] } = {}) {
  return tree => {
    visit(tree, node => {
      // <script>...</script> or <script src="...">
      if (node.type === 'element' && node.tagName === 'script') {
        const hasSrc = node.properties && node.properties.src;
        const jsCode = extractText(node).trim();
        if (hasSrc) jsRemoved.push(`SCRIPT SRC: ${node.properties.src}`);
        if (jsCode) jsRemoved.push(`SCRIPT INLINE CODE:\n${jsCode}`);
        warnings.push({
          type: 'script',
          message: hasSrc
            ? `Removed <script src="${node.properties.src}"> (not allowed in ReadMe docs)`
            : 'Removed inline <script> (not allowed in ReadMe docs)',
        });
        node.type = 'raw';
        node.value = [
          '\n{/* ❗ Script removed: replace with an MDX component. */}\n',
          jsCode ? '```js\n' + jsCode + '\n```\n' : '',
        ].join('');
        node.tagName = undefined;
        node.children = undefined;
        node.properties = undefined;
        return;
      }

      // Warn for iframes
      if (node.type === 'element' && node.tagName === 'iframe') {
        warnings.push({
          type: 'iframe',
          message: 'Found <iframe>. ReadMe may sanitize/block embeds.',
        });
      }

      // Remove inline event handlers like onClick, onload, etc. and RECORD them
      if (node.type === 'element' && node.properties) {
        const toRemove = [];
        const removedDetail = [];
        for (const [k, v] of Object.entries(node.properties)) {
          if (/^on[A-Z]/.test(k)) {
            toRemove.push(k);
            let val = '';
            if (typeof v === 'string') val = v;
            else if (Array.isArray(v)) val = v.join(' ');
            else if (v && typeof v === 'object' && 'value' in v)
              val = String(v.value || '');
            removedDetail.push(
              `${k}=${val ? JSON.stringify(val) : '(handler)'}`
            );
          }
        }
        if (toRemove.length) {
          toRemove.forEach(k => delete node.properties[k]);
          jsRemoved.push(
            `INLINE HANDLERS on <${node.tagName}>: ${removedDetail.join(', ')}`
          );
          warnings.push({
            type: 'inline-handler',
            message: `Removed inline handlers (${toRemove.join(', ')}) from <${
              node.tagName
            }>`,
          });
        }
      }
    });
  };
}
function extractText(node) {
  if (!node || !node.children) return '';
  let out = '';
  for (const c of node.children) {
    if (c.type === 'text') out += c.value;
    else if (c.children) out += extractText(c);
  }
  return out;
}

// helper to build strong node children for <b>
function allTextChildren(node) {
  const children = [];
  (node.children || []).forEach(c => {
    if (c.type === 'text') children.push(c);
    else if (c.children) children.push(...allTextChildren(c));
  });
  return children;
}

// After HTML→Markdown bridge, remove any leftover 'html' nodes (mdast stage)
function remarkRemoveResidualHtml({ strips = [] } = {}) {
  return tree => {
    visit(tree, 'html', (node, index, parent) => {
      if (!parent) return;
      const original = String(node.value || '');
      const text = original.replace(/<[^>]+>/g, ''); // strip tags to plaintext
      strips.push(original.trim());
      parent.children[index] = { type: 'text', value: text };
    });
  };
}

/* ---------- index.md creator ---------- */
async function ensureIndexMdIfMissing(dir) {
  const indexPath = path.join(dir, 'index.md');
  try {
    await fs.access(indexPath);
    return; // already exists
  } catch {}

  // Title = EXACT parent directory name (no transformation)
  const title = path.basename(dir);

  const fm = {
    title,
    deprecated: false,
    hidden: false,
    metadata: { robots: 'index' },
  };
  const yamlStr = yaml.dump(fm, { lineWidth: 0 });
  const body = `---\n${yamlStr}---\n`;
  await fs.writeFile(indexPath, body, 'utf8');
  console.log(pc.blue(`Created index.md in ${dir} (title: "${title}")`));
}

/* ---------- _order.yaml updater ---------- */
async function updateOrderYamlIfExists(dir) {
  const orderPath = path.join(dir, '_order.yaml');
  try {
    await fs.access(orderPath); // exists?
  } catch {
    return; // do nothing if it doesn't exist
  }

  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const items = dirents
    .filter(d => {
      const name = d.name;
      if (name === '_order.yaml') return false;
      if (name === '_log.csv') return false;
      if (name === 'migration-report.json') return false;
      if (name.toLowerCase() === 'index.md') return false; // exclude index.md from order
      if (name.startsWith('.')) return false;
      if (name.startsWith('_')) return false; // skip other underscore files
      if (d.isDirectory()) return true;
      if (d.isFile() && path.extname(name).toLowerCase() === '.md') return true;
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

/* ---------- CSV logging helpers ---------- */
async function writeLogHeader(logPath) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const header = `Type,File,Error Message,Removed Code,Missing Images\n`;
  await fs.writeFile(logPath, header, 'utf8');
}
async function appendToLog(
  type,
  file,
  errorMsg,
  removedCodeArr,
  missingImagesArr
) {
  const safe = val => {
    if (val == null) return '';
    let s = String(val).replace(/"/g, '""'); // escape quotes
    if (/[",\n]/.test(s)) s = `"${s}"`;
    return s;
  };
  const removed = Array.isArray(removedCodeArr)
    ? removedCodeArr.join('\n---\n')
    : '';
  const imgs = Array.isArray(missingImagesArr)
    ? missingImagesArr.join('\n')
    : '';
  const row = `${safe(type)},${safe(file)},${safe(errorMsg)},${safe(
    removed
  )},${safe(imgs)}\n`;
  await fs.appendFile(LOG_PATH, row, 'utf8');
}

/* ---------- lightweight text sweep for image URLs ---------- */
function collectInlineImageUrlsFromText(source) {
  const urls = new Set();

  // Markdown image: ![alt](url "title")
  const mdImg = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^")]+["'])?\)/g;
  for (const m of source.matchAll(mdImg)) {
    if (m[1]) urls.add(m[1].trim());
  }

  // HTML <img src="..."> or '...'
  const htmlImg = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const m of source.matchAll(htmlImg)) {
    if (m[1]) urls.add(m[1].trim());
  }

  // Any useBaseUrl("...") or useBaseUrl('...')
  const useBase = /useBaseUrl\(\s*(['"])(.*?)\1\s*\)/g;
  for (const m of source.matchAll(useBase)) {
    if (m[2]) urls.add(m[2].trim());
  }

  return Array.from(urls);
}
