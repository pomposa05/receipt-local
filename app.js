import { norm, search, activeReceipts, findDuplicates, scanDuplicates, parseText, parseCSV, emptyDraft, csvCell, csvSafe } from "./lib.js";
import * as db from "./db.js";

const $app = document.getElementById("app");
let LIST = [], VIEW = "search", SUB = "", PERSIST = null;
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

function h(tag, a, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(a || {})) {
    if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, ""); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  kids.flat().forEach((k) => k != null && k !== false && e.append(k.nodeType ? k : document.createTextNode(String(k))));
  return e;
}
const clear = (e) => e.replaceChildren();
function toast(m, bad) { const t = document.getElementById("toast"); t.textContent = m; t.className = "show" + (bad ? " bad" : ""); clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ""), 2200); }
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = h("textarea", { style: "position:fixed;opacity:0" }); ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (x) {} ta.remove();
    if (!ok) return toast("コピーできません。長押しで選択してください：" + text, true);
  }
  toast("コピーしました：" + text);
}
async function reload() { LIST = await db.all(); }
const live = () => LIST.filter((c) => !c.deleted);

function shell(...content) {
  clear($app);
  const tabs = [["search", "検索"], ["list", "顧客"], ["import", "取込"], ["settings", "設定"]];
  $app.append(h("header", {}, h("b", {}, "領収書名検索"), h("small", {}, `${live().length}件 ・ このスマホ内に保存`)),
    h("main", {}, ...content),
    h("nav", {}, tabs.map(([k, l]) => h("button", { class: VIEW === k ? "on" : "", onclick: () => { VIEW = k; SUB = ""; render(); } }, l))));
}

// ---------- 読み仮名の自動入力(日本語入力の変換前の読みを取得) ----------
function autoKana(src, dst) {
  let buf = "", seg = "", manual = !!dst.value;
  const isKana = (s) => /^[ぁ-ゖァ-ヺー]+$/.test(s);
  src.addEventListener("compositionstart", () => { seg = ""; });
  src.addEventListener("compositionupdate", (e) => { if (isKana(e.data || "")) seg = e.data; });
  src.addEventListener("compositionend", () => { buf += seg; seg = ""; if (!manual) dst.value = buf; });
  src.addEventListener("input", () => { if (!src.value) { buf = ""; if (!manual) dst.value = ""; } });
  dst.addEventListener("input", () => { manual = true; });
}

// ---------- 検索 ----------
const DAY30 = 30 * 86400e3;
async function backupBanner() {
  const last = await db.getMeta("lastBackup");
  if (!live().length) return null;
  if (!last) return h("div", { class: "banner warn" }, "バックアップがまだありません。端末の故障や削除に備え、「設定」から書き出してください。");
  if (Date.now() - last > DAY30) return h("div", { class: "banner warn" }, "30日以上バックアップしていません。「設定」から書き出してください。");
  return null;
}
async function searchView() {
  const q = h("input", { id: "q", type: "search", placeholder: "名前・あだ名・会社・特徴で検索", autocomplete: "off", autocapitalize: "off", enterkeyhint: "search" });
  const out = h("div"), warn = await backupBanner();
  q.addEventListener("input", () => {
    clear(out); if (!q.value.trim()) return;
    const r = search(LIST, q.value);
    if (!r.results.length) return out.append(h("div", { class: "banner info" }, "該当する顧客が見つかりません。別の呼び名・特徴でお試しください。"));
    if (r.ambiguous) out.append(h("div", { class: "banner warn" }, "似た候補が複数あります。お客様を確認してから領収書名を選んでください。"));
    r.results.forEach((x) => out.append(resultCard(x)));
  });
  shell(warn, q, out); q.focus();
}
function resultCard({ c, sc, hits }) {
  const rn = activeReceipts(c), rec = h("div");
  if (!rn.length) rec.append(h("div", { class: "receipt none" }, "領収書名未登録"));
  else {
    if (rn.length > 1 && !rn.some((r) => r.primary)) rec.append(h("div", { class: "banner warn" }, "領収書名が複数登録されています。どの宛名か確認してください。"));
    rn.forEach((r) => { rec.append(h("div", { class: "receipt" }, r.name), r.yomi ? h("div", { class: "mute" }, r.yomi) : null,
      h("div", { class: "mute" }, `${{ corporate: "法人", individual: "個人", unknown: "法人/個人 未設定" }[r.type || "unknown"]}${r.primary ? " ・ 標準" : ""}`),
      h("button", { class: "btn copy", onclick: () => copy(r.name) }, rn.length > 1 ? `「${r.name}」をコピー` : "領収書名をコピー")); });
  }
  const hist = (c.receipts || []).filter((r) => r.retiredAt);
  const det = h("details", {}, h("summary", {}, "詳細"),
    ...[c.real && `本名: ${c.real}`, c.company && `会社: ${c.company}`, c.industry && `業種: ${c.industry}`, c.features && `特徴: ${c.features}`, c.memo && `メモ: ${c.memo}`,
      c.aliases.length && `別名: ${c.aliases.join("、")}`, `最終確認日: ${c.lastConfirmed || "未確認"}`].filter(Boolean).map((t) => h("div", { class: "mute" }, t)),
    hist.length ? h("div", {}, h("div", { class: "mute" }, "過去の領収書名:"), hist.map((r) => h("div", { class: "hist" }, `${r.name}（〜${r.retiredAt}）`))) : null,
    h("div", { class: "row", style: "margin-top:8px" },
      h("button", { class: "btn sub sm", onclick: async () => { c.lastConfirmed = today(); c.updatedAt = Date.now(); await db.put(c); toast("確認日を更新しました"); } }, "宛名を確認した"),
      h("button", { class: "btn sub sm", onclick: () => { VIEW = "list"; SUB = "edit:" + c.id; render(); } }, "編集")));
  return h("div", { class: "card" }, h("div", { class: "row sp" }, h("span", { class: "name" }, c.call), h("span", { class: "mute" }, "一致度 " + Math.round(sc))),
    h("div", {}, hits.map((x) => h("span", { class: "chip" }, `${x.label}「${x.text.length > 14 ? x.text.slice(0, 14) + "…" : x.text}」${x.read ? "読み" : ""}${x.tier}`))), rec, det);
}

// ---------- 顧客一覧・編集 ----------
function listView() {
  if (SUB.startsWith("edit:") || SUB === "new") return editView(SUB === "new" ? null : +SUB.slice(5));
  const trash = SUB === "trash", items = LIST.filter((c) => !!c.deleted === trash).sort((a, b) => b.updatedAt - a.updatedAt);
  shell(h("div", { class: "row" }, h("button", { class: "btn grow", onclick: () => { SUB = "new"; render(); } }, "＋ 顧客を追加"),
    h("button", { class: "btn sub", onclick: () => { SUB = trash ? "" : "trash"; render(); } }, trash ? "一覧へ" : "ごみ箱")),
    h("div", { class: "mute" }, `${items.length}件`),
    ...items.map((c) => h("div", { class: "card row sp" }, h("div", {}, h("div", { class: "name" }, c.call), h("div", { class: "mute" }, c.real || ""),
      h("div", {}, activeReceipts(c).length ? activeReceipts(c).map((r) => r.name).join(" / ") : "領収書名未登録")),
      trash ? h("button", { class: "btn sm", onclick: async () => { c.deleted = false; c.updatedAt = Date.now(); await db.put(c); c._t = null; toast("復元しました"); render(); } }, "復元")
        : h("button", { class: "btn sub sm", onclick: () => { SUB = "edit:" + c.id; render(); } }, "編集"))));
}
function editView(id) {
  const src = id ? LIST.find((c) => c.id === id) : null;
  if (id && !src) { SUB = ""; return render(); }
  const c = JSON.parse(JSON.stringify(src || { ...emptyDraft() })), f = {};
  const text = (k, label, ph) => { f[k] = h("input", { type: "text", value: c[k] || "", placeholder: ph || "" }); return h("div", {}, h("label", {}, label), f[k]); };
  const area = (k, label, ph) => { f[k] = h("textarea", { placeholder: ph || "" }); f[k].value = c[k] || ""; return h("div", {}, h("label", {}, label), f[k]); };
  const lines = (k, label) => { f[k] = h("textarea", {}); f[k].value = (c[k] || []).join("\n"); return h("div", {}, h("label", {}, label + "（1行に1つ）"), f[k]); };
  const rns = (c.receipts || []).filter((r) => !r.retiredAt).map((r) => ({ ...r })), retired = (c.receipts || []).filter((r) => r.retiredAt);
  const box = h("div"), msg = h("div");
  const draw = () => {
    clear(box);
    rns.forEach((r, i) => {
      const n = h("input", { type: "text", value: r.name, placeholder: "領収書名（宛名）" }), y = h("input", { type: "text", value: r.yomi || "", placeholder: "フリガナ（自動入力・修正可）" });
      n.oninput = () => (r.name = n.value); y.oninput = () => (r.yomi = y.value); autoKana(n, y);
      const t = h("select", { onchange: () => (r.type = t.value) }, [["unknown", "法人/個人 未設定"], ["corporate", "法人"], ["individual", "個人"]].map(([v, l]) => h("option", { value: v, selected: (r.type || "unknown") === v }, l)));
      const p = h("input", { type: "checkbox", checked: !!r.primary, onchange: () => { rns.forEach((x) => (x.primary = false)); r.primary = p.checked; draw(); } });
      box.append(h("div", { class: "rn-row" }, n, y, t, h("div", { class: "row sp" }, h("label", {}, p, " 標準の宛名にする"), h("button", { class: "btn bad sm", onclick: () => { rns.splice(i, 1); draw(); } }, "この宛名を外す"))));
    });
  };
  draw();
  const call = text("call", "呼び名（必須）", "例: 田中さん"), callY = text("callYomi", "呼び名のフリガナ（自動入力・修正可）"), real = text("real", "本名"), realY = text("realYomi", "本名のフリガナ（自動入力・修正可）");
  autoKana(f.call, f.callYomi); autoKana(f.real, f.realYomi);
  let confirmed = false;
  const save = async () => {
    clear(msg);
    const d = { ...c, call: f.call.value.trim(), callYomi: f.callYomi.value.trim(), real: f.real.value.trim(), realYomi: f.realYomi.value.trim(), company: f.company.value.trim(), industry: f.industry.value.trim(),
      features: f.features.value.trim(), memo: f.memo.value.trim(), lastConfirmed: f.lastConfirmed.value, aliases: f.aliases.value.split("\n").map((s) => s.trim()).filter(Boolean), keywords: f.keywords.value.split("\n").map((s) => s.trim()).filter(Boolean) };
    if (!d.call) return msg.append(h("div", { class: "banner err" }, "呼び名は必須です"));
    // 領収書名: 名前が変わった行は旧行を履歴へ、外した行も履歴へ(消さない)
    const old = new Map((src ? src.receipts : []).filter((r) => !r.retiredAt).map((r) => [r.id, r])), next = [...retired];
    let maxId = Math.max(0, ...(c.receipts || []).map((r) => r.id || 0));
    const keep = new Set(), primaries = rns.filter((r) => r.name.trim() && r.primary).length;
    rns.filter((r) => r.name.trim()).forEach((r) => {
      const o = old.get(r.id), base = { yomi: (r.yomi || "").trim(), type: r.type || "unknown", primary: primaries === 1 && !!r.primary };
      if (o) { keep.add(o.id); if (o.name !== r.name.trim()) { next.push({ ...o, primary: false, retiredAt: today() }); next.push({ id: ++maxId, name: r.name.trim(), ...base }); } else next.push({ ...o, ...base }); }
      else next.push({ id: ++maxId, name: r.name.trim(), ...base });
    });
    old.forEach((o) => { if (!keep.has(o.id)) next.push({ ...o, primary: false, retiredAt: today() }); });
    d.receipts = next;
    const dups = findDuplicates(live(), d, id);
    if (dups.length && !confirmed && !id) {
      confirmed = true; saveBtn.textContent = "別人として登録する";
      return msg.append(h("div", { class: "banner warn" }, "同じ人の可能性: " + dups.map((x) => `${x.c.call}${activeReceipts(x.c).length ? "→" + activeReceipts(x.c).map((r) => r.name).join("/") : ""}（${x.why}）`).join("、"), "。別人なら、もう一度ボタンを押してください（自動では統合しません）。"));
    }
    d.updatedAt = Date.now(); if (!id) { d.createdAt = Date.now(); delete d.id; }
    const key = await db.put(d); if (!id) d.id = key;
    await reload(); toast("保存しました"); SUB = ""; render();
  };
  const saveBtn = h("button", { class: "btn grow", onclick: save }, "保存");
  shell(h("h3", {}, id ? "顧客を編集" : "顧客を追加"), msg, call, callY, real, realY,
    h("div", { class: "card" }, h("b", {}, "領収書名"), box, h("button", { class: "btn sub sm", onclick: () => { rns.push({ id: -Date.now(), name: "", yomi: "", type: "unknown", primary: false }); draw(); } }, "＋ 宛名を追加"),
      retired.length ? h("div", {}, h("div", { class: "mute" }, "変更履歴"), retired.map((r) => h("div", { class: "hist" }, `${r.name}（〜${r.retiredAt}）`))) : null),
    lines("aliases", "ニックネーム"), text("company", "会社名"), text("industry", "職業・業種"), area("features", "特徴", "例: いつも黒いスーツ"), lines("keywords", "検索キーワード"), area("memo", "メモ"),
    h("div", {}, h("label", {}, "最終確認日"), (f.lastConfirmed = h("input", { type: "date", value: c.lastConfirmed || "" }))),
    h("div", { class: "row" }, saveBtn, h("button", { class: "btn sub", onclick: () => { SUB = ""; render(); } }, "戻る"),
      id ? h("button", { class: "btn bad", onclick: async () => { if (!confirm("この顧客を削除しますか？（ごみ箱から復元できます）")) return; src.deleted = true; src.updatedAt = Date.now(); await db.put(src); toast("削除しました"); SUB = ""; render(); } }, "削除") : null));
}

// ---------- 取込 ----------
function importView() {
  const ta = h("textarea", { class: "tall", placeholder: "1行に1人。例: 田中さん、建設業、いつも黒いスーツ、領収書はABC商事" }), file = h("input", { type: "file", accept: ".csv,.txt" }), out = h("div");
  const show = (recs) => {
    clear(out);
    const st = recs.map((r) => ({ ...r, dups: findDuplicates(live(), r.p), on: false, action: "create" })); st.forEach((s) => (s.on = !s.dups.length && !!s.p.call));
    const sum = h("div", { class: "banner info" }), list = h("div"), upd = () => (sum.textContent = `${st.length}件を解析。登録対象: ${st.filter((s) => s.on).length}件。内容を確認してから登録してください。`);
    const draw = () => { clear(list); upd(); st.forEach((s) => {
      const p = s.p, inp = (label, get, set) => { const e = h("input", { type: "text", value: get() }); e.oninput = () => set(e.value); return h("div", {}, h("label", {}, label), e); };
      list.append(h("div", { class: "card" }, h("label", { class: "row" }, h("input", { type: "checkbox", checked: s.on, onchange: (e) => { s.on = e.target.checked; upd(); } }), h("b", {}, p.call || "(呼び名なし)")),
        s.warns.map((w) => h("div", { class: "banner warn" }, w)),
        s.dups.length ? h("div", { class: "banner warn" }, "重複の可能性: " + s.dups.map((d) => `${d.c.call}（${d.why}）`).join("、"),
          h("div", { class: "row", style: "margin-top:6px" }, h("select", { onchange: (e) => (s.action = e.target.value) }, [["create", "別人として新規登録"], ["merge", "既存顧客に追加"]].map(([v, l]) => h("option", { value: v }, l))))) : null,
        inp("呼び名", () => p.call, (v) => (p.call = v)), inp("領収書名", () => (p.receipts[0] || {}).name || "", (v) => { if (!p.receipts[0]) p.receipts.push({ id: 1, name: "", yomi: "", type: "unknown", primary: false }); p.receipts[0].name = v; }),
        h("details", {}, h("summary", {}, "その他・元の入力"), inp("業種", () => p.industry, (v) => (p.industry = v)), inp("会社名", () => p.company, (v) => (p.company = v)), inp("特徴", () => p.features, (v) => (p.features = v)), h("div", { class: "mute" }, "元の入力: " + s.raw))));
    }); };
    draw();
    const go = h("button", { class: "btn w", onclick: async () => {
      const sel = st.filter((s) => s.on && s.p.call); if (!sel.length) return toast("登録する行を選択してください", true);
      if (!confirm(`${sel.length}件を登録します。よろしいですか？`)) return;
      go.disabled = true; let n = 0, m = 0;
      for (const s of sel) {
        const p = s.p; p.receipts = p.receipts.filter((r) => r.name.trim()).map((r, i) => ({ ...r, id: i + 1, name: r.name.trim() }));
        if (s.action === "merge" && s.dups[0]) { // 既存顧客へ追加のみ(上書きしない)
          const t = s.dups[0].c, have = new Set([t.call, t.real, ...t.aliases].map(norm)); let mx = Math.max(0, ...t.receipts.map((r) => r.id));
          [p.call, ...p.aliases].forEach((a) => { if (a && !have.has(norm(a))) { have.add(norm(a)); t.aliases.push(a); } });
          p.receipts.forEach((r) => { if (!activeReceipts(t).some((x) => norm(x.name) === norm(r.name))) t.receipts.push({ ...r, id: ++mx, primary: false }); });
          t.updatedAt = Date.now(); t._t = null; await db.put(t); m++;
        } else { await db.put({ ...p, createdAt: Date.now(), updatedAt: Date.now() }); n++; }
      }
      await reload(); clear(out); out.append(h("div", { class: "banner ok" }, `登録 ${n}件 / 既存に追加 ${m}件`),
        h("div", { class: "banner info" }, "取り込んだ名前にはフリガナがありません。「たなか」のような読みで検索したい場合は、顧客の編集でフリガナを入れてください。")); document.querySelector("header small").textContent = `${live().length}件 ・ このスマホ内に保存`;
    } }, "選択した内容を登録");
    out.append(sum, h("div", { class: "row" }, h("button", { class: "btn sub sm", onclick: () => { st.forEach((s) => (s.on = !!s.p.call)); draw(); } }, "すべて選択"), h("button", { class: "btn sub sm", onclick: () => { st.forEach((s) => (s.on = !s.dups.length && !!s.p.call)); draw(); } }, "重複なしのみ選択"), h("button", { class: "btn sub sm", onclick: () => { st.forEach((s) => (s.on = false)); draw(); } }, "選択解除")), list, go);
  };
  const guard = (fn) => async () => { try { const r = await fn(); if (!r.length) throw new Error("取り込めるデータがありませんでした"); show(r); } catch (e) { toast(e.message, true); } };
  shell(h("h3", {}, "データ取込"), h("div", { class: "banner info" }, "文章の貼り付け・CSV・テキストに対応。登録前に必ず確認画面が出ます。（写真のOCRとExcelは、このアプリでは未対応です）"), ta,
    h("button", { class: "btn w", onclick: guard(async () => parseText(ta.value)) }, "貼り付けた内容を解析"), h("hr"),
    h("label", {}, "CSV・テキスト（CSVは1行目に「呼び名」「領収書名」などの見出し）"), file, h("div", { style: "height:8px" }),
    h("button", { class: "btn sub w", onclick: guard(async () => {
      const f = file.files[0]; if (!f) throw new Error("ファイルを選択してください"); if (f.size > 5e6) throw new Error("ファイルが大きすぎます（上限5MB）");
      const buf = await f.arrayBuffer(); let t; try { t = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch (e) { t = new TextDecoder("shift_jis").decode(buf); }
      return /\.csv$/i.test(f.name) ? parseCSV(t) : parseText(t);
    }) }, "ファイルを解析"), out);
}

// ---------- 設定・バックアップ ----------
function download(name, mime, data) {
  const a = h("a", { href: URL.createObjectURL(new Blob([data], { type: mime })), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function settingsView() {
  const last = await db.getMeta("lastBackup"), persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
  const dupBox = h("div"), file = h("input", { type: "file", accept: ".json" });
  const backup = async () => { const data = JSON.stringify({ app: "receipt-local", version: 1, exportedAt: new Date().toISOString(), customers: LIST }, null, 1); download(`receipt-backup-${today()}.json`, "application/json", data); await db.setMeta("lastBackup", Date.now()); toast("バックアップを書き出しました。ファイルを大切に保管してください"); setTimeout(render, 300); };
  const csv = () => {
    const head = ["呼び名", "本名", "フリガナ", "ニックネーム", "領収書名", "領収書名フリガナ", "会社名", "職業", "特徴", "検索キーワード", "メモ", "最終確認日"];
    const rows = live().map((c) => [c.call, c.real, c.realYomi, c.aliases.join("；"), activeReceipts(c).map((r) => r.name).join("；"), activeReceipts(c).map((r) => r.yomi).join("；"), c.company, c.industry, c.features, c.keywords.join("；"), c.memo, c.lastConfirmed || ""]);
    download(`customers-${today()}.csv`, "text/csv;charset=utf-8", "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")); toast("CSVを書き出しました");
  };
  const restore = async (mode) => {
    const f = file.files[0]; if (!f) return toast("バックアップファイルを選択してください", true);
    let d; try { d = JSON.parse(await f.text()); if (d.app !== "receipt-local" || !Array.isArray(d.customers)) throw 0; } catch (e) { return toast("このアプリのバックアップファイルではありません", true); }
    if (mode === "replace") { if (!confirm(`現在の${live().length}件をすべて消して、バックアップの${d.customers.length}件に置き換えます。よろしいですか？`)) return; await db.clearAll(); await db.putMany(d.customers); }
    else { const have = new Set(LIST.map((c) => c.createdAt + "|" + c.call)); const add = d.customers.filter((c) => !have.has(c.createdAt + "|" + c.call)).map(({ id, ...c }) => c); await db.putMany(add); toast(`${add.length}件を追加しました`); }
    await reload(); render(); toast("読み込みました");
  };
  const scan = () => { clear(dupBox); const d = scanDuplicates(LIST); if (!d.length) return dupBox.append(h("div", { class: "mute" }, "重複候補はありません"));
    d.forEach((x) => dupBox.append(h("div", { class: "card" }, h("span", { class: "chip" }, x.level === "high" ? "可能性高" : "可能性あり"), h("div", { class: "mute" }, x.why),
      h("div", {}, `${x.a.call}（${activeReceipts(x.a).map((r) => r.name).join("/") || "未登録"}）`), h("div", {}, `${x.b.call}（${activeReceipts(x.b).map((r) => r.name).join("/") || "未登録"}）`)))); };
  shell(h("h3", {}, "設定・バックアップ"),
    h("div", { class: "card" }, h("b", {}, "バックアップ"), h("div", { class: "mute" }, last ? `最終: ${new Date(last).toLocaleString("ja-JP")}` : "まだ書き出していません"),
      h("p", { class: "mute" }, "データはこのスマホのブラウザ内にだけあります。ブラウザのデータ削除・機種変更・長期間未使用で消えることがあるため、定期的に書き出してください。"),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: backup }, "バックアップを書き出す"), h("button", { class: "btn sub", onclick: csv }, "CSVで書き出す"))),
    h("div", { class: "card" }, h("b", {}, "バックアップから戻す"), file, h("div", { class: "row" }, h("button", { class: "btn sub sm", onclick: () => restore("merge") }, "追加で読み込む"), h("button", { class: "btn bad sm", onclick: () => restore("replace") }, "置き換えて読み込む"))),
    h("div", { class: "card" }, h("b", {}, "データの保護"), h("div", { class: "mute" }, persisted === null ? "この端末は保存保護の状態を確認できません" : persisted ? "保存保護: オン（自動で消されにくい状態）" : "保存保護: オフ"),
      persisted === false ? h("button", { class: "btn sub sm", onclick: async () => { const ok = await navigator.storage.persist(); toast(ok ? "保存保護をオンにしました" : "許可されませんでした。ホーム画面に追加すると安定します", !ok); render(); } }, "保存保護をリクエスト") : null,
      h("p", { class: "mute" }, "iPhoneは、ホーム画面に追加して使うと、保存データが消えにくくなります（共有ボタン → ホーム画面に追加）。")),
    h("div", { class: "card" }, h("b", {}, "重複候補の確認"), h("div", { class: "mute" }, "同じ人かもしれない顧客を探します（自動統合はしません）"), h("button", { class: "btn sub sm", onclick: scan }, "確認する"), dupBox),
    h("div", { class: "card" }, h("b", {}, "全データの削除"), h("div", { class: "mute" }, "元に戻せません。先にバックアップしてください。"),
      h("button", { class: "btn bad sm", onclick: async () => { if (!confirm("すべての顧客データを削除します。よろしいですか？")) return; if (prompt("確認のため「削除」と入力してください") !== "削除") return; await db.clearAll(); await reload(); toast("削除しました"); render(); } }, "すべて削除")));
}

async function render() {
  try { await ({ search: searchView, list: listView, import: importView, settings: settingsView }[VIEW])(); } catch (e) { toast(e.message, true); }
}
(async () => {
  try { await reload(); if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); }
  catch (e) { clear($app); $app.append(h("main", {}, h("div", { class: "banner err" }, "この端末・ブラウザでは保存機能を使えません（プライベートブラウズを解除してください）。"))); return; }
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
