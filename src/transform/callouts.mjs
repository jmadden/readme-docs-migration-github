export function convertNoteTipBlocks(text) {
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
    return [
      `<Callout icon="ℹ️" theme="info">`,
      `  ${indentBlock(body, '  ').trimStart()}`,
      `</Callout>`,
    ].join('\n');
  };

  let out = text.replace(infoRe, (_, inner) => toCallout(inner, 'info'));
  out = out.replace(tipRe, (_, inner) => toCallout(inner, 'tip'));
  out = out.replace(noteRe, (_, inner) => toCallout(inner, 'note'));
  return out;
}

export function indentBlock(s, pad = '  ') {
  return String(s)
    .split(/\r?\n/)
    .map(line => (line.length ? pad + line : ''))
    .join('\n');
}
