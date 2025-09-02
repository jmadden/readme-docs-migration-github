import { visit } from 'unist-util-visit';

export function remarkStripScriptsAndHandlers({
  jsRemoved = [],
  warnings = [],
} = {}) {
  return tree => {
    visit(tree, 'html', node => {
      if (!node || typeof node.value !== 'string') return;
      let html = node.value;

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

      html = html.replace(
        /(<[A-Za-z][^>]*?)\s+on[A-Z][A-Za-z]+\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/g,
        (m, start) => {
          jsRemoved.push(`INLINE HANDLER removed in: ${truncate(start, 80)}`);
          warnings.push({
            type: 'inline-handler',
            message: 'Removed inline event handler',
          });
          return start;
        }
      );

      node.value = html;
    });
  };
}

export function mdFixBangAndHtmlComments() {
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

function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
