// 検索・解析・重複検出(DOM/IndexedDB非依存。Nodeでもテスト可能)
export const KATA = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
export const norm = (s) => KATA((s || "").normalize("NFKC").toLowerCase()).replace(/[\s　・,，、。.\-_\/()（）「」『』"'“”]+/g, "");
const HON = ["さん", "ちゃん", "くん", "さま", "様", "君", "氏", "社長", "部長", "先生"].map((h) => KATA(h.normalize("NFKC").toLowerCase()));
export const stripHon = (n) => { for (const h of HON) if (n.endsWith(h) && n.length > h.length) return n.slice(0, -h.length); return n; };
const bg = (n) => { const s = new Set(); for (let i = 0; i < n.length - 1; i++) s.add(n.slice(i, i + 2)); return s; };
export function fuzzy(q, t) {
  if (q.length < 2) return 0;
  const a = bg(q), b = bg(t); let inter = 0; a.forEach((x) => b.has(x) && inter++);
  if (!inter) return 0; let best = 0;
  if (t.length <= 12) { const d = (2 * inter) / (a.size + b.size); if (d >= 0.5) best = d; }
  if (t.length >= 6 && q.length >= 3) { const c = inter / a.size; if (c >= 0.6) best = Math.max(best, c); }
  return best;
}
export const KIND = { call: ["呼び名", 0], real: ["本名", 0], receipt: ["領収書名", 1], alias: ["ニックネーム", 2], keyword: ["検索キーワード", 2], company: ["会社名", 3], industry: ["職業・業種", 4], receipt_old: ["過去の領収書名", 5], feature: ["特徴", 6], memo: ["メモ", 8] };
const TIER = { exact: [100, "完全一致"], prefix: [80, "前方一致"], partial: [60, "部分一致"], fuzzy: [40, "類似"] };

export const activeReceipts = (c) => (c.receipts || []).filter((r) => !r.retiredAt);
export function termsOf(c) {
  const t = [["call", c.call, c.callYomi]];
  if (c.real) t.push(["real", c.real, c.realYomi]);
  (c.aliases || []).forEach((a) => t.push(["alias", a, ""]));
  (c.keywords || []).forEach((a) => t.push(["keyword", a, ""]));
  (c.receipts || []).forEach((r) => t.push([r.retiredAt ? "receipt_old" : "receipt", r.name, r.yomi]));
  for (const [k, kind] of [["company", "company"], ["industry", "industry"], ["features", "feature"], ["memo", "memo"]]) if (c[k]) t.push([kind, c[k], ""]);
  return t.filter((x) => x[1]);
}
function prep(c) { // 検索用に正規化済みの語を持たせる(保存データには含めない)
  return termsOf(c).map(([kind, text, y]) => { const n = norm(text); return { kind, text, n, n2: kind === "call" || kind === "alias" ? stripHon(n) : n, y: y ? norm(y) : "" }; });
}
function bestFor(terms, tok) {
  const q = norm(tok); if (!q) return null; let best = null;
  for (const t of terms) {
    const cands = [[t.n, 0]]; if (t.n2 !== t.n) cands.push([t.n2, 2]); if (t.y) cands.push([t.y, 1]);
    for (const [tn, ex] of cands) {
      const tier = tn === q ? "exact" : tn.startsWith(q) ? "prefix" : tn.includes(q) ? "partial" : fuzzy(q, tn) ? "fuzzy" : null;
      if (!tier) continue;
      const sc = TIER[tier][0] - KIND[t.kind][1] - ex + (tier === "fuzzy" ? Math.round(9 * fuzzy(q, tn)) : 0);
      if (!best || sc > best.sc) best = { sc, label: KIND[t.kind][0], text: t.text, tier: TIER[tier][1], read: ex === 1 };
    }
  }
  return best;
}
export function search(list, query) {
  const toks = query.split(/[\s　]+/).filter(Boolean); if (!toks.length) return { results: [], ambiguous: false };
  const out = [];
  for (const c of list) {
    if (c.deleted) continue;
    const terms = c._t || (c._t = prep(c));
    const p = toks.map((t) => bestFor(terms, t)); if (p.some((x) => !x)) continue;
    out.push({ c, sc: p.reduce((a, x) => a + x.sc, 0) / p.length, hits: p });
  }
  out.sort((a, b) => b.sc - a.sc || a.c.id - b.c.id);
  const res = out.slice(0, 30);
  return { results: res, ambiguous: res.length > 1 && res[1].sc >= res[0].sc - 5 };
}

// ---- 重複検出(自動統合はしない) ----
function keys(c) {
  const k = new Set();
  [c.call, ...(c.aliases || []), c.real].filter(Boolean).forEach((s) => k.add("n:" + stripHon(norm(s))));
  [c.callYomi, c.realYomi].filter(Boolean).forEach((s) => k.add("n:" + stripHon(norm(s))));
  activeReceipts(c).forEach((r) => k.add("r:" + norm(r.name)));
  return k;
}
function prefixes(c) {
  const out = new Set();
  [c.real, c.realYomi].filter(Boolean).forEach((s) => { const n = norm(s); for (let i = 2; i < n.length; i++) out.add(n.slice(0, i)); });
  return out;
}
export function findDuplicates(list, draft, excludeId) {
  const dk = keys(draft), res = [];
  const dpre = [draft.call, draft.real].filter(Boolean).map((s) => stripHon(norm(s)));
  for (const c of list) {
    if (c.deleted || c.id === excludeId) continue;
    const shared = [...keys(c)].filter((x) => dk.has(x));
    let level = null, why = "";
    if (shared.length) { level = "high"; why = shared[0].startsWith("r:") ? "同じ領収書名" : "名前・読みが一致"; }
    else { const pre = prefixes(c); if (dpre.some((d) => d.length >= 2 && pre.has(d))) { level = "possible"; why = "姓などの先頭部分が一致"; } }
    if (level) res.push({ c, level, why });
  }
  return res.sort((a, b) => (a.level === "high" ? 0 : 1) - (b.level === "high" ? 0 : 1)).slice(0, 8);
}
export function scanDuplicates(list) {
  const live = list.filter((c) => !c.deleted), seen = new Set(), out = [];
  for (const a of live) for (const d of findDuplicates(live, a, a.id)) {
    const id = [a.id, d.c.id].sort().join("-"); if (seen.has(id)) continue; seen.add(id); out.push({ a, b: d.c, level: d.level, why: d.why });
  }
  return out.sort((x, y) => (x.level === "high" ? 0 : 1) - (y.level === "high" ? 0 : 1));
}

// ---- 取込(文章/CSV) ----
const SPLIT = /[、,，\t]+/;
const REC = /^(?:領収書|領収証|宛名|宛先)\s*(?:名)?\s*(?:は|が|:|：|=)?\s*(.+)$/;
const LABELS = [["real", /^(?:本名|氏名|フルネーム)\s*(?:は|:|：)?\s*(.+)$/], ["alias", /^(?:呼び名|通称|あだ名|愛称|ニックネーム|別名)\s*(?:は|:|：)?\s*(.+)$/], ["company", /^(?:会社名?|勤務先|社名)\s*(?:は|:|：)?\s*(.+)$/], ["industry", /^(?:職業|業種)\s*(?:は|:|：)?\s*(.+)$/]];
const INDUSTRY = /(業|社長|経営|医師|医者|弁護士|会計士|税理士|教師|先生|議員|職人|自営|会社員|公務員|フリーランス)$/;
export const emptyDraft = () => ({ call: "", callYomi: "", real: "", realYomi: "", aliases: [], keywords: [], company: "", industry: "", features: "", memo: "", lastConfirmed: "", receipts: [] });
export function parseLine(line) {
  const p = emptyDraft(), warns = [], feats = [];
  for (const seg of line.split(SPLIT).map((s) => s.trim()).filter(Boolean)) {
    let m = seg.match(REC);
    if (m) { const name = m[1].trim().replace(/(?:でお願いします|です|で|宛て?)$/, ""); if (name) p.receipts.push({ id: p.receipts.length + 1, name, yomi: "", type: "unknown", primary: false }); continue; }
    let hit = false;
    for (const [k, rx] of LABELS) { m = seg.match(rx); if (m) { const v = m[1].trim(); k === "alias" ? p.aliases.push(v) : (p[k] = v); hit = true; break; } }
    if (hit) continue;
    if (!p.call) p.call = seg; else if (INDUSTRY.test(seg) && !p.industry) p.industry = seg; else feats.push(seg);
  }
  p.features = feats.join("、");
  if (!p.call) warns.push("呼び名を読み取れませんでした");
  if (!p.receipts.length) warns.push("領収書名が見つかりません（登録後は「領収書名未登録」になります）");
  return { p, warns };
}
export const parseText = (t) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((raw) => ({ raw, ...parseLine(raw) }));
export function parseCSVRows(text) { // 引用符・改行・カンマ入りに対応
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
const HDR = { call: ["呼び名", "呼名", "名前", "お名前", "name"], real: ["本名", "氏名"], realYomi: ["フリガナ", "ふりがな", "読み", "読み仮名"], callYomi: ["呼び名フリガナ", "呼び名の読み"], aliases: ["ニックネーム", "別名", "あだ名", "通称"], receipt: ["領収書名", "宛名", "領収書"], receiptYomi: ["領収書名フリガナ", "宛名フリガナ"], company: ["会社名", "勤務先", "会社"], industry: ["職業", "業種", "職業・業種"], features: ["特徴"], keywords: ["検索キーワード", "キーワード"], memo: ["メモ", "備考"], lastConfirmed: ["最終確認日"] };
export function parseCSV(text) {
  const rows = parseCSVRows(text.replace(/^﻿/, "")); if (!rows.length) throw new Error("データがありません");
  const col = {}; rows[0].map((h) => h.trim()).forEach((h, i) => { for (const [k, ns] of Object.entries(HDR)) if (ns.includes(h) && !(k in col)) col[k] = i; });
  if (!("call" in col)) throw new Error("「呼び名」列（または「名前」列）が見つかりません。1行目に見出しを付けてください。");
  const multi = (v) => (v || "").split(/[;；/／、|]+/).map((x) => x.trim()).filter(Boolean);
  return rows.slice(1).map((r) => {
    const g = (k) => ((k in col ? r[col[k]] : "") || "").trim(), p = emptyDraft(), warns = [];
    Object.assign(p, { call: g("call"), real: g("real"), realYomi: g("realYomi"), callYomi: g("callYomi"), company: g("company"), industry: g("industry"), features: g("features"), memo: g("memo"), lastConfirmed: g("lastConfirmed").slice(0, 10), aliases: multi(g("aliases")), keywords: multi(g("keywords")) });
    if (g("receipt")) p.receipts.push({ id: 1, name: g("receipt"), yomi: g("receiptYomi"), type: "unknown", primary: false });
    if (!p.call) warns.push("呼び名が空です"); if (!p.receipts.length) warns.push("領収書名が空です");
    return { raw: r.join(" / "), p, warns };
  });
}
export const csvSafe = (v) => { v = v == null ? "" : String(v); return /^[=+\-@\t\r]/.test(v) ? "'" + v : v; };
export const csvCell = (v) => '"' + csvSafe(v).replace(/"/g, '""') + '"';
