import { visit } from 'unist-util-visit';

export function remarkConvertSelectedHtmlToMd(options = {}) {
  const { keepHtmlIf, recordRaw } = options;
  return tree => {
    visit(tree, 'html', (node, index, parent) => {
      if (!parent || index == null) return;
      const raw = String(node.value || '');
      if (typeof keepHtmlIf === 'function' && keepHtmlIf(raw)) return;

      const html = raw.replace(/\r\n?/g, '\n');
      let changed = false;
      let out = html;

      out = out.replace(
        /<\s*h([1-6])\s*>\s*([\s\S]*?)\s*<\s*\/\s*h\1\s*>\s*/gi,
        (_, n, inner) => {
          changed = true;
          return `${'#'.repeat(Number(n))} ${stripTags(inner).trim()}\n\n`;
        }
      );

      out = out.replace(
        /<\s*p\s*>\s*([\s\S]*?)\s*<\s*\/\s*p\s*>\s*/gi,
        (_, inner) => {
          changed = true;
          return `${stripTags(inner).trim()}\n\n`;
        }
      );

      out = out.replace(/<\s*br\s*\/?\s*>\s*/gi, () => {
        changed = true;
        return '  \n';
      });

      out = out.replace(
        /<\s*(b|strong)\s*>\s*([\s\S]*?)\s*<\s*\/\s*(b|strong)\s*>\s*/gi,
        (_, _t1, inner) => {
          changed = true;
          return `**${stripTags(inner).trim()}**`;
        }
      );

      out = out.replace(
        /<\s*(i|em)\s*>\s*([\s\S]*?)\s*<\s*\/\s*(i|em)\s*>\s*/gi,
        (_, _t1, inner) => {
          changed = true;
          return `*${stripTags(inner).trim()}*`;
        }
      );

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
