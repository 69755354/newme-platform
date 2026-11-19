// Rule-based extraction of lead facts from the customer's WhatsApp text (S21, v1). No model, no external
// service: patterns for English, Chinese and Arabic. Every result carries the source message id and a
// confidence; results are suggestions for a note draft, never written straight into lead columns.

const SQFT_TO_SQM = 0.09290304;
const MAX_TEXT = 4096;
const ARABIC_INDIC = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9", "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };
const CN_DIGITS = { "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };

const normalize = (text) => text.slice(0, MAX_TEXT).replace(/[٠-٩۰-۹]/g, (d) => ARABIC_INDIC[d]).replace(/[٬,](?=\d{3}\b)/g, "").replace(/٫/g, ".");
const num = (s) => Number(String(s).replace(/,/g, ""));
const round1 = (n) => Math.round(n * 10) / 10;

function chineseCount(token) {
  if (/^\d+$/.test(token)) return Number(token);
  return token in CN_DIGITS ? CN_DIGITS[token] : null;
}

// Each rule returns { value, confidence } or null for one message.
const RULES = {
  rooms(text) {
    let m = /\b(\d{1,2})\s*(?:-|\s)?(?:bed(?:room)?s?|br|bhk|b\/r)\b/i.exec(text);
    if (m) return { value: Number(m[1]), confidence: 0.9 };
    if (/\bstudio\b/i.test(text)) return { value: 0, confidence: 0.9 };
    m = /(\d{1,2}|[一二两兩三四五六七八九十])\s*(?:室|房|卧|臥|居室)/.exec(text);
    if (m) { const v = chineseCount(m[1]); if (v !== null) return { value: v, confidence: 0.9 }; }
    m = /(\d{1,2})\s*(?:غرف(?:ة|تين)?|غرفتين)/.exec(text);
    if (m) return { value: Number(m[1]), confidence: 0.8 };
    if (/غرفتين/.test(text)) return { value: 2, confidence: 0.8 };
    return null;
  },
  property_type(text) {
    if (/\b(villa|townhouse|town house)\b|别墅|联排|فيلا/i.test(text)) return { value: /townhouse|town house|联排/i.test(text) ? "townhouse" : "villa", confidence: 0.9 };
    if (/\b(apartment|flat|studio|condo)\b|公寓|平层|شقة|استوديو/i.test(text)) return { value: "apartment", confidence: 0.9 };
    if (/\b(office|shop|retail|showroom)\b|办公室|商铺|店铺|مكتب|محل/i.test(text)) return { value: "commercial", confidence: 0.8 };
    return null;
  },
  area_sqm(text) {
    let m = /(\d{1,6}(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|square\s*feet|sf)\b/i.exec(text);
    if (m) return { value: round1(num(m[1]) * SQFT_TO_SQM), confidence: 0.9 };
    m = /(\d{1,6}(?:\.\d+)?)\s*(?:sq\.?\s*m(?:eters?|etres?)?|sqm|m2|m²|square\s*met(?:er|re)s?)\b/i.exec(text);
    if (m) return { value: num(m[1]), confidence: 0.9 };
    m = /(\d{1,6}(?:\.\d+)?)\s*(?:平方米|平米|平方|㎡|平)/.exec(text);
    if (m) return { value: num(m[1]), confidence: 0.9 };
    m = /(\d{1,6}(?:\.\d+)?)\s*(?:متر|م٢|م2)/.exec(text);
    if (m) return { value: num(m[1]), confidence: 0.9 };
    m = /(?:area|size|面积|المساحة)\D{0,6}(\d{1,6}(?:\.\d+)?)/i.exec(text);
    if (m) return { value: num(m[1]), confidence: 0.6 };
    return null;
  },
  budget_aed(text) {
    const money = (digits, suffix) => {
      let v = num(digits);
      if (/^m/i.test(suffix ?? "")) v *= 1_000_000;
      else if (/^k/i.test(suffix ?? "")) v *= 1000;
      else if (/^万|^萬/.test(suffix ?? "")) v *= 10_000;
      return v;
    };
    const KEY = String.raw`(?:budget|spend|afford|price range|预算|ميزانية|الميزانية)`;
    let m = new RegExp(String.raw`(?:aed|dhs?|dirhams?)\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|万|萬)?`, "i").exec(text);
    if (m) { const v = money(m[1], m[2]); if (v >= 1000) return { value: v, confidence: 0.9 }; }
    m = new RegExp(String.raw`(\d[\d,]*(?:\.\d+)?)\s*(k|m|万|萬)?\s*(?:aed|dhs?|dirhams?|درهم|迪拉姆|迪拉姆|迪)`, "i").exec(text);
    if (m) { const v = money(m[1], m[2]); if (v >= 1000) return { value: v, confidence: 0.9 }; }
    m = new RegExp(String.raw`${KEY}\D{0,20}?(\d[\d,]*(?:\.\d+)?)\s*(k|m|万|萬)?`, "i").exec(text);
    if (m) { const v = money(m[1], m[2]); if (v >= 1000) return { value: v, confidence: 0.6 }; }
    return null;
  },
  renovation(text) {
    if (/under renovation|being renovated|renovating|fit[- ]?out in progress|under construction|装修中|正在装修|在装修|قيد التجديد|تحت التشطيب/i.test(text)) return { value: "in_progress", confidence: 0.9 };
    if (/not yet renovated|will renovate|plan to renovate|going to renovate|待装修|准备装修|打算装修|毛坯|handover|handed over|newly handed/i.test(text)) return { value: "planned", confidence: 0.6 };
    if (/already renovated|fully renovated|装修完|已装修/i.test(text)) return { value: "done", confidence: 0.8 };
    return null;
  },
  next_step(text) {
    if (/\b(site )?visit\b|come (?:over|to (?:see|measure))|measure|survey|上门|量尺|到访|来看|زيارة/i.test(text)) return { value: "visit", confidence: 0.8 };
    if (/\bcall me\b|\bphone me\b|give me a call|call (?:me )?(?:tomorrow|later|back)|打电话|给我电话|来电|اتصل/i.test(text)) return { value: "call", confidence: 0.8 };
    if (/\b(quote|quotation|price list|proposal)\b|报价|方案|عرض سعر/i.test(text)) return { value: "quote", confidence: 0.7 };
    return null;
  },
};

/**
 * messages: [{ id, text, direction }] oldest first. Only inbound (customer) text is read.
 * Returns { fields: [{ field, value, confidence, source_message_id }] }, the latest statement of each field wins.
 */
export function extractLeadFields(messages) {
  const best = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.direction !== "inbound" || typeof message.text !== "string" || !message.text.trim()) continue;
    const text = normalize(message.text);
    for (const [field, rule] of Object.entries(RULES)) {
      let hit = null;
      try { hit = rule(text); } catch { hit = null; }
      if (!hit || hit.value === null || hit.value === undefined || (typeof hit.value === "number" && !Number.isFinite(hit.value))) continue;
      if (hit.confidence < 0.5) continue;
      best.set(field, { field, value: hit.value, confidence: hit.confidence, source_message_id: String(message.id) });
    }
  }
  return { fields: [...best.values()] };
}

const LABELS = {
  rooms: ["房间数", "Rooms", (v) => String(v)],
  property_type: ["户型", "Property type", (v) => v],
  area_sqm: ["面积", "Area", (v) => `${v} m²`],
  budget_aed: ["预算", "Budget", (v) => `AED ${v.toLocaleString("en-US")}`],
  renovation: ["装修", "Renovation", (v) => v],
  next_step: ["下一步", "Next step", (v) => v],
};

/** A note draft for a person to confirm; null when nothing was found. */
export function buildFieldDraftNote(result) {
  const fields = result?.fields ?? [];
  if (!fields.length) return null;
  const lines = fields.map((f) => {
    const [zh, en, fmt] = LABELS[f.field] ?? [f.field, f.field, String];
    return `- ${zh} / ${en}: ${fmt(f.value)} (message ${f.source_message_id}, ${Math.round(f.confidence * 100)}%)`;
  });
  return ["[Draft] Suggested fields from the customer's WhatsApp messages, please confirm / [草稿] 根据客户 WhatsApp 消息提取的字段，请核对后再使用", ...lines].join("\n");
}
