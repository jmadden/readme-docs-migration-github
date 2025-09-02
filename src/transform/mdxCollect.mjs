import { visit } from 'unist-util-visit';

export function remarkCollectMarkdownImages({ images = [] } = {}) {
  return tree => {
    visit(tree, 'image', node => {
      if (node && typeof node.url === 'string' && node.url.trim())
        images.push(node.url.trim());
    });
  };
}

export function remarkCollectMdxComponentsComponentLike({ removed = [] } = {}) {
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
