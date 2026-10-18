/**
 * 装備シミュの計算を別スレッドで回す Web Worker.
 * ラトリオの計算本体（calcCoreFromModel / calcFromModel）を読み込み、送られてきたモデルを計算して指標を返す。
 *   {id, type: "core", model, st}  → {id, v: 指標}（st: 画面側の計算に合わせる内部状態）
 *   {id, type: "skill", model}     → {id, t: {cf, ct}}（スキルの固定詠唱・CT、ミリ秒）
 *   {type: "dfsBase" | "dfsLevel", model}（返事なし）→ 組み合わせ探索の下準備（部位ごとの候補・上限の準備）を覚える
 *   {id, type: "dfs", model: {prefix, ms}} → {id, v}（途中まで決めた組から先を探した結果. bf-dfs.js）
 */

import { dfsTask, unpackBase } from "./bf-dfs.js";

// ラトリオの一部のモジュールは読み込み時に画面（document）を触るので、何でも受け付ける空の画面を用意しておく
const NULLS = new Set(["firstChild", "lastChild", "firstElementChild", "lastElementChild", "nextSibling", "previousSibling", "nextElementSibling", "previousElementSibling", "parentNode", "parentElement", "offsetParent"]);
const FALSES = new Set(["hasChildNodes", "contains", "hasAttribute", "matches", "hasFocus"]);
const stub = () => {
	const f = function () { return stub(); };
	f._ = {};
	return new Proxy(f, {
		get: (t, k) => {
			if (k === Symbol.toPrimitive) return (hint) => (hint === "number" ? 0 : "");
			if (k === Symbol.iterator) return function* () {};
			if (k === Symbol.hasInstance) return () => false;
			if (k === "length" || k === "childElementCount" || k === "selectedIndex") return 0;
			if (k === "value") return "0";
			if (k === "textContent" || k === "innerHTML" || k === "id" || k === "className") return "";
			if (k === "checked" || k === "disabled") return false;
			if (k === "then") return undefined;
			if (NULLS.has(k)) return null;
			if (FALSES.has(k)) return () => false;
			if (k === "_") return t._;
			if (!(k in t._)) t._[k] = stub();
			return t._[k];
		},
		set: (t, k, v) => { t._[k] = v; return true; },
		apply: () => stub(),
		construct: () => stub(),
	});
};
for (const name of ["document", "window", "localStorage", "sessionStorage", "HTMLElement", "HTMLOptGroupElement", "HTMLOptionElement", "HTMLSelectElement", "HTMLInputElement", "HTMLTableElement", "HTMLTableRowElement", "HTMLTableCellElement", "HTMLDivElement", "HTMLSpanElement", "HTMLButtonElement", "HTMLTextAreaElement", "HTMLLabelElement", "HTMLAnchorElement", "HTMLImageElement", "HTMLCanvasElement", "Text", "DocumentFragment", "Image", "Option", "XMLSerializer", "DOMParser", "Element", "Node", "Event", "CustomEvent", "MutationObserver", "ResizeObserver", "IntersectionObserver", "getComputedStyle", "alert", "confirm"]) {
	if (!(name in globalThis)) globalThis[name] = stub();
}
// 画面の読み込み完了時の初期化（画面の組み立て）は走らせない
document.readyState = "loading";
// 画面の部品は「無い」と答える（ラトリオは部品が無いページでは画面の組み立てを飛ばす）
for (const fn of ["getElementById", "querySelector", "getElementsByName", "getElementsByClassName", "getElementsByTagName", "querySelectorAll"]) {
	document[fn] = fn.startsWith("getElementsBy") || fn === "querySelectorAll" ? () => [] : () => null;
}

let dbase = null, dlevel = null;
let core = null, full = null, readMetrics = null, setters = {}, err = null, warm = false;
const ready = (async () => {
	try {
		const reg = await import("../../../engine/runtime/engine-registry.js");
		await import("../../../engine/entry/calcx.js");
		({ readMetrics } = await import("./bf-metrics.js"));
		// 画面側の計算に合わせる内部状態（モデルに入っていないもの）の書き込み口
		setters = {
			n_Enekyori: (await import("../../../engine/runtime/ro4-state.js")).set_n_Enekyori,
			n_Skill1SW: (await import("../../../engine/ui/BuffJobSpecificSelf.js")).setN_Skill1SW,
			n_Skill4SW: (await import("../../../engine/ui/BuffGuildAndGospel.js")).setN_Skill4SW,
			n_Skill7SW: (await import("../../../engine/ui/BuffItemAndFood.js")).setN_Skill7SW,
			n_Skill8SW: (await import("../../../engine/ui/BuffOtherCategory.js")).setN_Skill8SW,
		};
		// 支援欄が閉じていても、画面で前に入れた値が残っていて計算に効く（画面の表示もそれを含む）ので、中身を写す
		const ss = await import("../../../engine/skill/skillstate.js");
		for (const k of ["n_A_PassSkill", "n_A_PassSkill4", "n_A_PassSkill7", "n_A_PassSkill8"]) {
			setters[k] = (v) => { const a = ss[k]; a.length = 0; for (const x of v) a.push(x); };
		}
		// 支援・デバフ設定欄の設定ID（CONF_ID_*）は設定欄の部品を作るときに決まるので、部品だけ作っておく（画面には出さない）
		for (const n of ["Ichizi", "Nizi", "Sanzi", "Yozi", "Debuff", "CustomStatus", "CustomAtk", "CustomDef", "CustomSkill", "CustomSpecStatus"]) {
			const mod = await import(`../../../engine/chara/CCharaConf${n}.js`);
			new mod[`CCharaConf${n}`]([]);
		}
		// 読み込みが終わったら、計算中に画面の部品へ書き込む所（表示名など）のために、空の部品を返すようにする
		document.getElementById = () => stub();
		core = reg.get("calcCoreFromModel");
		full = reg.get("calcFromModel");
	} catch (e) { err = String(e); }
})();

onmessage = async ({ data }) => {
	// 探索の仕事（計算本体は使わない）
	if (data.type === "dfsBase") { dbase = { ...unpackBase(data.model), failMemo: new Map() }; return; }
	if (data.type === "dfsLevel") { dlevel = data.model; return; }
	if (data.type === "dfs") {
		try {
			const { prefix, ms } = data.model;
			const r = dfsTask({ ...dbase, ...dlevel }, prefix, ms);
			postMessage({ id: data.id, v: r });
		} catch (e) { postMessage({ id: data.id, err: String(e) }); }
		return;
	}
	await ready;
	const { id, type, model, st } = data;
	if (err) { postMessage({ id, err }); return; }
	try {
		// 最初の1回は戦闘計算まで通して、前回の計算の値を引き継ぐ内部状態（特性ステータス等）を埋めておく
		if (!warm) { full(model); core(model); warm = true; }
		// 支援欄の開閉（開いている欄の設定だけ計算に入る）などは毎回画面側に合わせる（戦闘計算で書き換わる遠距離かどうかも戻す）
		for (const [k, v] of Object.entries(st || {})) setters[k]?.(v);
		if (type === "skill") {
			const r = full(model)?.activeResultArray?.[0];
			postMessage({ id, t: { cf: Math.round((r?.castFixed || 0) * 1000), ct: Math.round((r?.coolTime || 0) * 1000) } });
		} else {
			postMessage({ id, v: readMetrics(core(model)) });
		}
	} catch (e) { postMessage({ id, err: String(e) }); }
};
