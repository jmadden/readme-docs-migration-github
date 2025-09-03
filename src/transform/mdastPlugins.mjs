// src/transform/mdastPlugins.mjs
import { visit } from 'unist-util-visit';

/* -------------------------------------------------------------------------- */
/*  Collect markdown image URLs from mdast `image` nodes                       */
/* -------------------------------------------------------------------------- */
export function remarkCollectMarkdownImages({ images = [] } = {}) {
  return (tree) => {
    visit(tree, 'image', (node) => {
      if (node && typeof node.url === 'string' && node.url.trim()) {
        images.push(node.url.trim());
      }
    });
  };
}

/* -------------------------------------------------------------------------- */
/*  Replace <ImageZoom ...> with "**MISSING IMAGE!** /path" and collect paths  */
/* -------------------------------------------------------------------------- */
export function remarkReplaceImageZoom({ imageUrls = [] } = {}) {
  return (tree) => {
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
              typeof a.value === 'object' &&
              a.value.type === 'mdxJsxAttributeValueExpression'
            ) {
              const m = /useBaseUrl\(\s*(['"])(.*?)\1\s*\)/.exec(a.value.value || '');
              if (m && m[2]) foundPath = m[2].trim();
            }
          }
        }
        if (foundPath) imageUrls.push(foundPath);

        const replacement = {
          type: 'paragraph',
          children: [
            { type: 'strong', children: [{ type: 'text', value: 'MISSING IMAGE!' }] },
            { type: 'text', value: ` ${foundPath}` },
          ],
        };
        parent.children.splice(index, 1, replacement);
      }
    });
  };
}

/* -------------------------------------------------------------------------- */
/*  Fix MDX-unsafe comments and declarations like <!-- ... --> or <!doctype>   */
/* -------------------------------------------------------------------------- */
export function mdFixBangAndHtmlComments() {
  return (tree) => {
    visit(tree, (node) => {
      if (node.type === 'html' && typeof node.value === 'string') {
        const v = node.value;
        // Convert HTML comments to MDX comments
        if (/^\s*<!--/.test(v) && /-->\s*$/.test(v)) {
          node.type = 'mdxFlowExpression';
          node.value = `{/*${v.replace(/^\s*<!--\s*/, '').replace(/\s*-->\s*$/, '')}*/}`;
        } else if (/^\s*<![^-]/.test(v)) {
          // Escape leading '<!' to avoid MDX parser issues
          node.value = v.replace(/^</, '&lt;');
        }
      }
    });
  };
}

/* -------------------------------------------------------------------------- */
/*  Strip <script>…</script> & inline JSX/HTML event handlers; log removals    */
/* -------------------------------------------------------------------------- */
export function remarkStripScriptsAndHandlers({ jsRemoved = [], warnings = [] } = {}) {
  return (tree) => {
    visit(tree, 'html', (node) => {
      if (!node || typeof node.value !== 'string') return;
      let html = node.value;

      // Remove <script ...>...</script>
      html = html.replace(
        /<\s*script\b([^>]*)>([\s\S]*?)<\s*\/\s*script\s*>/gi,
        (_, attrs, code) => {
          const srcMatch = attrs && attrs.match(/\bsrc\s*=\s*(['"])(.*?)\1/i);
          if (srcMatch && srcMatch[2]) {
            jsRemoved.push(`SCRIPT SRC: ${srcMatch[2]}`);
            warnings.push({ type: 'script', message: `Removed <script src="${srcMatch[2]}">` });
          } else if (code && code.trim()) {
            jsRemoved.push(`SCRIPT INLINE CODE:\n${code.trim()}`);
            warnings.push({ type: 'script', message: 'Removed inline <script>' });
          } else {
            warnings.push({ type: 'script', message: 'Removed <script>' });
          }
          return '\n{/* ❗ Script removed: replace with an MDX component. */}\n';
        },
      );

      // Remove inline event handlers (onClick=, onChange=, etc.) but keep tag
      html = html.replace(
        /(<[A-Za-z][^>]*?)\s+on[A-Z][A-Za-z]+\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/g,
        (m, start) => {
          jsRemoved.push(`INLINE HANDLER removed in: ${truncate(start, 80)}`);
          warnings.push({ type: 'inline-handler', message: 'Removed inline event handler' });
          return start;
        },
      );

      node.value = html;
    });
  };
}

/* -------------------------------------------------------------------------- */
/*  Convert a safe subset of raw HTML → Markdown (keep tables/JSX as-is)       */
/* -------------------------------------------------------------------------- */
export function remarkConvertSelectedHtmlToMd(options = {}) {
  const { keepHtmlIf, recordRaw } = options;
  return (tree) => {
    visit(tree, 'html', (node, index, parent) => {
      if (!parent || index == null) return;
      const raw = String(node.value || '');

      if (typeof keepHtmlIf === 'function' && keepHtmlIf(raw)) return;

      const html = raw.replace(/\r\n?/g, '\n');
      let changed = false;
      let out = html;

      // h1..h6
      out = out.replace(/<\s*h([1-6])\s*>\s*([\s\S]*?)\s*<\s*\/\s*h\1\s*>\s*/gi, (_, n, inner) => {
        changed = true;
        return `${'#'.repeat(Number(n))} ${stripTags(inner).trim()}\n\n`;
      });

      // p
      out = out.replace(/<\s*p\s*>\s*([\s\S]*?)\s*<\s*\/\s*p\s*>\s*/gi, (_, inner) => {
        changed = true;
        return `${stripTags(inner).trim()}\n\n`;
      });

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
        },
      );

      // em/i
      out = out.replace(
        /<\s*(i|em)\s*>\s*([\s\S]*?)\s*<\s*\/\s*(i|em)\s*>\s*/gi,
        (_, _t1, inner) => {
          changed = true;
          return `*${stripTags(inner).trim()}*`;
        },
      );

      // ul > li
      out = out.replace(/<\s*ul\s*>\s*([\s\S]*?)\s*<\s*\/\s*ul\s*>\s*/gi, (_, inner) => {
        const items = Array.from(inner.matchAll(/<\s*li\s*>\s*([\s\S]*?)\s*<\s*\/\s*li\s*>/gi)).map(
          (m) => m[1],
        );
        if (!items.length) return _;
        changed = true;
        return items.map((it) => `- ${stripTags(it).trim()}`).join('\n') + '\n\n';
      });

      // ol > li
      out = out.replace(/<\s*ol\s*>\s*([\s\S]*?)\s*<\s*\/\s*ol\s*>\s*/gi, (_, inner) => {
        const items = Array.from(inner.matchAll(/<\s*li\s*>\s*([\s\S]*?)\s*<\s*\/\s*li\s*>/gi)).map(
          (m) => m[1],
        );
        if (!items.length) return _;
        changed = true;
        return items.map((it, i) => `${i + 1}. ${stripTags(it).trim()}`).join('\n') + '\n\n';
      });

      if (!changed) return;
      if (typeof recordRaw === 'function') recordRaw(raw);

      parent.children.splice(index, 1, { type: 'text', value: out });
    });
  };
}

/* --------------------------------- utils ---------------------------------- */

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '');
}

function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
