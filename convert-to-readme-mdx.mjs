#!/usr/bin/env node
/**
 * Recursive MD → ReadMe-ready Markdown converter with:
 *  - Frontmatter mapping to ReadMe's FM
 *  - Robust :::note / :::tip → <Callout> pre-pass
 *  - MD-only pipeline (no rehype) so JSX & HTML tables survive
 *  - <ImageZoom> → **MISSING IMAGE!** /path
 *  - Tabs (Docusaurus) → Tabs/Tab post-process (textual)
 *  - Strip <script> and inline handlers (onClick, etc.) from raw HTML blocks; log removals
 *  - Single consolidated _log.csv + migration-report.json at destination root
 *  - index.md creation & _order.yaml update (if present) across all created folders
 *
 * Usage:
 *   node convert-to-readme-mdx.mjs \
 *     --cwd "/path/to/src-root" \
 *     --src . \
 *     --out "/path/to/dest-root" \
 *     [--include-mdx] [--copy "/optional/second/dest"]
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

await fs.mkdir(DEST_ROOT, { recursive: true });
if (COPY_ROOT) await fs.mkdir(COPY_ROOT, { recursive: true });

const LOG_PATH = path.join(DEST_ROOT, '_log.csv');
await writeLogHeader(LOG_PATH);
const REPORT_PATH = path.join(DEST_ROOT, 'migration-report.json');

const report = {
  startedAt: new Date().toISOString(),
  cwd: process.cwd(),
  srcRoot: SRC_ROOT,
  destRoot: DEST_ROOT,
  copyRoot: COPY_ROOT,
  files: [],
};

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

    // Pre-pass: :::note / :::tip → <Callout>
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

    // Build ReadMe frontmatter
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

      // Handle <ImageZoom> in mdast (replace with "MISSING IMAGE!")
      .use(remarkReplaceImageZoom, { imageUrls })

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
    const uniqueImages = Array.from(new Set(imageUrls)).filter(Boolean);
    if (uniqueImages.length) {
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

/* ---------- Pre-pass: :::note / :::tip → <Callout> ---------- */

function convertNoteTipBlocks(text) {
  const noteRe = /^:::note[^\n]*\n([\s\S]*?)\n:::\s*$/gim;
  const tipRe = /^:::tip[^\n]*\n([\s\S]*?)\n:::\s*$/gim;

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
    } else {
      return [
        `<Callout icon="👍" theme="okay">`,
        `  Tip`,
        ``,
        indentBlock(body, '  '),
        `</Callout>`,
      ].join('\n');
    }
  };

  let out = text.replace(tipRe, (_, inner) => toCallout(inner, 'tip'));
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
  return markdown.replace(
    /<Tabs\b([^>]*)>([\s\S]*?)<\/Tabs>/g,
    (whole, attrs, inner) => {
      const valuesMatch =
        attrs && attrs.match(/values\s*=\s*\{\s*\[([\s\S]*?)\]\s*\}/);
      const valuesSrc = valuesMatch ? valuesMatch[1] : '';
      const items = (valuesSrc.match(/\{[^}]*\}/g) || []).map(it => {
        const label = (it.match(/label\s*:\s*(['"])(.*?)\1/) || [])[2] || '';
        const value = (it.match(/value\s*:\s*(['"])(.*?)\1/) || [])[2] || '';
        return { label, value };
      });
      const labelByValue = new Map(
        items.map(({ label, value }) => [value, label || value || 'Tab'])
      );

      const tabs = [];
      inner.replace(
        /<TabItem\b([^>]*)>([\s\S]*?)<\/TabItem>/g,
        (m, tabAttrs, tabBody) => {
          let value = '';
          const mVal = tabAttrs && tabAttrs.match(/value\s*=\s*(['"])(.*?)\1/);
          if (mVal) value = mVal[2];
          const title = labelByValue.get(value) || value || 'Tab';
          const body = tabBody.trim();
          tabs.push(
            [
              `  <Tab title="${escapeAttr(title)}">`,
              indentBlock(body, '   '),
              `  </Tab>`,
            ].join('\n')
          );
          return m;
        }
      );

      if (!tabs.length) {
        return `<Tabs>\n${inner}\n</Tabs>`;
      }
      return [`<Tabs>`, tabs.join('\n\n'), `</Tabs>`].join('\n');
    }
  );
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

// Replace <ImageZoom …> with "**MISSING IMAGE!** /path"
function remarkReplaceImageZoom({ imageUrls = [] } = {}) {
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
          type: 'paragraph',
          children: [
            {
              type: 'strong',
              children: [{ type: 'text', value: 'MISSING IMAGE!' }],
            },
            { type: 'text', value: ` ${foundPath}` },
          ],
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
  return Array.from(urls);
}

function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
