/**
 * RO BuildFinder 画面.
 * 今の状態と目標、スキル、カード・エンチャ、部位ごとの設定、除外装備、検索と結果一覧を受け持つ。
 * シミュ専用の設定はクッキー（bf_conf）に保存する（URL出力には入れない）。
 */
import {
	BF_REGIONS, search, evalModel, skillTimes, nakedModel, modelFromScreen, attackSkillsOf,
	itemName, cardName, allCardNames, BfStopped,
} from "./bf-engine.js";
import { BF_METRICS, BF_GROUPS, BF_METRIC_BY_KEY } from "./bf-metrics.js";
import { ItemObjNew } from "../../../engine/equip/item.dat.js";
import { loadPrices, priceOfFactory, priceWorlds } from "./bf-price.js";

const COOKIE = "bf_conf";
const DEFAULT_WORLD = "Noatun";
const h = (tag, attrs = {}, ...kids) => {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") e.className = v;
		else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
		else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
	}
	for (const c of kids.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
	return e;
};
const fmtNum = (v) => (Math.round(v * 100) / 100).toLocaleString("ja-JP");
const fmtZeny = (v) => v == null ? "—" : Math.round(v).toLocaleString("ja-JP") + " z";
const fmtSec = (ms) => (ms / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 2 }) + "秒";
const numOrNull = (s) => (s === "" || s == null || !Number.isFinite(Number(s))) ? null : Number(s);

// ---- 設定（クッキー） ----
const defaultConf = () => ({
	targets: {},      // 指標キー -> 目標値
	skillTargets: {}, // skillId -> {cf: 短縮ms, ct: 短縮ms}
	cardRows: null,   // [[cardId, 個数]]（null なら今付いているものを入れる）
	regionMode: {},   // regionKey -> "free" | "keep" | "lock"
	ngItems: [], ngCards: [],
	maxResults: 30, world: DEFAULT_WORLD, sort: "changes",
});
let conf = defaultConf();
function loadConf() {
	const m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([^;]*)"));
	if (!m) return;
	try {
		const c = JSON.parse(decodeURIComponent(m[1]));
		conf = { ...defaultConf(), ...c };
		if (!conf.targets || Array.isArray(conf.targets)) conf.targets = {};
	} catch { /* 壊れていたら既定値 */ }
}
function saveConf() {
	document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(conf))}; max-age=${60 * 60 * 24 * 365 * 5}; path=/; SameSite=Lax`;
}

// ---- 名前の一覧 ----
let itemNameList = null, cardNameList = null;
function itemNames() {
	if (!itemNameList) {
		const kinds = new Set([...BF_REGIONS.flatMap((r) => r.kinds || []), ...Array.from({ length: 22 }, (_, i) => i + 1)]);
		itemNameList = [];
		for (const x of ItemObjNew) if (x && kinds.has(x[1]) && x[8] && !/装備なし$/.test(x[8])) itemNameList.push([x[0], x[8]]);
	}
	return itemNameList;
}
function cardNames() {
	if (!cardNameList) cardNameList = allCardNames();
	return cardNameList;
}

// ---- スキルの説明（公式ツールの内容） ----
let skillInfo = null;
async function loadSkillInfo() {
	try {
		const res = await fetch(new URL("./bf-skills.json", import.meta.url));
		skillInfo = res.ok ? await res.json() : {};
	} catch { skillInfo = {}; }
}
const skillInfoOf = (name) => skillInfo?.[String(name).replace(/\s+/g, "")] || null;

// ---- ツールチップ ----
let tip;
function showTip(e, content) {
	if (!tip) { tip = h("div", { class: "bf-tip" }); document.body.append(tip); }
	tip.replaceChildren(content);
	tip.style.display = "block";
	const pad = 14, w = tip.offsetWidth, ht = tip.offsetHeight;
	let x = e.clientX + pad, y = e.clientY + pad;
	if (x + w > innerWidth - 8) x = Math.max(8, e.clientX - w - pad);
	if (y + ht > innerHeight - 8) y = Math.max(8, innerHeight - ht - 8);
	tip.style.left = x + "px"; tip.style.top = y + "px";
}
function hideTip() { if (tip) tip.style.display = "none"; }

// ---- 画面 ----
let root, stateBox, skillBox, cardBox, regionBox, ngBox, progressBox, resultBox, worldSelect, searchBtn, stopBtn;
let lastResults = null, stopFlag = false, running = false, prices = null, lastModel = null, skillList = [];

export async function initBuildFinder(container) {
	loadConf();
	root = container;
	root.append(
		h("h2", { class: "bf-title" }, "装備シミュレーター"),
		h("p", { class: "bf-lead" }, "上で今の装備を設定し、目標を入れて検索すると、今の装備から目標を達成できる構成を探します。"),
		section("今の状態と目標", stateBox = h("div", { class: "bf-state" })),
		section("スキル", skillBox = h("div", { class: "bf-skills" })),
		section("カード・エンチャ", cardBox = h("div", { class: "bf-cardrows" })),
		section("部位ごとの設定", regionBox = h("table", { class: "bf-regions" })),
		section("除外装備", buildNg()),
		section("検索", buildSearch()),
		resultBox = h("div", { class: "bf-results" }),
		licenseNote(),
	);
	[prices] = await Promise.all([loadPrices(), loadSkillInfo()]);
	renderWorldSelect();
	refreshAll();
	let timer = 0;
	document.addEventListener("change", (e) => {
		if (root.contains(e.target)) return;
		clearTimeout(timer);
		timer = setTimeout(refreshAll, 400);
	});
}

function section(title, body) {
	return h("section", { class: "bf-sec" }, h("h3", {}, title), body);
}

function licenseNote() {
	return h("p", { class: "bf-license" },
		"RO BuildFinder は ",
		h("a", { href: "https://github.com/roratorio-hub/ratorio", target: "_blank", rel: "noopener" }, "ラトリオHUB"),
		" の計算部分を使って作っています（非営利・",
		h("a", { href: "https://polyformproject.org/licenses/noncommercial/1.0.0", target: "_blank", rel: "noopener" }, "PolyForm Noncommercial 1.0.0"),
		"）。ラトリオ、ラトリオ避難所、データ提供者の皆さまへの謝辞と著作権表示は ",
		h("a", { href: "../../LICENSE", target: "_blank" }, "LICENSE"), " の Required Notice を参照。値段は公式ツールの取引履歴から集計しています。");
}

function refreshAll() {
	let model;
	try { model = modelFromScreen(); } catch { stateBox.textContent = "計算の準備中です"; return; }
	lastModel = model;
	renderState(model);
	renderCards(model);
	renderRegions(model);
	renderSkills(model);
}

// ---- 今の状態と目標 ----
function renderState(model) {
	const val = evalModel(model);
	const grid = h("div", { class: "bf-metrics" });
	for (const g of BF_GROUPS) {
		const ms = BF_METRICS.filter((m) => m.group === g);
		grid.append(h("div", { class: "bf-mgroup" }, h("div", { class: "bf-mgroup-title" }, g),
			h("table", {}, h("tr", { class: "bf-mhead" }, h("th", {}), h("th", {}, "今"), h("th", {}, "目標")),
				ms.map((m) => {
					const t = conf.targets[m.key];
					const met = t != null && val[m.key] >= t;
					return h("tr", { class: t != null ? (met ? "bf-met" : "bf-unmet") : "" },
						h("th", {}, m.label),
						h("td", { class: val[m.key] ? "bf-cur" : "bf-cur bf-zero" }, fmtNum(val[m.key]) + (m.unit ? m.unit : "")),
						h("td", {}, h("input", { type: "number", step: "any", class: "bf-target", value: t ?? "", placeholder: "—",
							onchange: (e) => { const v = numOrNull(e.target.value); if (v == null) delete conf.targets[m.key]; else conf.targets[m.key] = v; saveConf(); renderState(lastModel); } })));
				}))));
	}
	stateBox.replaceChildren(grid);
}

// ---- スキル ----
let skillRenderToken = 0;
async function renderSkills(model) {
	const token = ++skillRenderToken;
	skillList = attackSkillsOf(model.status.jobId).filter(([id]) => id !== 0).reverse();
	if (!skillList.length) { skillBox.replaceChildren(h("p", { class: "bf-zero" }, "職業を選択してください")); return; }
	const naked = nakedModel(model);
	const table = h("table", { class: "bf-skilltable" },
		h("thead", {}, h("tr", {},
			h("th", { class: "bf-sk-name" }, "スキル"),
			h("th", {}, "固定詠唱"), h("th", {}, "装備での短縮"), h("th", {}, "目標の短縮"),
			h("th", {}, "CT"), h("th", {}, "装備での短縮"), h("th", {}, "目標の短縮"))));
	const tbody = h("tbody");
	table.append(tbody);
	skillBox.replaceChildren(table);
	const cells = [];
	for (const [id, name, maxLv] of skillList) {
		const info = skillInfoOf(name);
		const tgt = conf.skillTargets[id] || {};
		const nameEl = h("span", { class: "bf-sk-label" }, name);
		if (info) {
			nameEl.addEventListener("mousemove", (e) => showTip(e, skillTipContent(name, info)));
			nameEl.addEventListener("mouseleave", hideTip);
		}
		const link = info ? h("a", { href: `https://rotool.gungho.jp/skill/${info.c}`, target: "_blank", rel: "noopener", class: "bf-sk-link", title: "公式ツールを開く" }, "🔗") : null;
		const mk = (kind) => h("input", { type: "number", min: 0, step: 100, class: "bf-target", value: tgt[kind] ?? "", placeholder: "—",
			onchange: (e) => {
				const v = numOrNull(e.target.value);
				const t = conf.skillTargets[id] || (conf.skillTargets[id] = {});
				if (v == null) delete t[kind]; else t[kind] = Math.abs(v);
				if (t.cf == null && t.ct == null) delete conf.skillTargets[id];
				saveConf();
			} });
		const c = { cf: h("td", { class: "bf-cur" }, "…"), cfr: h("td", { class: "bf-cur" }, "…"), ct: h("td", { class: "bf-cur" }, "…"), ctr: h("td", { class: "bf-cur" }, "…") };
		tbody.append(h("tr", { class: tgt.cf != null || tgt.ct != null ? "bf-sk-on" : "" },
			h("td", { class: "bf-sk-name" }, link, nameEl),
			c.cf, c.cfr, h("td", {}, "−", mk("cf"), "ms"),
			c.ct, c.ctr, h("td", {}, "−", mk("ct"), "ms")));
		cells.push([id, maxLv, c]);
	}
	// 計算は1スキルずつ（画面が固まらないように間をあける）
	for (const [id, maxLv, c] of cells) {
		await new Promise((r) => setTimeout(r, 0));
		if (token !== skillRenderToken) return;
		let t, n;
		try { t = skillTimes(model, id, maxLv); n = skillTimes(naked, id, maxLv); } catch { continue; }
		c.cf.textContent = fmtSec(t.cf);
		c.cfr.textContent = n.cf - t.cf ? `−${n.cf - t.cf}ms` : "—";
		c.ct.textContent = fmtSec(t.ct);
		c.ctr.textContent = n.ct - t.ct ? `−${n.ct - t.ct}ms` : "—";
	}
}
function skillTipContent(name, info) {
	const box = h("div", {}, h("div", { class: "bf-tip-title" }, name));
	const rows = [["習得条件", info.q], ["MaxLv", info.m], ["系列", info.t], ["内容", info.d], ["効果詳細", info.e]].filter(([, v]) => v);
	for (const [k, v] of rows) box.append(h("div", { class: "bf-tip-row" }, h("b", {}, k), h("span", {}, v)));
	const lvRows = [["固定詠唱", info.cf], ["変動詠唱", info.cv], ["CT", info.ct], ["ディレイ", info.dl]].filter(([, v]) => v && v.some((x) => x && x !== "-"));
	if (lvRows.length && info.lv?.length) {
		box.append(h("table", { class: "bf-tip-table" },
			h("tr", {}, h("th", {}), info.lv.map((l) => h("th", {}, l))),
			lvRows.map(([k, vs]) => h("tr", {}, h("th", {}, k), vs.map((v) => h("td", {}, v))))),
		h("div", { class: "bf-tip-note" }, "単位: ms"));
	}
	return box;
}

// ---- カード・エンチャ ----
function currentCardCounts(model) {
	const counts = new Map();
	for (const cid of model.card) if (cid > 0 && cardName(cid)) counts.set(cid, (counts.get(cid) || 0) + 1);
	return counts;
}
function renderCards(model) {
	if (conf.cardRows == null) {
		conf.cardRows = [...currentCardCounts(model)].map(([cid, n]) => [cid, n]);
		saveConf();
	}
	const counts = currentCardCounts(model);
	const rows = conf.cardRows.filter(([cid]) => cid > 0);
	// 選択中のプルダウンを閉じてから作り直す（フォーカス移動中の作り直しで落ちないように）
	for (const ts of cardTs.splice(0)) try { ts.destroy(); } catch { /* 済み */ }
	cardBox.replaceChildren(
		h("p", { class: "bf-note" }, "付けたいカード・エンチャ（潜在解放など）と個数。今付いているものは最初から入っています。"),
		h("table", { class: "bf-cardtable" },
			h("tr", {}, h("th", {}, "カード・エンチャ"), h("th", {}, "今"), h("th", {}, "目標の個数"), h("th", {})),
			rows.map((row, i) => cardRow(row, i, counts)),
			cardRow([0, 1], rows.length, counts)));
}
const cardTs = [];
function cardRow(row, i, counts) {
	const [cid, n] = row;
	const sel = h("select", { class: "bf-cardsel" }, h("option", { value: "" }, ""));
	if (cid) sel.append(h("option", { value: cid, selected: true }, cardName(cid)));
	const num = h("input", { type: "number", min: 0, max: 12, value: cid ? n : 1, class: "bf-count",
		onchange: () => { if (!cid) return; conf.cardRows[i][1] = Math.max(0, Number(num.value) || 0); saveConf(); } });
	const del = cid ? h("button", { type: "button", class: "bf-x", title: "削除", onclick: () => { conf.cardRows.splice(i, 1); saveConf(); renderCards(lastModel); } }, "✕") : null;
	const tr = h("tr", {}, h("td", {}, sel), h("td", { class: "bf-cur" }, cid ? String(counts.get(cid) || 0) : ""), h("td", {}, num), h("td", {}, del));
	queueMicrotask(() => {
		if (!window.TomSelect) return;
		const ts = new window.TomSelect(sel, {
			options: cardNames().map(([id, name]) => ({ value: String(id), text: name })),
			maxOptions: 200, placeholder: "名前を入力して選ぶ", allowEmptyOption: true,
			onChange: (v) => {
				const id = Number(v) || 0;
				if (!id) return;
				if (cid) conf.cardRows[i][0] = id; else conf.cardRows.push([id, Number(num.value) || 1]);
				saveConf();
				setTimeout(() => renderCards(lastModel), 0);
			},
		});
		cardTs.push(ts);
		if (cid) ts.setValue(String(cid), true);
	});
	return tr;
}

// ---- 部位ごとの設定 ----
const MODES = [["free", "自由"], ["keep", "装備だけ固定"], ["lock", "完全固定"]];
function renderRegions(model) {
	regionBox.replaceChildren(h("tr", {}, h("th", {}, "部位"), h("th", {}, "今の装備"), h("th", {}, "扱い")));
	for (const r of BF_REGIONS) {
		const mode = conf.regionMode[r.key] || "free";
		const cur = model?.equip?.[r.eq];
		const btns = h("div", { class: "bf-modes" }, MODES.map(([k, label]) => h("button", { type: "button", class: "bf-mode" + (k === mode ? " on" : ""),
			onclick: () => { conf.regionMode[r.key] = k; saveConf(); renderRegions(lastModel); } }, label)));
		regionBox.append(h("tr", {}, h("td", {}, r.label), h("td", {}, cur ? itemName(cur) : "—"), h("td", {}, btns)));
	}
}

// ---- 除外装備 ----
function buildNg() {
	ngBox = h("div", { class: "bf-ng-list" });
	const sel = h("select", {}, h("option", { value: "" }, ""));
	queueMicrotask(() => {
		if (!window.TomSelect) return;
		const ts = new window.TomSelect(sel, {
			options: [...itemNames().map(([id, n]) => ({ value: "i" + id, text: n })), ...cardNames().map(([id, n]) => ({ value: "c" + id, text: n }))],
			maxOptions: 200, placeholder: "除外する装備・カード・エンチャの名前を入力", allowEmptyOption: true,
			onChange: (v) => {
				if (!v) return;
				const id = Number(v.slice(1));
				const list = v[0] === "i" ? conf.ngItems : conf.ngCards;
				if (!list.includes(id)) list.push(id);
				saveConf(); renderNg();
				ts.clear(true);
			},
		});
	});
	renderNg();
	return h("div", {}, h("p", { class: "bf-note" }, "ここに入れた装備・カード・エンチャは検索結果に出しません。"), h("div", { class: "bf-ngsel" }, sel), ngBox);
}
function renderNg() {
	ngBox.replaceChildren(
		...conf.ngItems.map((id, i) => chip(itemName(id), () => { conf.ngItems.splice(i, 1); saveConf(); renderNg(); })),
		...conf.ngCards.map((id, i) => chip(cardName(id), () => { conf.ngCards.splice(i, 1); saveConf(); renderNg(); })),
	);
	if (!ngBox.children.length) ngBox.append(h("span", { class: "bf-zero" }, "なし"));
}
function chip(label, onRemove) {
	return h("span", { class: "bf-chip" }, label, h("button", { type: "button", title: "外す", onclick: onRemove }, "✕"));
}

// ---- 検索 ----
function buildSearch() {
	const maxIn = h("input", { type: "number", min: 1, max: 200, value: conf.maxResults, style: "width:4em", onchange: () => { conf.maxResults = Number(maxIn.value) || 30; saveConf(); } });
	worldSelect = h("select", { onchange: () => { conf.world = worldSelect.value; saveConf(); if (lastResults) renderResults(); } });
	searchBtn = h("button", { type: "button", class: "bf-go", onclick: runSearch }, "検索");
	stopBtn = h("button", { type: "button", class: "bf-stop", disabled: true, onclick: () => { stopFlag = true; } }, "止める");
	progressBox = h("div", { class: "bf-progress" });
	return h("div", {},
		h("div", { class: "bf-opts" },
			h("label", {}, "値段のワールド: ", worldSelect),
			h("label", {}, "表示件数: ", maxIn)),
		h("div", { class: "bf-actions" }, searchBtn, stopBtn),
		progressBox);
}
function renderWorldSelect() {
	const worlds = priceWorlds(prices);
	if (!worlds.includes(conf.world)) conf.world = worlds.includes(DEFAULT_WORLD) ? DEFAULT_WORLD : (worlds[0] || DEFAULT_WORLD);
	worldSelect.replaceChildren(...(worlds.length ? worlds.map((w) => h("option", { value: w, selected: w === conf.world }, w)) : [h("option", { value: "" }, "値段データなし")]));
}

function buildConds() {
	const conds = [];
	for (const [key, t] of Object.entries(conf.targets)) if (BF_METRIC_BY_KEY[key] && t != null) conds.push({ key, target: t, label: BF_METRIC_BY_KEY[key].label, unit: BF_METRIC_BY_KEY[key].unit });
	const skillLv = {};
	for (const [id, t] of Object.entries(conf.skillTargets)) {
		const sk = skillList.find(([sid]) => sid === Number(id));
		if (!sk) continue;
		skillLv[id] = sk[2];
		if (t.cf != null) conds.push({ key: `sk:${id}:cf`, target: t.cf, label: `${sk[1]} 固定詠唱の短縮`, unit: "ms" });
		if (t.ct != null) conds.push({ key: `sk:${id}:ct`, target: t.ct, label: `${sk[1]} CTの短縮`, unit: "ms" });
	}
	const counts = lastModel ? currentCardCounts(lastModel) : new Map();
	for (const [cid, n] of conf.cardRows || []) {
		// 今と同じ個数のものは「外さない」条件としてだけ効く。0個は条件にしない
		if (cid > 0 && n > 0) conds.push({ key: "card:" + cid, target: n, label: cardName(cid), unit: "個", cur: counts.get(cid) || 0 });
	}
	return { conds, skillLv };
}

async function runSearch() {
	if (running) return;
	const { conds, skillLv } = buildConds();
	if (!conds.length) { progressBox.textContent = "目標を1つ以上入れてください。"; return; }
	running = true; stopFlag = false;
	searchBtn.disabled = true; stopBtn.disabled = false;
	resultBox.replaceChildren();
	const t0 = performance.now();
	try {
		const res = await search({
			conds, skillLv,
			locked: BF_REGIONS.filter((r) => conf.regionMode[r.key] === "lock").map((r) => r.key),
			keepItem: BF_REGIONS.filter((r) => conf.regionMode[r.key] === "keep").map((r) => r.key),
			ngItems: conf.ngItems, ngCards: conf.ngCards,
			maxResults: conf.maxResults,
			priceOf: priceOfFactory(prices, conf.world),
			onProgress: (text, ratio) => { progressBox.textContent = `${text}（${Math.round(ratio * 100)}%）`; },
			shouldStop: () => stopFlag,
		});
		lastResults = { ...res, conds };
		const sec = Math.round((performance.now() - t0) / 1000);
		progressBox.textContent = res.results.length ? `${res.results.length}件見つかりました（${sec}秒）` : `条件を満たす構成は見つかりませんでした（${sec}秒）`;
		renderResults();
	} catch (e) {
		if (e instanceof BfStopped) progressBox.textContent = "止めました。";
		else { progressBox.textContent = "エラー: " + e.message; console.error(e); }
	} finally {
		running = false; searchBtn.disabled = false; stopBtn.disabled = true;
	}
}

// ---- 結果 ----
function renderResults() {
	if (!lastResults) return;
	const { results, baseVal, conds } = lastResults;
	const sortSel = h("select", { onchange: () => { conf.sort = sortSel.value; saveConf(); renderResults(); } },
		h("option", { value: "changes", selected: conf.sort === "changes" }, "変更箇所が少ない順"),
		h("option", { value: "price", selected: conf.sort === "price" }, "値段が安い順"));
	const list = results.slice().sort(conf.sort === "price"
		? (a, b) => (a.price - b.price) || (a.changes - b.changes)
		: (a, b) => (a.changes - b.changes) || (a.price - b.price));
	resultBox.replaceChildren(
		h("div", { class: "bf-res-head" }, h("h3", {}, "結果"), "並べ替え: ", sortSel),
		h("div", { class: "bf-res-list" }, list.map((r, i) => h("div", { class: "bf-res" },
			h("div", { class: "bf-res-top" },
				h("span", { class: "bf-res-no" }, "#" + (i + 1)),
				h("span", {}, `変更 ${r.changes}か所`),
				h("span", { class: "bf-res-price" }, r.price > 0 ? fmtZeny(r.price) : "値段データなし")),
			h("table", { class: "bf-res-vals" }, conds.map((c) => h("tr", {}, h("th", {}, c.label),
				h("td", {}, `${fmtNum(baseVal[c.key])} → `, h("b", {}, fmtNum(r.values[c.key])), c.unit ? " " + c.unit : "")))),
			h("ul", { class: "bf-res-picks" }, r.picks.map((pk) => h("li", {},
				h("span", { class: "bf-res-region" }, pk.region.label),
				pk.keep ? h("span", { class: "bf-zero" }, "（今の装備のまま）") : h("span", { class: "bf-res-item" }, itemName(pk.itemId)),
				pk.cards.length ? h("span", { class: "bf-res-cards" }, " ＋ " + pk.cards.map(([, cid]) => cardName(cid)).join("、")) : null,
				pk.price > 0 ? h("span", { class: "bf-res-pprice" }, fmtZeny(pk.price)) : null))),
		))));
}
