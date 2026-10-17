/**
 * RO BuildFinder 画面.
 * 今の状態の表示、目標・固定・NG の設定、検索と結果一覧を受け持つ。
 * シミュ専用の設定はクッキー（bf_conf）に保存する（URL出力には入れない）。
 */
import {
	BF_REGIONS, search, evalModel, modelFromScreen, attackSkillsOf,
	itemName, cardName, allCardNames, BfStopped,
} from "./bf-engine.js";
import { BF_METRICS, BF_METRIC_BY_KEY } from "./bf-metrics.js";
import { ItemObjNew } from "../../../engine/equip/item.dat.js";
import { loadPrices, priceOfFactory, priceWorlds } from "./bf-price.js";

const COOKIE = "bf_conf";
const $ = (sel, root = document) => root.querySelector(sel);
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

// ---- 設定（クッキー） ----
const defaultConf = () => ({
	skill: 0, skillLv: 0,
	conds: [{ metric: "resElm1", target: 0 }],
	regionMode: {},   // regionKey -> "free" | "keep" | "lock"
	ngItems: [], ngCards: [],
	refine: "", useCards: true, maxResults: 30, world: "", sort: "changes",
});
let conf = defaultConf();
function loadConf() {
	const m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([^;]*)"));
	if (!m) return;
	try { conf = { ...defaultConf(), ...JSON.parse(decodeURIComponent(m[1])) }; } catch { /* 壊れていたら既定値 */ }
}
function saveConf() {
	document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(conf))}; max-age=${60 * 60 * 24 * 365 * 5}; path=/; SameSite=Lax`;
}

// ---- 名前の一覧（NG・含めたいエンチャ用） ----
let itemNameList = null, cardNameList = null;
function itemNames() {
	if (!itemNameList) {
		const kinds = new Set(BF_REGIONS.flatMap((r) => r.kinds));
		itemNameList = [];
		for (const x of ItemObjNew) if (x && kinds.has(x[1]) && x[8] && !/装備なし$/.test(x[8])) itemNameList.push([x[0], x[8]]);
	}
	return itemNameList;
}
function cardNames() {
	if (!cardNameList) cardNameList = allCardNames();
	return cardNameList;
}
function findByName(list, name) {
	const n = name.trim();
	return list.find(([, nm]) => nm === n)?.[0] ?? null;
}

// ---- 画面 ----
let root, stateBox, resultBox, progressBox, lastResults = null, stopFlag = false, running = false;
let prices = null;

export async function initBuildFinder(container) {
	loadConf();
	root = container;
	root.append(
		h("h2", { class: "bf-title" }, "装備シミュレーター"),
		h("p", { class: "bf-lead" }, "上で今の装備を設定し、目標を入れて検索すると、今の装備から目標を達成できる構成を探します。"),
		section("1. 今の状態", stateBox = h("div", { class: "bf-state" })),
		section("2. 目標", buildConds()),
		section("3. 部位ごとの設定（固定）", buildRegions()),
		section("4. NG（検索結果に出さない）", buildNg()),
		section("5. 検索", buildSearch()),
		resultBox = h("div", { class: "bf-results" }),
		h("p", { class: "bf-license" },
			"RO BuildFinder は ",
			h("a", { href: "https://github.com/roratorio-hub/ratorio", target: "_blank", rel: "noopener" }, "ラトリオHUB"),
			" の計算部分を使って作っています（非営利・",
			h("a", { href: "https://polyformproject.org/licenses/noncommercial/1.0.0", target: "_blank", rel: "noopener" }, "PolyForm Noncommercial 1.0.0"),
			"）。ラトリオ、ラトリオ避難所、データ提供者の皆さまへの謝辞と著作権表示は ",
			h("a", { href: "../../LICENSE", target: "_blank" }, "LICENSE"), " の Required Notice を参照。値段は公式ツールの取引履歴から集計しています。"),
	);
	prices = await loadPrices();
	renderWorldSelect();
	refreshState();
	let timer = 0;
	document.addEventListener("change", (e) => {
		if (root.contains(e.target)) return;
		clearTimeout(timer);
		timer = setTimeout(refreshState, 400);
	});
}

function section(title, body) {
	return h("section", { class: "bf-sec" }, h("h3", {}, title), body);
}

// ---- 1. 今の状態 ----
let skillSelect, skillLvInput;
function refreshState() {
	if (!stateBox) return;
	let model;
	try { model = modelFromScreen(); } catch (e) { stateBox.textContent = "計算の準備中です"; return; }
	const skills = attackSkillsOf(model.status.jobId).filter(([id]) => id !== 0);
	if (!skills.some(([id]) => id === conf.skill)) conf.skill = 0;
	const useSkill = conf.skill > 0;
	const maxLv = skills.find(([id]) => id === conf.skill)?.[2] || 1;
	if (useSkill && !conf.skillLv) conf.skillLv = maxLv;
	if (useSkill) model.attackMethod = { skillId: conf.skill, sourceType: 0, skillLv: conf.skillLv || 1, optionValueArray: [] };
	let val;
	try { val = evalModel(model, useSkill); } catch (e) { val = evalModel(model, false); }

	stateBox.replaceChildren();
	// スキル選択
	skillSelect = h("select", { onchange: () => { conf.skill = Number(skillSelect.value); conf.skillLv = 0; saveConf(); refreshState(); } },
		h("option", { value: "0" }, "（スキルを選ぶと固定詠唱・CTを表示）"),
		skills.map(([id, name]) => h("option", { value: id, selected: id === conf.skill }, name)));
	skillLvInput = h("input", { type: "number", min: 1, max: maxLv, value: conf.skillLv || maxLv, style: "width:4em",
		onchange: () => { conf.skillLv = Number(skillLvInput.value) || 1; saveConf(); refreshState(); } });
	stateBox.append(h("div", { class: "bf-skill" }, "スキル: ", skillSelect, " Lv ", skillLvInput));

	// 指標
	const groups = {};
	for (const m of BF_METRICS) {
		if (m.battle && !useSkill) continue;
		(groups[m.group] ||= []).push(m);
	}
	const grid = h("div", { class: "bf-metrics" });
	for (const [g, ms] of Object.entries(groups)) {
		grid.append(h("div", { class: "bf-mgroup" }, h("div", { class: "bf-mgroup-title" }, g),
			h("table", {}, ms.map((m) => h("tr", {}, h("th", {}, m.label), h("td", { class: val[m.key] ? "" : "bf-zero" }, fmtNum(val[m.key]) + (m.unit ? " " + m.unit : "")))))));
	}
	stateBox.append(grid);

	// 付いているカード・エンチャ
	const counts = new Map();
	for (const cid of model.card) if (cid > 0) counts.set(cid, (counts.get(cid) || 0) + 1);
	const list = [...counts].map(([cid, n]) => [cardName(cid), n]).filter(([nm]) => nm).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
	stateBox.append(h("div", { class: "bf-cards" }, h("div", { class: "bf-mgroup-title" }, "付いているカード・エンチャ"),
		list.length ? h("ul", {}, list.map(([nm, n]) => h("li", {}, nm, n > 1 ? h("b", {}, " ×" + n) : null))) : h("p", { class: "bf-zero" }, "なし")));
	stateBox.dataset.values = JSON.stringify(val);
	renderRegions(model);
}

// ---- 2. 目標 ----
let condBox;
function buildConds() {
	condBox = h("div", { class: "bf-conds" });
	const wrap = h("div", {}, condBox,
		h("datalist", { id: "bf-card-names" }, cardNames().map(([, n]) => h("option", { value: n }))),
		h("button", { type: "button", onclick: () => { conf.conds.push({ metric: "resElm1", target: 0 }); saveConf(); renderConds(); } }, "＋ 目標を追加"));
	renderConds();
	return wrap;
}
function renderConds() {
	condBox.replaceChildren();
	conf.conds.forEach((c, i) => {
		const isCard = String(c.metric).startsWith("card:");
		const sel = h("select", { onchange: () => {
			c.metric = sel.value === "card" ? "card:" : sel.value;
			saveConf(); renderConds();
		} },
		groupOptions(isCard ? "card" : c.metric),
		h("option", { value: "card", selected: isCard }, "このカード・エンチャを付ける（潜在解放など）"));
		let input;
		if (isCard) {
			const cur = Number(String(c.metric).slice(5)) || 0;
			input = h("input", { type: "text", list: "bf-card-names", value: cur ? cardName(cur) : "", placeholder: "名前を入力", size: 28,
				onchange: () => { const id = findByName(cardNames(), input.value); c.metric = "card:" + (id ?? ""); input.classList.toggle("bf-bad", id == null); saveConf(); } });
		} else {
			const m = BF_METRIC_BY_KEY[c.metric];
			input = h("span", {}, m.dir > 0 ? "が " : "が ",
				h("input", { type: "number", value: c.target, step: "any", style: "width:6em", onchange: (e) => { c.target = Number(e.target.value); saveConf(); } }),
				` ${m.unit} ${m.dir > 0 ? "以上" : "以下"}`);
		}
		condBox.append(h("div", { class: "bf-cond" }, sel, " ", input,
			h("button", { type: "button", class: "bf-x", title: "削除", onclick: () => { conf.conds.splice(i, 1); saveConf(); renderConds(); } }, "✕")));
	});
}
function groupOptions(cur) {
	const groups = {};
	for (const m of BF_METRICS) (groups[m.group] ||= []).push(m);
	return Object.entries(groups).map(([g, ms]) => h("optgroup", { label: g }, ms.map((m) => h("option", { value: m.key, selected: m.key === cur }, m.label))));
}

// ---- 3. 部位ごとの設定 ----
let regionBox;
function buildRegions() {
	regionBox = h("table", { class: "bf-regions" });
	return h("div", {}, regionBox, h("p", { class: "bf-note" }, "武器は対象外です（今の武器のまま探します）。"));
}
function renderRegions(model) {
	if (!regionBox) return;
	regionBox.replaceChildren(h("tr", {}, h("th", {}, "部位"), h("th", {}, "今の装備"), h("th", {}, "扱い")));
	for (const r of BF_REGIONS) {
		const mode = conf.regionMode[r.key] || "free";
		const sel = h("select", { onchange: () => { conf.regionMode[r.key] = sel.value; saveConf(); } },
			h("option", { value: "free", selected: mode === "free" }, "自由に変える"),
			h("option", { value: "keep", selected: mode === "keep" }, "装備は外さない（空き枠にカード・エンチャは足してよい）"),
			h("option", { value: "lock", selected: mode === "lock" }, "完全に固定"));
		const cur = model?.equip?.[r.eq];
		regionBox.append(h("tr", {}, h("td", {}, r.label), h("td", {}, cur ? itemName(cur) : "—"), h("td", {}, sel)));
	}
}

// ---- 4. NG ----
let ngBox;
function buildNg() {
	ngBox = h("div", { class: "bf-ng-list" });
	const input = h("input", { type: "text", list: "bf-ng-names", size: 30, placeholder: "装備・カード・エンチャの名前" });
	const add = () => {
		const name = input.value.trim();
		if (!name) return;
		const iid = findByName(itemNames(), name);
		const cid = iid == null ? findByName(cardNames(), name) : null;
		if (iid != null && !conf.ngItems.includes(iid)) conf.ngItems.push(iid);
		else if (cid != null && !conf.ngCards.includes(cid)) conf.ngCards.push(cid);
		else if (iid == null && cid == null) { input.classList.add("bf-bad"); return; }
		input.value = ""; input.classList.remove("bf-bad");
		saveConf(); renderNg();
	};
	input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
	renderNg();
	return h("div", {},
		h("datalist", { id: "bf-ng-names" }, itemNames().map(([, n]) => h("option", { value: n })), cardNames().map(([, n]) => h("option", { value: n }))),
		input, h("button", { type: "button", onclick: add }, "追加"), ngBox);
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

// ---- 5. 検索 ----
let worldSelect, searchBtn, stopBtn;
function buildSearch() {
	const refineSel = h("select", { onchange: () => { conf.refine = refineSel.value; saveConf(); } },
		h("option", { value: "", selected: conf.refine === "" }, "今の部位と同じ"),
		Array.from({ length: 21 }, (_, i) => h("option", { value: i, selected: String(conf.refine) === String(i) }, "+" + i)));
	const cardsChk = h("input", { type: "checkbox", checked: conf.useCards, onchange: () => { conf.useCards = cardsChk.checked; saveConf(); } });
	const maxIn = h("input", { type: "number", min: 1, max: 200, value: conf.maxResults, style: "width:4em", onchange: () => { conf.maxResults = Number(maxIn.value) || 30; saveConf(); } });
	worldSelect = h("select", { onchange: () => { conf.world = worldSelect.value; saveConf(); if (lastResults) renderResults(); } });
	searchBtn = h("button", { type: "button", class: "bf-go", onclick: runSearch }, "検索");
	stopBtn = h("button", { type: "button", class: "bf-stop", disabled: true, onclick: () => { stopFlag = true; } }, "止める");
	progressBox = h("div", { class: "bf-progress" });
	return h("div", {},
		h("div", { class: "bf-opts" },
			h("label", {}, "入れ替える装備の精錬値: ", refineSel),
			h("label", {}, cardsChk, " カードも探す"),
			h("label", {}, "表示件数: ", maxIn),
			h("label", {}, "値段のワールド: ", worldSelect)),
		h("div", { class: "bf-actions" }, searchBtn, stopBtn),
		progressBox);
}
function renderWorldSelect() {
	const worlds = priceWorlds(prices);
	if (!worlds.includes(conf.world)) conf.world = worlds[0] || "";
	worldSelect.replaceChildren(...(worlds.length ? worlds.map((w) => h("option", { value: w, selected: w === conf.world }, w)) : [h("option", { value: "" }, "値段データなし")]));
}

async function runSearch() {
	if (running) return;
	const conds = conf.conds.filter((c) => String(c.metric).startsWith("card:") ? Number(String(c.metric).slice(5)) > 0 : BF_METRIC_BY_KEY[c.metric]);
	if (!conds.length) { progressBox.textContent = "目標を1つ以上入れてください。"; return; }
	if (conds.some((c) => BF_METRIC_BY_KEY[c.metric]?.battle) && !conf.skill) { progressBox.textContent = "スキルの固定詠唱・CTを目標にするときは、「1. 今の状態」でスキルを選んでください。"; return; }
	running = true; stopFlag = false;
	searchBtn.disabled = true; stopBtn.disabled = false;
	resultBox.replaceChildren();
	const t0 = performance.now();
	try {
		const res = await search({
			conds,
			skill: conf.skill ? { id: conf.skill, lv: conf.skillLv || 1 } : null,
			locked: BF_REGIONS.filter((r) => conf.regionMode[r.key] === "lock").map((r) => r.key),
			keepItem: BF_REGIONS.filter((r) => conf.regionMode[r.key] === "keep").map((r) => r.key),
			ngItems: conf.ngItems, ngCards: conf.ngCards,
			refine: conf.refine === "" ? null : Number(conf.refine),
			useCards: conf.useCards,
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
	const metricConds = conds.filter((c) => BF_METRIC_BY_KEY[c.metric]);
	resultBox.replaceChildren(
		h("div", { class: "bf-res-head" }, h("h3", {}, "結果"), "並べ替え: ", sortSel),
		h("div", { class: "bf-res-list" }, list.map((r, i) => h("div", { class: "bf-res" },
			h("div", { class: "bf-res-top" },
				h("span", { class: "bf-res-no" }, "#" + (i + 1)),
				h("span", {}, `変更 ${r.changes}か所`),
				h("span", { class: "bf-res-price" }, r.price > 0 ? fmtZeny(r.price) : "値段データなし")),
			h("table", { class: "bf-res-vals" }, metricConds.map((c) => {
				const m = BF_METRIC_BY_KEY[c.metric];
				return h("tr", {}, h("th", {}, m.label), h("td", {}, `${fmtNum(baseVal[c.metric])} → `, h("b", {}, fmtNum(r.values[c.metric])), m.unit ? " " + m.unit : ""));
			})),
			h("ul", { class: "bf-res-picks" }, r.picks.map((pk) => h("li", {},
				h("span", { class: "bf-res-region" }, pk.region.label),
				pk.keep ? h("span", { class: "bf-zero" }, "（今の装備のまま）") : h("span", { class: "bf-res-item" }, itemName(pk.itemId)),
				pk.cards.length ? h("span", { class: "bf-res-cards" }, " ＋ " + pk.cards.map(([, cid]) => cardName(cid)).join("、")) : null,
				pk.price > 0 ? h("span", { class: "bf-res-pprice" }, fmtZeny(pk.price)) : null))),
		))));
}
