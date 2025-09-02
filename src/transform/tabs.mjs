import { indentBlock } from './callouts.mjs';

/**
 * Convert Docusaurus-style Tabs into ReadMe-compatible <Tabs><Tab title="...">…</Tab></Tabs>.
 * - Supports values=[{label: '…' | JSX, value: '…'}, …]
 * - Uses <TabItem value="…"> content; resolves title from label (fallback to value).
 */
export function transformDocusaurusTabsToTarget(markdownText) {
  return markdownText.replace(/<Tabs\b[\s\S]*?<\/Tabs>/g, (originalTabsBlock) => {
    const { valuesArraySource, openingTagEndIndex } =
      extractValuesArrayFromOpeningTag(originalTabsBlock);

    const labelByValue = buildLabelMap(valuesArraySource);

    const innerStartIndex =
      openingTagEndIndex > -1 ? openingTagEndIndex + 1 : originalTabsBlock.indexOf('>') + 1;
    const innerEndIndex = originalTabsBlock.lastIndexOf('</Tabs>');
    const innerContent =
      innerEndIndex > innerStartIndex
        ? originalTabsBlock.slice(innerStartIndex, innerEndIndex)
        : '';

    const renderedTabs = [];
    innerContent.replace(
      /<TabItem\b([^>]*)>([\s\S]*?)<\/TabItem>/g,
      (whole, tabItemAttributes, tabItemBody) => {
        const valueAttr = getAttr(tabItemAttributes, 'value'); // supports "v", 'v', {v}
        const rawLabel = getAttr(tabItemAttributes, 'label'); // may be JSX
        const preferredTitleSource = rawLabel || (valueAttr && labelByValue.get(valueAttr)) || '';
        const title = sanitizeLabel(preferredTitleSource, valueAttr || 'Tab');
        const body = tabItemBody.trim();

        renderedTabs.push(
          [
            `  <Tab title="${escapeHtmlAttribute(title)}">`,
            indentBlock(body, '   '),
            `  </Tab>`,
          ].join('\n'),
        );
        return whole;
      },
    );

    if (!renderedTabs.length) return originalTabsBlock;
    return ['<Tabs>', renderedTabs.join('\n\n'), '</Tabs>'].join('\n');
  });
}

/**
 * Pull out the `values={[ ... ]}` from the opening <Tabs ...> tag,
 * even when labels contain JSX (by balancing braces).
 */
function extractValuesArrayFromOpeningTag(tabsBlock) {
  const openingStart = tabsBlock.indexOf('<Tabs');
  if (openingStart === -1) {
    return { valuesArraySource: '', openingTagEndIndex: tabsBlock.indexOf('>') };
  }

  const valuesIndex = tabsBlock.indexOf('values', openingStart);
  let openingTagEndIndex = tabsBlock.indexOf('>');
  if (valuesIndex === -1) return { valuesArraySource: '', openingTagEndIndex };

  const braceStartIndex = tabsBlock.indexOf('{', valuesIndex);
  if (braceStartIndex === -1) return { valuesArraySource: '', openingTagEndIndex };

  // Balance the braces after "values="
  let i = braceStartIndex;
  let depth = 0;
  for (; i < tabsBlock.length; i++) {
    const ch = tabsBlock[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const braceEndIndex = i;

  // True end of the opening tag is the first '>' after the closing '}'
  openingTagEndIndex = tabsBlock.indexOf('>', braceEndIndex);

  const insideBraces = tabsBlock.slice(braceStartIndex + 1, braceEndIndex); // typically: [ {…}, {…} ]
  const leftBracket = insideBraces.indexOf('[');
  const rightBracket = insideBraces.lastIndexOf(']');
  const valuesArraySource =
    leftBracket !== -1 && rightBracket !== -1 && rightBracket > leftBracket
      ? insideBraces.slice(leftBracket + 1, rightBracket)
      : insideBraces;

  return { valuesArraySource, openingTagEndIndex };
}

/**
 * Build a map of `value -> label` from the values array source string.
 * Supports quoted, brace-wrapped, and JSX labels (e.g., <center>Title</center>).
 */
function buildLabelMap(valuesArraySource) {
  const map = new Map();
  const objects = extractTopLevelObjects(valuesArraySource);

  for (const objectSource of objects) {
    const value =
      (/[\s,{]value\s*:\s*(['"])([\s\S]*?)\1/.exec(objectSource) || [])[2] ||
      (/[\s,{]value\s*:\s*\{([\s\S]*?)\}/.exec(objectSource) || [])[1] ||
      (/[\s,{]value\s*:\s*([^\s,}]+)/.exec(objectSource) || [])[1] ||
      '';

    if (!value) continue;

    let rawLabel =
      (/[\s,{]label\s*:\s*(['"])([\s\S]*?)\1/.exec(objectSource) || [])[2] ||
      (/[\s,{]label\s*:\s*\{([\s\S]*?)\}/.exec(objectSource) || [])[1] ||
      (/[\s,{]label\s*:\s*([\s\S]*?)(?:,|})/.exec(objectSource) || [])[1] ||
      '';

    rawLabel = stripWrappingDelimiters(rawLabel);
    const cleaned = sanitizeLabel(rawLabel, value);
    map.set(value, cleaned);
  }

  return map;
}

function extractTopLevelObjects(source) {
  const results = [];
  let depth = 0;
  let startIndex = -1;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      if (depth === 0) startIndex = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && startIndex >= 0) {
        results.push(source.slice(startIndex, i + 1));
        startIndex = -1;
      }
    }
  }

  if (!results.length) {
    const lax = /\{[\s\S]*?\}/g;
    let match;
    while ((match = lax.exec(source)) !== null) results.push(match[0]);
  }
  return results;
}

function getAttr(attributeString, name) {
  if (!attributeString) return '';
  let m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attributeString);
  if (m) return m[1].trim();
  m = new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(attributeString);
  if (m) return m[1].trim();
  m = new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`).exec(attributeString);
  if (m) return m[1].trim();
  return '';
}

function stripWrappingDelimiters(text) {
  let s = String(text || '').trim();
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1).trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function sanitizeLabel(raw, fallback = '') {
  const withoutTags = String(raw || '')
    .replace(/<[^>]+>/g, '')
    .trim();
  return withoutTags || fallback;
}

function escapeHtmlAttribute(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
