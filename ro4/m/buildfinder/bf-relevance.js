/**
 * 目標に関係しそうな装備・カード・エンチャ・セットを先に絞り込む.
 *
 * 1. データの効果（SP）に、目標の指標を上げるものが含まれるか
 * 2. 計算処理の中でIDを直接見ている（データのSPに出てこない効果を持つ）ものは、
 *    実際に1つずつ装備して、どの指標が変わったか（bf-hard.json の probe。tools-bf-probe.js で作成）で判定。
 *    スキルの詠唱・CTは指標が多いので、ファイル単位の分類（tools-bf-hard.mjs）で判定
 * 3. 目標のエンチャントそのもの、それが付く装備
 * 4. 「リフレッシュ状態になる」効果
 * のどれかに当たるものだけを、実際に計算して確かめる対象にする。
 */
import { ItemObjNew } from "../../../engine/equip/item.dat.js";
import { CardObjNew } from "../../../engine/equip/card.dat.js";
import { w_SE } from "../../../engine/equip/itemset.dat.js";
import { REFRESH_ITEMS, REFRESH_CARDS } from "./bf-metrics.js";

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const STATS = [...range(1, 7), ...range(201, 206), ...range(211, 217), ...range(230, 236)];
const CAST_STATS = [4, 5, 7, 204, 205, 214, 215, 217, 236];

/** 指標キー → 関係するSPの番号（SPコードの下5桁） */
const SP_OF = {
	maxhp: [...STATS, 13, 15, 246], maxsp: [...STATS, 14, 16, 247],
	aspd: [...STATS, 12, 101], hit: [...STATS, 8], flee: [...STATS, 9], lucky: [...STATS, 11], cri: [...STATS, 10],
	castStat: CAST_STATS, castGear: [73], castFixed: [109], delay: [74],
	ignDefN: [290, 291, 293], ignDefB: [290, 292, 293], ignMdefN: [295, 296, 298], ignMdefB: [295, 297, 298],
	kiri: [23], perfect: [86], bodyElm: [198],
	resBoss: [77], resNotBoss: [79], resLong: [78], resPlayer: [243, 274, 277],
};
for (let i = 0; i < 10; i++) {
	SP_OF["resElm" + i] = [60 + i, 264];
	SP_OF["resAbn" + i] = [150 + i];
	SP_OF["resRace" + i] = [50 + i, 263];
}
for (let i = 0; i < 3; i++) SP_OF["resSize" + i] = [190 + i, 147 + i];

/** 計算処理側の分類（bf-hard.json のキー） */
const HARD_CAT = (key) => {
	if (key.startsWith("sk:") || ["castGear", "castFixed", "delay"].includes(key)) return "cast";
	if (key.startsWith("ign")) return "ign";
	if (key === "kiri" || key === "perfect") return "hit";
	if (key.startsWith("res")) return "resist";
	if (key === "bodyElm" || key.startsWith("elm:")) return "elm";
	if (key === "refresh" || key.startsWith("card:")) return null;
	return "stat";
};

let hard = null, hardProbe = null, hardSkill = null;
export async function loadHard() {
	if (hard) return hard;
	try {
		const res = await fetch(new URL("./bf-hard.json", import.meta.url));
		hard = res.ok ? await res.json() : {};
	} catch { hard = {}; }
	const probe = hard.probe || {};
	const bySkill = hard.castBySkill || {};
	delete hard.probe; delete hard.castBySkill;
	hardSkill = {};
	for (const k of Object.keys(bySkill)) hardSkill[k] = { items: new Set(bySkill[k].items), cards: new Set(bySkill[k].cards) };
	for (const k of Object.keys(hard)) hard[k] = { items: new Set(hard[k].items), cards: new Set(hard[k].cards) };
	hardProbe = {};
	for (const k of Object.keys(probe)) hardProbe[k] = { items: new Set(probe[k].items), cards: new Set(probe[k].cards) };
	return hard;
}

/** 装備・カード・セット効果の行から [SPコード, 値] の組を取り出す */
function spPairs(row, from) {
	const out = [];
	if (!row) return out;
	for (let i = from; i + 1 < row.length; i += 2) {
		const code = row[i];
		if (typeof code !== "number" || code === 0) break;
		out.push([code, row[i + 1]]);
	}
	return out;
}
const itemPairs = (id) => spPairs(ItemObjNew[id], 11);
const cardPairs = (id) => spPairs(CardObjNew[id], 5);

/**
 * 目標の一覧から、関係の有無を判定する関数をまとめて作る.
 * @param {string[]} keys 目標の指標キー（sk:<id>:cf / card:<id> / elm:<id> を含む）
 */
export function makeRelevance(keys) {
	const spSet = new Set();
	const cats = new Set();
	const probeKeys = new Set(); // 実際に装備して変わった指標で判定するもの
	const skillIds = new Set(); // スキルごとの処理で装備を見ているもの（castBySkill）
	const targetCards = new Set();
	let refresh = false;
	for (const key of keys) {
		const cat = HARD_CAT(key);
		// スキルの固定詠唱・CT: スキルごとの処理で装備を見ているもの（固定詠唱は、固定詠唱全般で実際に変わるものも）
		if (key.startsWith("sk:")) { skillIds.add(key.split(":")[1]); skillIds.add("any"); if (key.endsWith(":cf")) probeKeys.add("castFixed"); }
		else if (key.startsWith("elm:")) probeKeys.add("bodyElm");
		else if (cat) probeKeys.add(key);
		if (key === "refresh") refresh = true;
		else if (key.startsWith("card:")) targetCards.add(Number(key.slice(5)));
		else if (key.startsWith("elm:")) spSet.add(198);
		else if (key.startsWith("sk:")) {
			const [, id, kind] = key.split(":");
			const sid = Number(id);
			if (kind === "cf") { spSet.add(109); spSet.add(13000 + sid); spSet.add(11000 + sid); }
			else spSet.add(19000 + sid);
		} else for (const s of SP_OF[key] || []) spSet.add(s);
	}
	const hit = (pairs) => pairs.some(([code, v]) => v !== 0 && spSet.has(code % 100000));
	const inHard = (kind, id) => {
		for (const c of cats) if (hard?.[c]?.[kind]?.has(id)) return true;
		for (const k of probeKeys) if (hardProbe?.[k]?.[kind]?.has(id)) return true;
		for (const k of skillIds) if (hardSkill?.[k]?.[kind]?.has(id)) return true;
		return false;
	};
	const memo = new Map();
	const directItem = (id) => hit(itemPairs(id)) || inHard("items", id) || (refresh && REFRESH_ITEMS.has(id));
	const directCard = (id) => targetCards.has(id) || hit(cardPairs(id)) || inHard("cards", id) || (refresh && REFRESH_CARDS.has(id));
	/** セット効果の行（w_SE[n][0]。正: アイテムの行、負: カードの行）が関係するか */
	const setRowDirect = (src) => {
		const k = "s" + src;
		if (!memo.has(k)) memo.set(k, src > 0 ? directItem(src) : directCard(-src));
		return memo.get(k);
	};
	// 効果がセットにしか無い物（例: エンチャント「英雄」はカード「フェンリル」とのセットで固定詠唱-80%）も、
	// そのセットの効果が目標に関係するなら関係ありとする
	const inRelevantSet = (k) => (setMembers().get(k) || []).some(setRowDirect);
	const item = (id) => {
		const k = "i" + id;
		if (!memo.has(k)) memo.set(k, directItem(id) || inRelevantSet(k));
		return memo.get(k);
	};
	const card = (id) => {
		const k = "c" + id;
		if (!memo.has(k)) memo.set(k, directCard(id) || inRelevantSet(k));
		return memo.get(k);
	};
	const setRow = setRowDirect;
	/** 目標に関係するSPコードか（精錬値の条件を見るときに使う） */
	const code = (c) => spSet.has(c % 100000);
	return { item, card, setRow, targetCards, code };
}

/** セットのメンバー（"i<装備ID>" / "c<カードID>"）→ そのセットの効果の行（w_SE[n][0]）の一覧 */
let setMemberMap = null;
function setMembers() {
	if (setMemberMap) return setMemberMap;
	setMemberMap = new Map();
	for (let i = 1; i < w_SE.length; i++) {
		const s = w_SE[i];
		if (!s || s.length < 3) continue;
		for (const x of s.slice(1)) {
			if (typeof x !== "number" || x === 0) continue;
			const k = x > 0 ? "i" + x : "c" + -x;
			if (!setMemberMap.has(k)) setMemberMap.set(k, []);
			setMemberMap.get(k).push(s[0]);
		}
	}
	return setMemberMap;
}

/** 関係しそうなセット（全メンバーがアイテムのもの）: [{setIndex, members:[itemId...], src}] */
export function relevantItemSets(rel) {
	const out = [];
	for (let i = 1; i < w_SE.length; i++) {
		const s = w_SE[i];
		if (!s || s.length < 3) continue;
		const members = s.slice(1).filter((x) => x !== "NULL");
		if (!members.every((x) => typeof x === "number" && x > 0)) continue;
		if (!rel.setRow(s[0])) continue;
		out.push({ setIndex: i, members, src: s[0] });
	}
	return out;
}

/** セット効果のメンバーか（key: "i<装備ID>" / "c<カードID>"） */
export function inAnySet(key) { return setMembers().has(key); }
/** 2つのメンバーが同じセットに入っているか */
export function inSameSet(a, b) {
	const x = setMembers().get(a), y = setMembers().get(b);
	return !!(x && y && x.some((r) => y.includes(r)));
}
/** 計算処理の中でIDを直接見ているカード・エンチャントか */
const hardCardMemo = new Map();
export function isHardCard(id) {
	if (!hard) return false;
	let v = hardCardMemo.get(id);
	if (v !== undefined) return v;
	v = Object.values(hard).some((c) => c.cards?.has(id)) || Object.values(hardProbe || {}).some((c) => c.cards?.has(id));
	hardCardMemo.set(id, v);
	return v;
}
/** 計算処理の中でIDを直接見ている装備か（精錬値で効果が変わるかもしれないもの） */
export function isHardItem(id) {
	if (!hard) return false;
	for (const c of Object.values(hard)) if (c.items?.has(id)) return true;
	return false;
}
