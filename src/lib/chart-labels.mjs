// A chart tooltip / legend label must never print the word "undefined".
//
// The analytics "Quality Distribution" bar built its hover text as
// `${labels[key]}: ${count}` from a label map that only knew good/pending/bad, so
// the fourth segment (unknown) read "undefined: 20" and "normal" leads had no
// segment at all. Labels now always resolve: the supplied map, then the caller's
// fallback (the translated name), then a readable form of the key itself.

export function humanizeKey(key) {
  const text = String(key ?? "").replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

export function chartLabel(labels, key, fallback) {
  const direct = labels?.[key];
  if (typeof direct === "string" && direct.trim() !== "") return direct;
  if (typeof fallback === "string" && fallback.trim() !== "") return fallback;
  return humanizeKey(key);
}

/** "Label: 20" hover text for one chart segment. */
export function segmentTitle(labels, key, count, fallback) {
  const n = Number.isFinite(count) ? count : 0;
  return `${chartLabel(labels, key, fallback)}: ${n}`;
}
