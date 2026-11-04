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

/**
 * Label for a value that may or may not have a translation. The translate
 * function returns the lookup path itself when the entry is missing, which used
 * to print "sourceLabels.google" for an unknown source; this returns the raw
 * value (the source / campaign name as stored) in that case.
 *
 * @param {(path: string) => string} translate
 * @param {string} path e.g. `sourceLabels.${key}`
 * @param {string} raw  the stored value to show when there is no translation
 */
export function translatedOrRaw(translate, path, raw) {
  const text = translate(path);
  return typeof text === "string" && text.trim() !== "" && text !== path ? text : String(raw ?? "");
}
