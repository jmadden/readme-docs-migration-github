import { visit } from 'unist-util-visit';

export function remarkReplaceImageZoomWithPlaceholder({ imageUrls = [] } = {}) {
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
        parent.children.splice(index, 1, {
          type: 'html',
          value: `<!--IMAGE_PLACEHOLDER:${foundPath}-->`,
        });
      }
    });
  };
}
