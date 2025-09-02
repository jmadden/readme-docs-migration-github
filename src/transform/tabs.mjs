import { indentBlock } from './callouts.mjs';

export function transformDocusaurusTabsToTarget(markdown) {
  return markdown.replace(/<Tabs\b[\s\S]*?<\/Tabs>/g, whole => {
    const { arraySrc, openEndIndex } = extractValuesArrayFromTabsOpen(whole);
    const labelByValue = buildLabelMapFromValuesArray(arraySrc);

    const innerStart =
      openEndIndex > -1 ? openEndIndex + 1 : whole.indexOf('>') + 1;
    const innerEnd = whole.lastIndexOf('</Tabs>');
    const inner =
      innerEnd > innerStart ? whole.slice(innerStart, innerEnd) : '';

    const tabs = [];
    inner.replace(
      /<TabItem\b([^>]*)>([\s\S]*?)<\/TabItem>/g,
      (m, tabAttrs, tabBody) => {
        const valueAttr = getAttr(tabAttrs, 'value');
        const rawItemLabel = getAttr(tabAttrs, 'label');
        const preferred =
          rawItemLabel || (valueAttr && labelByValue.get(valueAttr)) || '';
        const title = cleanLabel(preferred, valueAttr || 'Tab');
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

    if (!tabs.length) return whole;
    return [`<Tabs>`, tabs.join('\n\n'), `</Tabs>`].join('\n');
  });
}

function extractValuesArrayFromTabsOpen(whole) {
  const start = whole.indexOf('<Tabs');
  if (start === -1) return { arraySrc: '', openEndIndex: whole.indexOf('>') };

  const valIdx = whole.indexOf('values', start);
  let openEndIndex = whole.indexOf('>');
  if (valIdx === -1) return { arraySrc: '', openEndIndex };

  const braceStart = whole.indexOf('{', valIdx);
  if (braceStart === -1) return { arraySrc: '', openEndIndex };

  let i = braceStart,
    depth = 0;
  for (; i < whole.length; i++) {
    const ch = whole[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const braceEnd = i;
  openEndIndex = whole.indexOf('>', braceEnd);

  const inside = whole.slice(braceStart + 1, braceEnd);
  const lb = inside.indexOf('[');
  const rb = inside.lastIndexOf(']');
  const arraySrc =
    lb !== -1 && rb !== -1 && rb > lb ? inside.slice(lb + 1, rb) : inside;
  return { arraySrc, openEndIndex };
}

function buildLabelMapFromValuesArray(arraySrc) {
  const map = new Map();
  const objs = extractTopLevelObjects(arraySrc);
  for (const objStr of objs) {
    const value =
      (/[\s,{]value\s*:\s*(['"])([\s\S]*?)\1/.exec(objStr) || [])[2] ||
      (/[\s,{]value\s*:\s*\{([\s\S]*?)\}/.exec(objStr) || [])[1] ||
      (/[\s,{]value\s*:\s*([^\s,}]+)/.exec(objStr) || [])[1] ||
      '';

    if (!value) continue;

    let rawLabel = (/[\s,{]label\s*:\s*(['"])([\s\S]*?)\1/.exec(objStr) ||
      [])[2];
    if (!rawLabel)
      rawLabel = (/[\s,{]label\s*:\s*\{([\s\S]*?)\}/.exec(objStr) || [])[1];
    if (!rawLabel)
      rawLabel =
        (/[\s,{]label\s*:\s*([\s\S]*?)(?:,|})/.exec(objStr) || [])[1] || '';

    rawLabel = stripWrapping(rawLabel);
    const label = cleanLabel(rawLabel, value);
    map.set(value, label);
  }
  return map;
}

function extractTopLevelObjects(s) {
  const out = [];
  let depth = 0,
    start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (!out.length) {
    const re = /\{[\s\S]*?\}/g;
    let m;
    while ((m = re.exec(s)) !== null) out.push(m[0]);
  }
  return out;
}

function getAttr(attrs, name) {
  if (!attrs) return '';
  let m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  if (m) return m[1].trim();
  m = new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(attrs);
  if (m) return m[1].trim();
  m = new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`).exec(attrs);
  if (m) return m[1].trim();
  return '';
}

function cleanLabel(raw, fallback = '') {
  const stripped = stripTagsInline(String(raw || '')).trim();
  return stripped || fallback;
}
function stripTagsInline(s) {
  return String(s).replace(/<[^>]+>/g, '');
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
