export function rewriteAllImageOccurrences(md, mapping) {
  let out = md;
  for (const [orig, url] of mapping) {
    if (!orig || !url) continue;

    const esc = escapeRegex(orig);

    out = out.replace(
      new RegExp(`<!--IMAGE_PLACEHOLDER:${esc}-->`, 'g'),
      `<img src="${url}" alt="" />`
    );
    out = out.replace(
      new RegExp(`\\*\\*MISSING IMAGE!\\*\\*\\s+${esc}`, 'g'),
      `<img src="${url}" alt="" />`
    );
    out = out.replace(
      new RegExp(
        `(!\$begin:math:display$[^\\$end:math:display$]*\\]\$begin:math:text$)${esc}(\\$end:math:text$)`,
        'g'
      ),
      `$1${url}$2`
    );
    out = out.replace(
      new RegExp(`(<img\\b[^>]*\\bsrc=)(["'])${esc}\\2`, 'g'),
      `$1"${url}"`
    );
    out = out.replace(
      new RegExp(
        `useBaseUrl\$begin:math:text$\\\\s*(['"])${esc}\\\\1\\\\s*\\$end:math:text$`,
        'g'
      ),
      `"${url}"`
    );
  }
  return out;
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
