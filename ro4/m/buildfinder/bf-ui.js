/**
 * RO BuildFinder 画面.
 * 今の状態と目標（エンチャントを含む）、スキル、固定装備、除外装備、検索と結果一覧を受け持つ。
 * シミュ専用の設定はクッキー（bf_conf）に保存する（URL出力には入れない）。
 */
import {
	BF_REGIONS, regionItem, getRefine, search, evalModel, skillTimes, nakedModel, modelFromScreen, attackSkillsOf,
	itemName, cardName, itemSlotCount, loadOfficial, allCardNames, allEnchantNames, isEnchant, isRegionEmpty, BfStopped, setBuffOn,
	fixedLock, withoutRegion, cancelPending,
} from "./bf-engine.js";
import { BF_METRICS, BF_GROUPS, BF_METRIC_BY_KEY, ELM_NAMES } from "./bf-metrics.js";
import { ItemObjNew } from "../../../engine/equip/item.dat.js";
import { CardObjNew } from "../../../engine/equip/card.dat.js";
import { loadPrices, priceOfFactory } from "./bf-price.js";
import { applyModelToScreen } from "./bf-apply.js";
import { get as registryGet } from "../../../engine/runtime/engine-registry.js";
import { ITEM_SP_TIME_OBJ } from "../../../engine/equip/timeitem.dat.js";
import { TIME_ITEM_DATA_INDEX_NAME, TIME_ITEM_DATA_INDEX_EXPLAIN } from "../../../engine/const/EnumTimeItemDataIndex.js";
import { g_timeItemDataBridge } from "../../../engine/equip/CTimeItemDataBridge.js";

const COOKIE = "bf_conf";
const MAX_RESULT_CHOICES = [10, 30, 100];
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
const fmtZeny = (v) => v == null ? "-" : Math.round(v).toLocaleString("ja-JP") + " z";
const fmtSec = (ms) => (ms / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 2 }) + "秒";
const numOrNull = (s) => {
	const t = String(s ?? "").trim().replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
	return t === "" || !Number.isFinite(Number(t)) ? null : Number(t);
};
const fmtMetric = (m, v) => m.kind === "elm" ? (ELM_NAMES[v] ?? "-") : m.kind === "bool" ? (v ? "あり" : "なし") : fmtNum(v) + (m.unit || "");

/** 数値の入力欄（上下の矢印なし）と、中身を消す✕ボタン */
function numInput(value, onChange, attrs = {}) {
	const inp = h("input", { type: "text", inputmode: "decimal", class: "bf-target", value: value ?? "", placeholder: "-", ...attrs,
		onchange: () => onChange(numOrNull(inp.value)) });
	const clear = h("button", { type: "button", class: "bf-clear", title: "消す", onclick: () => { inp.value = ""; onChange(null); } }, "✕");
	return h("span", { class: "bf-numwrap" }, inp, clear);
}

// ---- 設定（クッキー） ----
const defaultConf = () => ({
	targets: {},      // 指標キー -> 目標値
	potentialOn: [],  // スキル欄でオンにした潜在解放・潜在覚醒のエンチャントID（そのまま検索の目標になる）
	skillHidden: [],  // スキル欄から✕で消したスキル（プルダウンから戻せる）
	buffOn: {}, // 発動バフ（時限効果ID → オン）。載っていないものはオフ
	enchRows: null,   // [[エンチャントID, 目標の個数 or null]]（null なら今付いているものを入れる）
	enchRemoved: [],  // 一覧から外したエンチャント（今付いていても自動では入れ直さない）
	cardGoalRows: null, // [[カードID, 目標の枚数 or null]]（エンチャントと同じ仕組み）
	cardGoalRemoved: [],
	ngItems: [], ngCards: [],
	maxResults: 10, sort: "changes",
	maxResultsV: 2,   // 表示件数を 10/30/100 の選択式にした版
});
let conf = defaultConf();
function loadConf() {
	const m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([^;]*)"));
	if (!m) return;
	try {
		const c = JSON.parse(decodeURIComponent(m[1]));
		conf = { ...defaultConf(), ...c };
		if (!conf.targets || Array.isArray(conf.targets)) conf.targets = {};
		delete conf.cardRows; delete conf.world; delete conf.timeItems; delete conf.skillTargets;
		if (!Array.isArray(conf.potentialOn)) conf.potentialOn = [];
		// 部位ごとの固定は「固定装備」（画面で付けている装備を固定）に変わったので捨てる
		delete conf.regionMode; delete conf.regionLock;
		if (!conf.buffOn || typeof conf.buffOn !== "object") conf.buffOn = {};
		if (conf.targets.castVary != null) delete conf.targets.castVary;
		// 表示件数は 10/30/100 から選ぶ（自由入力だった頃の値は既定の10に戻す）
		if (c.maxResultsV !== 2 || !MAX_RESULT_CHOICES.includes(conf.maxResults)) { conf.maxResults = 10; conf.maxResultsV = 2; }
	} catch { /* 壊れていたら既定値 */ }
}
function saveConf() {
	document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(conf))}; max-age=${60 * 60 * 24 * 365 * 5}; path=/; SameSite=Lax`;
}

// ---- 名前の一覧 ----
let itemNameList = null, cardNameList = null, enchNameList = null;
function itemNames() {
	if (!itemNameList) {
		const kinds = new Set([...BF_REGIONS.flatMap((r) => r.kinds || []), ...Array.from({ length: 22 }, (_, i) => i + 1)]);
		itemNameList = [];
		for (const x of ItemObjNew) if (x && kinds.has(x[1]) && x[8] && !/装備なし$/.test(x[8])) itemNameList.push([x[0], x[8]]);
	}
	return itemNameList;
}
const cardNames = () => cardNameList || (cardNameList = allCardNames());
const enchNames = () => enchNameList || (enchNameList = allEnchantNames());
let cardGoalNameList = null;

// ---- ひらがな・カタカナ・読みでも引けるプルダウン検索（エンチャントDBと同じ寄せ方） ----
const SMALL = { "ァ": "ア", "ィ": "イ", "ゥ": "ウ", "ェ": "エ", "ォ": "オ", "ッ": "ツ", "ャ": "ヤ", "ュ": "ユ", "ョ": "ヨ", "ヮ": "ワ", "ヵ": "カ", "ヶ": "ケ" };
const toKata = (t) => t.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
/** 読みの比較用（カタカナにして濁点・小さい字をそろえる）。カナ以外が混ざる文字列は空 */
function yfold(t) {
	t = toKata(String(t ?? "").normalize("NFKC")).normalize("NFD").replace(/[\u3099\u309a]/g, "").normalize("NFC").replace(/[ァィゥェォッャュョヮヵヶ]/g, (c) => SMALL[c]);
	return /^[ァ-ヺー\s]+$/.test(t) ? t.replace(/\s+/g, "") : "";
}
const searchNorm = (s) => toKata(String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, ""));
let yomi = null; // エンチャント名 → 読み（エンチャントDBの data.json の ey から作った bf-yomi.json）
const yomiKey = (s) => String(s).normalize("NFKC").replace(/[<>＜＞\s]/g, "").toLowerCase();
const yomiBase = (s) => yomiKey(s).replace(/[+＋]?\d+%?$/, "");
async function loadYomi() {
	yomi = new Map();
	try {
		const res = await fetch(new URL("./bf-yomi.json", import.meta.url));
		const j = res.ok ? await res.json() : null;
		for (const [k, v] of Object.entries(j?.ey || {})) {
			yomi.set(yomiKey(k), v);
			if (!yomi.has("~" + yomiBase(k))) yomi.set("~" + yomiBase(k), v);
		}
	} catch { /* 読みなしで名前だけ */ }
}
/** カード・エンチャントの読み（カードはらとりおの読み、エンチャントは bf-yomi.json） */
function readingOf(cid) {
	const c = CardObjNew[cid];
	if (!c) return "";
	if (c[3]) return yfold(c[3]);
	const nm = c[2] || "";
	return yfold(yomi?.get(yomiKey(nm)) || yomi?.get("~" + yomiBase(nm)) || "");
}
/** TomSelect の候補と検索方法（名前の部分一致、ひらがな・カタカナ同一視、読みの部分一致） */
function kanaSelectOptions(list, reading = readingOf) {
	return {
		options: list.map(([id, name]) => ({ value: String(id), text: name, n: searchNorm(name), y: reading(id) })),
		searchField: ["text"],
		score: (q) => {
			const n = searchNorm(q), y = yfold(q);
			if (!n) return () => 1;
			return (o) => o.n.includes(n) ? 2 : y && o.y.includes(y) ? 1 : 0;
		},
	};
}
const cardGoalNames = () => cardGoalNameList || (cardGoalNameList = cardNames().filter(([id]) => !isEnchant(id)));

// ---- スキルの説明（公式ツールの内容） ----
let skillInfo = null;
async function loadSkillInfo() {
	try {
		const res = await fetch(new URL("./bf-skills.json", import.meta.url));
		skillInfo = res.ok ? await res.json() : {};
	} catch { skillInfo = {}; }
}
// 潜在解放（エンチャントDBの data.json から tools-bf-potential.py で作った bf-potential.json）
let potential = null, potentialId = null;
async function loadPotential() {
	try {
		const res = await fetch(new URL("./bf-potential.json", import.meta.url));
		potential = res.ok ? await res.json() : { sk: {}, en: {} };
	} catch { potential = { sk: {}, en: {} }; }
}
function potIdOf(name) {
	if (!potentialId) potentialId = new Map(allEnchantNames().map(([id, n]) => [n, id]));
	return potentialId.get(name) || 0;
}
/** スキルの固定詠唱(kind="f")・CT(kind="c")に関係する潜在系エンチャント [{id, name, desc, partners: [id]}] */
function potentialsOf(skillName, kind) {
	const list = potential?.sk?.[String(skillName).replace(/\s+/g, "")]?.[kind] || [];
	return list.map((name) => {
		const e = potential.en[name] || {};
		return { id: potIdOf(name), name, desc: e.d || "", partners: (e.s || []).map(potIdOf).filter((x) => x > 0), partnerNames: e.s || [] };
	}).filter((p) => p.id > 0);
}
/** 潜在解放と、その効果に要るセット相手（豪傑など）のID */
function potentialWithPartners(ids) {
	const out = new Set();
	for (const id of ids) {
		out.add(id);
		const name = cardName(id);
		for (const pn of potential?.en?.[name]?.s || []) { const pid = potIdOf(pn); if (pid) out.add(pid); }
	}
	return [...out];
}
/** 装備なしの状態に、選んだ潜在解放（とセット相手）を空いたエンチャント枠へ付けたもの */
function withPotentials(naked, ids) {
	const m = structuredClone(naked);
	const slots = BF_REGIONS.filter((r) => r.key !== "weapon").flatMap((r) => r.slots.slice(1)).filter((s) => s >= 0 && !(m.card[s] > 0));
	potentialWithPartners(ids).forEach((id, i) => { if (slots[i] != null) m.card[slots[i]] = id; });
	return m;
}
function potentialTip(p) {
	const box = h("div", {}, h("div", { class: "bf-tip-title" }, p.name));
	for (const line of p.desc.split("\n")) {
		const mm = line.match(/^\x02(.*?)\x03\s*(.*)$/);
		box.append(mm ? h("div", { class: "bf-tip-row" }, h("b", {}, mm[1]), h("span", {}, mm[2])) : h("div", {}, line));
	}
	if (p.partnerNames.length) box.append(h("div", { class: "bf-tip-note" }, `オンにすると ${p.partnerNames.join("・")} も目標に入ります`));
	return box;
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
let progressBar, root, timeBox, stateBox, enchBox, cardBox, skillBox, regionBox, ngBox, progressBox, resultBox, searchBtn, stopBtn;
let lastResults = null, curToken = null, running = false, prices = null, lastModel = null, skillList = [];

export async function initBuildFinder(container) {
	loadConf();
	root = container;
	root.append(
		section("今の状態と目標", h("div", {}, stateBox = h("div", { class: "bf-state" }), h("div", { class: "bf-enchrows" }, enchBox = h("div", {}), cardBox = h("div", {}), timeBox = h("div", {})))),
		section("スキル", skillBox = h("div", { class: "bf-skills" })),
		section("固定装備", regionBox = h("table", { class: "bf-regions" })),
		h("details", { class: "bf-sec bf-acc" }, h("summary", {}, h("h3", {}, "除外装備")), buildNg()),
		section("検索", buildSearch()),
		resultBox = h("div", { class: "bf-results" }),
	);
	setBuffOn(conf.buffOn);
	// 謝辞・ライセンスはページの一番下に置く
	document.body.append(h("div", { id: "BF_FOOT" }, licenseNote()));
	[prices] = await Promise.all([loadPrices(), loadSkillInfo(), loadPotential(), loadOfficial(), loadYomi()]);
	refreshAll();
	let timer = 0;
	document.addEventListener("change", (e) => {
		// シミュの欄の操作（作り直しで外れた部品も含む）では、らとりお側の作り直しはしない
		if (!e.target.isConnected || root.contains(e.target)) return;
		clearTimeout(timer);
		timer = setTimeout(refreshAll, 400);
	});
	// セーブデータの読み込みなど、change が起きずに職業・装備が変わることがあるので、1秒ごとに見比べて変わっていたら作り直す
	setInterval(() => {
		if (running) return;
		let sig;
		try { const m = modelFromScreen(); sig = JSON.stringify([m.status.jobId, m.equip, m.card]); } catch { return; }
		if (lastSig !== null && sig !== lastSig) refreshAll();
		lastSig = sig;
	}, 1000);
}
let lastSig = null;

function section(title, body) {
	return h("section", { class: "bf-sec" }, h("h3", {}, title), body);
}

function licenseNote() {
	return h("p", { class: "bf-license" },
		"RO装備シミュレーター は ",
		h("a", { href: "https://github.com/roratorio-hub/ratorio", target: "_blank", rel: "noopener" }, "ラトリオHUB"),
		" の計算部分を使って作っています（非営利・",
		h("a", { href: "https://polyformproject.org/licenses/noncommercial/1.0.0", target: "_blank", rel: "noopener" }, "PolyForm Noncommercial 1.0.0"),
		"）。ラトリオ、ラトリオ避難所、データ提供者の皆さまへの謝辞と著作権表示は ",
		h("a", { href: "../../LICENSE", target: "_blank" }, "LICENSE"), " の Required Notice を参照。値段は公式ツールの取引履歴から集計しています。",
		" Development いそにゃ with Claude ・ ", h("a", { href: "https://isonya-tools.web.app/", target: "_blank", rel: "noopener" }, "いそにゃ開発ツール集"));
}

function refreshAll() {
	let model;
	try { model = modelFromScreen(); } catch { stateBox.textContent = "計算の準備中です"; return; }
	lastModel = model;
	lastSig = JSON.stringify([model.status.jobId, model.equip, model.card]);
	freezeScreen();
	try {
		renderState(model);
		renderEnch(model);
		renderBuffs(model);
		renderRegions(model);
	} finally { thawScreen(); }
	renderSkills(model);
}

// ---- 上の計算欄（最大HP・最大SPなど）を止めておく ----
// シミュの計算もらとりおの計算本体を使うので、そのたびに上の欄が書き換わってちらつく。
// 計算中は欄の写しを見せて本物は隠し、終わったら画面の入力で計算し直して本物を戻す。
let freezeDepth = 0, frozen = null;
function freezeScreen() {
	if (freezeDepth++ > 0) return;
	const t = document.getElementById("OBJID_SPAN_CHARA_MAXHP")?.closest("table")?.parentElement?.closest("table");
	if (!t) return;
	const copy = t.cloneNode(true);
	for (const e of copy.querySelectorAll("[id]")) e.removeAttribute("id");
	t.before(copy);
	t.style.display = "none";
	frozen = { t, copy };
}
function thawScreen() {
	if (--freezeDepth > 0) return;
	freezeDepth = 0;
	try { registryGet("calcCoreFromModel")(registryGet("extractModelFromDom")()); } catch { /* 画面の準備前 */ }
	if (frozen) { frozen.copy.remove(); frozen.t.style.display = ""; frozen = null; }
}

// ---- 発動バフ（らとりおの「クイック調整」と同じ中身。個別にオンオフ、既定はオフ） ----
function renderBuffs(model) {
	const ids = (model.timeItemConf || []).filter((id) => id > 0);
	const setOn = (list, v) => {
		for (const id of list) { if (v) conf.buffOn[id] = true; else delete conf.buffOn[id]; }
		saveConf(); setBuffOn(conf.buffOn); refreshAll();
	};
	const toggle = (list, on) => h("span", { class: "bf-modes bf-inline" }, [[false, "OFF"], [true, "ON"]].map(([v, label]) =>
		h("button", { type: "button", class: "bf-mode" + (on === v ? " on" : ""), onclick: () => setOn(list, v) }, label)));
	const focus = h("button", { type: "button", class: "bf-del", onclick: () => g_timeItemDataBridge.focusArea?.(0, true) }, "設定欄を表示");
	const rows = [h("tr", {}, h("th", {}, "アイテム時限効果調整"), h("td", {}, focus))];
	if (ids.length) {
		const all = ids.every((id) => conf.buffOn[id]);
		rows.push(h("tr", {}, h("th", {}, "一斉変更"), h("td", {}, toggle(ids, all))));
		for (const id of ids) {
			const d = ITEM_SP_TIME_OBJ[id];
			rows.push(h("tr", {}, h("th", { class: "bf-buffname" }, d ? `${d[TIME_ITEM_DATA_INDEX_NAME]} [${d[TIME_ITEM_DATA_INDEX_EXPLAIN]}]` : String(id)),
				h("td", {}, toggle([id], !!conf.buffOn[id]))));
		}
	}
	timeBox.replaceChildren(h("div", { class: "bf-mgroup bf-buffgroup" }, h("div", { class: "bf-mgroup-title" }, "発動バフ"), h("table", {}, rows)));
}

// ---- 今の状態と目標 ----
function metricGroupsTable(val, opts = {}) {
	const { withTarget = false, before = null } = opts;
	const grid = h("div", { class: "bf-metrics" });
	for (const g of BF_GROUPS) {
		const ms = BF_METRICS.filter((m) => m.group === g);
		const head = h("tr", { class: "bf-mhead" }, h("th", {}), before ? h("th", {}, "今") : null, h("th", {}, before ? "この構成" : "今"), withTarget ? h("th", {}, "目標") : null);
		grid.append(h("div", { class: "bf-mgroup" }, h("div", { class: "bf-mgroup-title" }, g),
			h("table", {}, head, ms.map((m) => {
				const t = conf.targets[m.key];
				const met = t != null && (m.kind === "elm" ? val[m.key] === t : val[m.key] >= t);
				const changed = before && before[m.key] !== val[m.key];
				return h("tr", { class: (t != null ? (met ? "bf-met" : "bf-unmet") : "") + (changed ? " bf-changed" : ""), "data-key": withTarget ? m.key : null },
					h("th", {}, m.label),
					before ? h("td", { class: "bf-cur bf-before" }, fmtMetric(m, before[m.key])) : null,
					h("td", { class: val[m.key] ? "bf-cur" : "bf-cur bf-zero" }, fmtMetric(m, val[m.key])),
					withTarget ? h("td", {}, targetInput(m)) : null);
			}))));
	}
	return grid;
}
function targetInput(m) {
	const set = (v) => {
		if (v == null) delete conf.targets[m.key]; else conf.targets[m.key] = v;
		// 表を作り直すと、次に押した入力欄が消えて打った文字が入らないので、達成・未達成の色だけ付け直す
		saveConf(); markTargets();
	};
	if (m.kind === "elm") {
		const t = conf.targets[m.key];
		const sel = h("select", { class: "bf-target", onchange: () => set(sel.value === "" ? null : Number(sel.value)) },
			h("option", { value: "" }, "-"), ELM_NAMES.map((n, i) => h("option", { value: i, selected: t === i }, n)));
		return h("span", { class: "bf-numwrap" }, sel, h("button", { type: "button", class: "bf-clear", title: "消す", onclick: () => { sel.value = ""; set(null); } }, "✕"));
	}
	if (m.kind === "bool") {
		const t = conf.targets[m.key];
		const sel = h("select", { class: "bf-target", onchange: () => set(sel.value === "" ? null : 1) },
			h("option", { value: "" }, "-"), h("option", { value: "1", selected: t === 1 }, "あり"));
		return h("span", { class: "bf-numwrap" }, sel, h("button", { type: "button", class: "bf-clear", title: "消す", onclick: () => { sel.value = ""; set(null); } }, "✕"));
	}
	return numInput(conf.targets[m.key], set);
}
function renderState(model) {
	stateBox.replaceChildren(metricGroupsTable(evalModel(model), { withTarget: true }));
}
/** 目標の達成・未達成の色だけ付け直す（表は作り直さない） */
function markTargets() {
	if (!lastModel) return;
	const val = evalModel(lastModel);
	for (const tr of stateBox.querySelectorAll("tr[data-key]")) {
		const m = BF_METRICS.find((x) => x.key === tr.dataset.key);
		const t = conf.targets[m.key];
		const met = t != null && (m.kind === "elm" ? val[m.key] === t : val[m.key] >= t);
		tr.classList.toggle("bf-met", t != null && met);
		tr.classList.toggle("bf-unmet", t != null && !met);
	}
}

// ---- エンチャント・カードの目標（プルダウンで選んで個数を入れる。今付いているものは最初から一覧に入れる） ----
const GOAL_KINDS = {
	ench: { rows: "enchRows", removed: "enchRemoved", title: "エンチャント", head: "目標の個数", place: "エンチャントを追加（名前を入力）", is: (cid) => isEnchant(cid), names: () => enchNames(), box: () => enchBox },
	card: { rows: "cardGoalRows", removed: "cardGoalRemoved", title: "カード", head: "目標の枚数", place: "カードを追加（名前を入力）", is: (cid) => !isEnchant(cid), names: () => cardGoalNames(), box: () => cardBox },
};
const goalTs = { ench: [], card: [] };
function currentCounts(model, g) {
	const counts = new Map();
	for (const cid of model.card) if (cid > 0 && g.is(cid)) counts.set(cid, (counts.get(cid) || 0) + 1);
	return counts;
}
function renderEnch(model) { renderGoals(model, "ench"); renderGoals(model, "card"); }
function renderGoals(model, kind) {
	const g = GOAL_KINDS[kind];
	const counts = currentCounts(model, g);
	if (!Array.isArray(conf[g.rows])) conf[g.rows] = [];
	if (!Array.isArray(conf[g.removed])) conf[g.removed] = [];
	conf[g.rows] = conf[g.rows].filter(([cid]) => cid > 0 && g.is(cid));
	// 今付いているものは一覧に入れておく（目標は空欄のまま）
	for (const cid of counts.keys()) if (!conf[g.rows].some(([c]) => c === cid) && !conf[g.removed].includes(cid)) conf[g.rows].push([cid, null]);
	saveConf();
	// 選択中のプルダウンを閉じてから作り直す（フォーカス移動中の作り直しで落ちないように）
	for (const ts of goalTs[kind].splice(0)) try { ts.destroy(); } catch { /* 済み */ }
	g.box().replaceChildren(h("div", { class: "bf-mgroup bf-enchgroup" }, h("div", { class: "bf-mgroup-title" }, g.title),
		h("table", { class: "bf-cardtable" },
			h("tr", { class: "bf-mhead" }, h("th", {}), h("th", {}, "今"), h("th", {}, g.head), h("th", {})),
			conf[g.rows].map((row, i) => goalRow(kind, row, i, counts)),
			goalRow(kind, [0, null], conf[g.rows].length, counts))));
}
function goalRow(kind, row, i, counts) {
	const g = GOAL_KINDS[kind];
	const [cid, n] = row;
	const sel = h("select", { class: "bf-cardsel" }, h("option", { value: "" }, ""));
	if (cid) sel.append(h("option", { value: cid, selected: true }, cardName(cid)));
	const num = cid ? numInput(n, (v) => { conf[g.rows][i][1] = v == null ? null : Math.max(0, Math.floor(v)); saveConf(); }) : null;
	const del = cid ? h("button", { type: "button", class: "bf-del", title: "一覧から外す", onclick: () => {
		conf[g.rows].splice(i, 1);
		if (!conf[g.removed].includes(cid)) conf[g.removed].push(cid);
		saveConf(); renderGoals(lastModel, kind);
	} }, "外す") : null;
	const cur = cid ? counts.get(cid) || 0 : null;
	const tr = h("tr", {}, h("td", {}, sel), h("td", { class: cur ? "bf-cur" : "bf-cur bf-zero" }, cid ? String(cur) : ""), h("td", {}, num), h("td", {}, del));
	queueMicrotask(() => {
		if (!window.TomSelect) return;
		const ts = new window.TomSelect(sel, {
			...kanaSelectOptions(g.names()),
			maxOptions: 200, placeholder: cid ? "" : g.place, allowEmptyOption: true,
			onChange: (v) => {
				const id = Number(v) || 0;
				if (!id) return;
				// 一覧に既にあるものは足さない（同じ目標が2つにならないように）
				if (conf[g.rows].some(([c], j) => c === id && j !== i)) { setTimeout(() => renderGoals(lastModel, kind), 0); return; }
				if (cid) conf[g.rows][i][0] = id; else conf[g.rows].push([id, null]);
				conf[g.removed] = conf[g.removed].filter((x) => x !== id);
				saveConf();
				setTimeout(() => renderGoals(lastModel, kind), 0);
			},
		});
		goalTs[kind].push(ts);
		if (cid) ts.setValue(String(cid), true);
	});
	return tr;
}

// ---- スキル ----
let skillRenderToken = 0, skillTs = null;
const timedSkillCache = new Map(); // 職業ID → 固定詠唱かCTのあるスキルID
async function renderSkills(model) {
	freezeScreen();
	try { await renderSkillsInner(model); } finally { thawScreen(); }
}
async function renderSkillsInner(model) {
	const token = ++skillRenderToken;
	skillList = attackSkillsOf(model.status.jobId).filter(([id]) => id !== 0).reverse();
	if (skillTs) { try { skillTs.destroy(); } catch { /* 済み */ } skillTs = null; }
	if (!skillList.length) { skillBox.replaceChildren(h("p", { class: "bf-zero" }, "職業を選択してください")); return; }
	// 最初から、その職業の固定詠唱かCTがあるスキルを全部出す（✕で消したものはプルダウンから戻せる）
	const naked = nakedModel(model);
	const jobId = model.status.jobId;
	if (!timedSkillCache.has(jobId)) {
		skillBox.replaceChildren(h("p", { class: "bf-zero" }, "スキルを調べています"));
		const ids = new Set();
		for (const [id, , maxLv] of skillList) {
			await new Promise((r) => setTimeout(r, 0));
			if (token !== skillRenderToken) return;
			try { const n = skillTimes(naked, id, maxLv); if (n.cf > 0 || n.ct > 0) ids.add(id); } catch { /* 計算できないスキルは出さない */ }
		}
		timedSkillCache.set(jobId, ids);
	}
	const timed = timedSkillCache.get(jobId);
	if (!Array.isArray(conf.skillHidden)) conf.skillHidden = [];
	const shown = skillList.filter(([id]) => timed.has(id) && !conf.skillHidden.includes(id));
	const hidden = skillList.filter(([id]) => timed.has(id) && !shown.some(([s]) => s === id));

	const sel = h("select", {}, h("option", { value: "" }, ""));
	const adder = hidden.length ? h("div", { class: "bf-skilladd" }, sel) : null;
	if (adder) queueMicrotask(() => {
		if (!window.TomSelect) return;
		skillTs = new window.TomSelect(sel, {
			...kanaSelectOptions(hidden.map(([id, name]) => [id, name]), () => ""),
			maxOptions: 300, placeholder: "消したスキルを戻す（名前を入力）", allowEmptyOption: true,
			onChange: (v) => {
				const id = Number(v) || 0;
				if (!id) return;
				conf.skillHidden = conf.skillHidden.filter((x) => x !== id);
				saveConf();
				setTimeout(() => renderSkills(lastModel), 0);
			},
		});
	});
	if (!shown.length) { skillBox.replaceChildren(h("p", { class: "bf-zero" }, "固定詠唱・CTのあるスキルがありません"), adder || ""); return; }

	const table = h("table", { class: "bf-skilltable" },
		h("thead", {}, h("tr", {},
			h("th", {}),
			h("th", { class: "bf-sk-name" }, "スキル"),
			h("th", {}, "固定詠唱"), h("th", {}, "装備での短縮"), h("th", { class: "bf-sk-pot" }, "潜在解放"),
			h("th", {}, "CT"), h("th", {}, "装備での短縮"), h("th", { class: "bf-sk-pot" }, "潜在解放"))));
	const tbody = h("tbody");
	table.append(tbody);
	skillBox.replaceChildren(table, adder || "");
	const on = new Set(conf.potentialOn);
	const cells = [];
	for (const [id, name, maxLv] of shown) {
		const info = skillInfoOf(name);
		const nameEl = h("span", { class: "bf-sk-label" }, name);
		if (info) {
			nameEl.addEventListener("mousemove", (e) => showTip(e, skillTipContent(name, info)));
			nameEl.addEventListener("mouseleave", hideTip);
		}
		const potCell = (kind) => {
			const td = h("td", { class: "bf-sk-pot" });
			const pots = potentialsOf(name, kind);
			for (const p of pots) {
				const label = p.name.replace(/^潜在(解放|覚醒)\((.*)\)$/, "$2");
				const btn = h("button", { type: "button", class: "bf-pot" + (on.has(p.id) ? " on" : ""), onclick: () => {
					hideTip();
					if (on.has(p.id)) conf.potentialOn = conf.potentialOn.filter((x) => x !== p.id);
					else conf.potentialOn.push(p.id);
					saveConf(); renderSkills(lastModel);
				} }, label);
				btn.addEventListener("mousemove", (e) => showTip(e, potentialTip(p)));
				btn.addEventListener("mouseleave", hideTip);
				td.append(btn);
			}
			if (!pots.length) td.append("-");
			return [td, pots];
		};
		const [potF, potsF] = potCell("f"), [potC, potsC] = potCell("c");
		const del = h("button", { type: "button", class: "bf-clear", title: "一覧から消す", onclick: () => {
			if (!conf.skillHidden.includes(id)) conf.skillHidden.push(id);
			saveConf(); renderSkills(lastModel);
		} }, "✕");
		const mine = [...new Set([...potsF, ...potsC].filter((p) => on.has(p.id)).map((p) => p.id))];
		const c = { cf: h("td", { class: "bf-cur" }, "…"), cfr: h("td", { class: "bf-cur" }, "…"), ct: h("td", { class: "bf-cur" }, "…"), ctr: h("td", { class: "bf-cur" }, "…") };
		tbody.append(h("tr", { class: mine.length ? "bf-sk-on" : "" },
			h("td", { class: "bf-sk-del" }, del),
			h("td", { class: "bf-sk-name" }, nameEl),
			c.cf, c.cfr, potF, c.ct, c.ctr, potC));
		cells.push([id, maxLv, c, mine]);
	}
	// 計算は1スキルずつ（画面が固まらないように間をあける）
	// 固定詠唱・CT は「装備なしの秒数→オンにした潜在解放を付けたときの秒数」。装備での短縮は今の装備で縮む分
	for (const [id, maxLv, c, mine] of cells) {
		await new Promise((r) => setTimeout(r, 0));
		if (token !== skillRenderToken) return;
		let t, n, a;
		try {
			t = skillTimes(model, id, maxLv); n = skillTimes(naked, id, maxLv);
			a = mine.length ? skillTimes(withPotentials(naked, mine), id, maxLv) : n;
		} catch { continue; }
		const arrow = (x, y) => (x !== y ? `${fmtSec(x)}→${fmtSec(y)}` : fmtSec(x));
		c.cf.textContent = arrow(n.cf, a.cf);
		c.cfr.textContent = n.cf - t.cf ? `−${n.cf - t.cf}ms` : "-";
		c.ct.textContent = arrow(n.ct, a.ct);
		c.ctr.textContent = n.ct - t.ct ? `−${n.ct - t.ct}ms` : "-";
		if (a.cf !== n.cf) c.cf.classList.add("bf-sk-chg");
		if (a.ct !== n.ct) c.ct.classList.add("bf-sk-chg");
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

// ---- 固定装備 ----
// 画面で付けている装備（精錬値・カード・エンチャント込み）はそのまま固定して検索する。「外す」で画面の装備からも外す。
// 空いているカード・エンチャント枠と、何も付けていない部位だけを探す。シャドウ装備は出さない（常に今のまま）
const FIXED_COLS = [["refine", "精錬値"], ["item", "装備"], ["card", "カード"], ["ench", "エンチャント"]];
function renderRegions(model) {
	regionBox.replaceChildren(h("tr", {}, h("th", {}, "部位"), FIXED_COLS.map(([, label]) => h("th", {}, label))));
	for (const r of BF_REGIONS) {
		if (r.shadow) continue;
		const cur = regionItem(model, r);
		// 何も付けていない部位も行は残し、「-」を出す（外すボタンは出さない）
		const empty = !cur || isRegionEmpty(model, r);
		const nSlot = empty ? 0 : itemSlotCount(cur);
		const ids = r.slots.map((s) => model?.card?.[s] || 0);
		const names = (list) => list.filter((c) => c > 0).map(cardName).join(" / ") || "-";
		const text = {
			item: empty ? "-" : itemName(cur),
			refine: r.refine && !empty ? "+" + (regionRefine(model, r) ?? 0) : "-",
			card: empty ? "-" : names(ids.slice(0, nSlot)),
			ench: empty ? "-" : names(ids.slice(nSlot)),
		};
		const btn = empty ? null : h("button", { type: "button", class: "bf-lock", disabled: running, onclick: () => removeRegion(r) }, "外す");
		regionBox.append(h("tr", {},
			h("td", { class: "bf-lockcell" }, btn, h("span", { class: "bf-lockval" }, r.label)),
			FIXED_COLS.map(([part]) => h("td", { class: text[part] === "-" ? "bf-dim" : "" }, text[part]))));
	}
}
/** 部位の装備を画面からも外す */
function removeRegion(r) {
	if (running) return;
	let model;
	try { model = modelFromScreen(); } catch { return; }
	applyModelToScreen(withoutRegion(model, r), [r]);
	setTimeout(refreshAll, 300);
}
function regionRefine(m, r) { return m ? getRefine(m, r) : null; }

// ---- 除外装備 ----
function buildNg() {
	ngBox = h("div", { class: "bf-ng-list" });
	const sel = h("select", {}, h("option", { value: "" }, ""));
	queueMicrotask(() => {
		if (!window.TomSelect) return;
		const ts = new window.TomSelect(sel, {
			// ひらがな・カタカナを同じに扱う（カード・エンチャントは読みでも引ける）
			options: [...itemNames().map(([id, n]) => ({ value: "i" + id, text: n, n: searchNorm(n), y: "" })),
				...cardNames().map(([id, n]) => ({ value: "c" + id, text: n, n: searchNorm(n), y: readingOf(id) }))],
			searchField: ["text"],
			score: kanaSelectOptions([]).score,
			maxOptions: 200, placeholder: "除外する装備・カード・エンチャントの名前を入力", allowEmptyOption: true,
			onChange: (v) => {
				if (!v) return;
				addNg(v[0] === "i" ? "item" : "card", Number(v.slice(1)));
				ts.clear(true);
			},
		});
	});
	renderNg();
	return h("div", {}, h("div", { class: "bf-ngsel" }, sel), ngBox);
}
function addNg(kind, id) {
	const list = kind === "item" ? conf.ngItems : conf.ngCards;
	if (!list.includes(id)) list.push(id);
	saveConf(); renderNg();
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
	const maxIn = h("select", { class: "bf-maxres", onchange: () => { conf.maxResults = Number(maxIn.value); saveConf(); } },
		MAX_RESULT_CHOICES.map((n) => h("option", { value: n, selected: n === conf.maxResults }, String(n))));
	searchBtn = h("button", { type: "button", class: "bf-go", onclick: runSearch }, "検索");
	stopBtn = h("button", { type: "button", class: "bf-stop", disabled: true, onclick: stopSearch }, "止める");
	progressBox = h("div", { class: "bf-progress" });
	progressBar = h("div", { class: "bf-bar", hidden: true }, h("div", { class: "bf-bar-fill" }), h("span", { class: "bf-bar-pct" }));
	return h("div", {},
		h("div", { class: "bf-opts" }, h("label", {}, "表示件数: ", maxIn)),
		h("div", { class: "bf-actions" }, searchBtn, stopBtn),
		progressBar, progressBox);
}

function buildConds() {
	const conds = [];
	for (const [key, t] of Object.entries(conf.targets)) {
		const m = BF_METRIC_BY_KEY[key];
		if (!m || t == null) continue;
		if (m.kind === "elm") conds.push({ key: "elm:" + t, target: 1, label: `${m.label}が${ELM_NAMES[t]}`, unit: "", elm: true });
		else conds.push({ key, target: t, label: m.label, unit: m.unit });
	}
	for (const [cid, n] of conf.enchRows || []) {
		if (cid > 0 && n != null && n > 0) conds.push({ key: "card:" + cid, target: n, label: cardName(cid), unit: "個" });
	}
	for (const [cid, n] of conf.cardGoalRows || []) {
		if (cid > 0 && n != null && n > 0) conds.push({ key: "card:" + cid, target: n, label: cardName(cid), unit: "枚" });
	}
	// スキル欄でオンにした潜在解放は、それ自体とセット相手（豪傑など）を1個以上の目標にする
	for (const cid of potentialWithPartners(conf.potentialOn || [])) {
		if (conds.some((c) => c.key === "card:" + cid)) continue;
		conds.push({ key: "card:" + cid, target: 1, label: cardName(cid), unit: "個" });
	}
	return { conds, skillLv: {} };
}

async function runSearch() {
	if (running) return;
	const { conds, skillLv } = buildConds();
	if (!conds.length) { progressBox.textContent = "目標を1つ以上入れてください。"; return; }
	running = true;
	// 検索中は固定装備を変えられない（外すボタンを押せないようにする）
	for (const b of regionBox.querySelectorAll("button.bf-lock")) b.disabled = true;
	// 止めるボタンは押したその場で画面を戻す（検索の後始末は裏で終わらせ、結果は捨てる）
	const token = { stop: false };
	curToken = token;
	freezeScreen();
	searchBtn.disabled = true; stopBtn.disabled = false;
	resultBox.replaceChildren();
	lastResults = null; openSigs.clear();
	barMax = 0; progressBar.hidden = false; setBar(0);
	const t0 = performance.now();
	try {
		const res = await search({
			conds, skillLv,
			lock: fixedLock(modelFromScreen()),
			ngItems: conf.ngItems, ngCards: conf.ngCards,
			maxResults: conf.maxResults,
			priceOf: priceOfFactory(prices),
			onProgress: (text, ratio) => { if (!token.stop) { progressBox.textContent = text; setBar(ratio); } },
			// 見つかったものから順に結果に出す
			onResults: (results, ctx) => { if (!token.stop) { lastResults = { results, ...ctx, conds }; renderResults(); } },
			shouldStop: () => token.stop,
		});
		if (token.stop) return;
		lastResults = { ...res, conds };
		const sec = Math.round((performance.now() - t0) / 1000);
		const why = res.stats?.unreachable?.length ? `。どう組み合わせても届かない条件: ${res.stats.unreachable.join("、")}` : "";
		progressBox.textContent = res.results.length ? `${res.results.length}件見つかりました（${sec}秒）` : `条件を満たす構成は見つかりませんでした（${sec}秒）${why}`;
		renderResults();
	} catch (e) {
		if (token.stop) return;
		if (e instanceof BfStopped) progressBox.textContent = "";
		else { progressBox.textContent = "エラー: " + e.message; console.error(e); }
	} finally {
		if (!token.stop) endSearch();
	}
}
function endSearch() {
	running = false; searchBtn.disabled = false; stopBtn.disabled = true;
	for (const b of regionBox.querySelectorAll("button.bf-lock")) b.disabled = false;
	progressBar.hidden = true;
	curToken = null;
	thawScreen();
}
function stopSearch() {
	if (!curToken) return;
	curToken.stop = true;
	cancelPending();
	progressBox.textContent = "";
	endSearch();
}
/** 進捗バー（戻らないように最大値で表示） */
let barMax = 0;
function setBar(ratio) {
	barMax = Math.max(barMax, Number(ratio) || 0);
	const pct = Math.floor(barMax * 100);
	progressBar.firstChild.style.width = pct + "%";
	progressBar.lastChild.textContent = pct + "%";
}

// ---- 結果 ----
/** 結果で新しく付けるもの（装備は名前、カード・エンチャは名前） */
function newThings(r) {
	const out = [];
	for (const pk of r.picks) {
		if (!pk.keep) out.push({ kind: "item", id: pk.itemId, label: itemName(pk.itemId) + (pk.pkg ? "（セット）" : "") });
		for (const [, cid] of pk.cards) out.push({ kind: "card", id: cid, label: cardName(cid) });
	}
	return out;
}
const openSigs = new Set(); // 開いている結果（作り直しても開いたままにする）
const sigOf = (r) => JSON.stringify([r.model.equip, r.model.card]);
function renderResults() {
	if (!lastResults) return;
	const { results } = lastResults;
	const sortSel = h("select", { onchange: () => { conf.sort = sortSel.value; saveConf(); renderResults(); } },
		h("option", { value: "changes", selected: conf.sort === "changes" }, "変更箇所が少ない順"),
		h("option", { value: "price", selected: conf.sort === "price" }, "値段が安い順"));
	const list = results.slice().sort(conf.sort === "price"
		? (a, b) => ((a.priceUnknown > 0) - (b.priceUnknown > 0)) || (a.price - b.price) || (a.changes - b.changes)
		: (a, b) => (a.changes - b.changes) || ((a.priceUnknown > 0) - (b.priceUnknown > 0)) || (a.price - b.price));
	resultBox.replaceChildren(
		h("div", { class: "bf-res-head" }, h("h3", {}, "結果"), "並べ替え: ", sortSel),
		h("div", { class: "bf-res-list" }, list.map((r, i) => resultRow(r, i))));
}
function resultRow(r, i) {
	const things = newThings(r);
	const detail = h("div", { class: "bf-res-detail" });
	const row = h("div", { class: "bf-res" });
	const sig = sigOf(r);
	const toggle = (open) => {
		row.classList.toggle("open", open);
		if (open) openSigs.add(sig); else openSigs.delete(sig);
		if (open && !detail.childNodes.length) detail.append(resultDetail(r));
	};
	if (openSigs.has(sig)) queueMicrotask(() => toggle(true));
	const line = h("button", { type: "button", class: "bf-res-line", onclick: () => toggle(!row.classList.contains("open")) },
	h("span", { class: "bf-res-no" }, "#" + (i + 1)),
	h("span", { class: "bf-res-chg" }, `${r.changes}か所`),
	h("span", { class: "bf-res-price" }, priceText(r)),
	h("span", { class: "bf-res-new" }, things.map((t) => t.label).join("、") || "（付け替えなし）"));
	row.append(line, detail);
	return row;
}
function priceText(r) {
	if (!r.priceUnknown) return fmtZeny(r.price);
	if (!r.price) return "値段不明";
	return fmtZeny(r.price) + "＋不明" + r.priceUnknown;
}
function resultDetail(r) {
	const { base, baseVal } = lastResults;
	const m = r.model;
	const changedRegions = new Set(r.picks.map((pk) => pk.region.key));
	const table = h("table", { class: "bf-eqtable" },
		h("tr", {}, h("th", {}, "部位"), h("th", {}, "装備"), h("th", {}, "カード／エンチャント 1"), h("th", {}, "2"), h("th", {}, "3"), h("th", {}, "4"), h("th", {}, "値段")));
	for (const reg of BF_REGIONS) {
		const iid = regionItem(m, reg);
		const empty = isRegionEmpty(m, reg);
		const itemHit = iid !== regionItem(base, reg);
		const refine = getRefine(m, reg);
		const pk = r.picks.find((p) => p.region.key === reg.key);
		const itemCell = h("td", { class: "bf-eq-item" + (itemHit ? " bf-hit" : "") },
			empty ? h("span", { class: "bf-zero" }, "なし") : [(refine ? `+${refine} ` : ""), itemName(iid)],
			itemHit && !empty ? ngButton("item", iid) : null,
			pk?.pkg ? h("span", { class: "bf-set" }, "セット") : null);
		const cardCells = reg.slots.map((s) => {
			const cid = m.card[s] || 0;
			const hit = cid !== (base.card[s] || 0);
			return h("td", { class: hit ? "bf-hit" : "" }, cid ? [cardName(cid), hit ? ngButton("card", cid) : null] : h("span", { class: "bf-zero" }, "-"));
		});
		const priceCell = h("td", { class: "bf-eq-price" }, pk ? (pk.priceUnknown ? (pk.finalPrice ? fmtZeny(pk.finalPrice) + "＋不明" : "不明") : fmtZeny(pk.finalPrice)) : "");
		table.append(h("tr", { class: changedRegions.has(reg.key) ? "bf-eq-changed" : "" }, h("th", {}, reg.label), itemCell, cardCells, priceCell));
	}
	const applyBtn = h("button", { type: "button", class: "bf-go bf-apply", onclick: () => {
		applyBtn.disabled = true;
		try {
			applyModelToScreen(m, BF_REGIONS.filter((reg) => changedRegions.has(reg.key)));
			applyBtn.textContent = "今の装備に反映しました";
			setTimeout(refreshAll, 300);
		} catch (e) {
			console.error(e);
			applyBtn.textContent = "反映できませんでした";
		}
	} }, "この構成を今の装備に反映");
	return h("div", {},
		h("div", { class: "bf-res-actions" }, applyBtn, h("span", { class: "bf-note" }, "色付きの欄が変わる所です。「除外」で除外装備に入れられます。")),
		table,
		metricGroupsTable(r.values, { before: baseVal }));
}
function ngButton(kind, id) {
	const done = () => (kind === "item" ? conf.ngItems : conf.ngCards).includes(id);
	const b = h("button", { type: "button", class: "bf-ngbtn", title: "除外装備に入れる", onclick: (e) => {
		e.stopPropagation();
		addNg(kind, id);
		b.textContent = "除外済み"; b.disabled = true;
	} }, done() ? "除外済み" : "除外");
	if (done()) b.disabled = true;
	return b;
}
