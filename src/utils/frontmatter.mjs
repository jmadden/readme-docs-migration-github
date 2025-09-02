export function buildReadmeFM(_customerFM, title) {
  // Intentionally ignore sidebar_position / sidebar_label (not used by ReadMe)
  return {
    title,
    deprecated: false,
    hidden: false,
    metadata: { robots: 'index' },
  };
}
