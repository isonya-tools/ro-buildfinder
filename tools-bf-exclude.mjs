// 除外リスト（bf-exclude.json）を作る。
// スプレッドシートの「除外ID（自動）」タブ B1〜B3 の文字列（チェックが続く区間の 先頭ID,…|末尾ID,…）を
// tools/bf-list の一覧の並び（ID順）で展開する。
// 使い方: node tools-bf-exclude.mjs '<装備>' '<カード>' '<エンチャント>'
import fs from "fs";

const dir = new URL("./tools/bf-list/", import.meta.url);
// CSV の1列目（ID）を順に取り出す（改行や , を含む "…" の欄は飛ばす）
function ids(files) {
	const out = [];
	for (const f of files) {
		const s = fs.readFileSync(new URL(f, dir), "utf8");
		let i = s.startsWith("ID,") ? s.indexOf("\n") + 1 : 0; // 見出しは先頭のファイルだけ
		while (i < s.length) {
			const m = /^(\d+),/.exec(s.slice(i, i + 12));
			if (!m) throw new Error(`${f}: 行頭にIDがありません（${i}）`);
			out.push(Number(m[1]));
			// 行末まで進む（"…" の中の改行は行末ではない）
			let q = false;
			for (; i < s.length; i++) {
				const c = s[i];
				if (c === '"') q = !q;
				else if (c === "\n" && !q) { i++; break; }
			}
		}
	}
	return out.sort((a, b) => a - b); // シートはID順に並べ替えてある
}
function expand(runs, list, label) {
	if (!runs) return [];
	const [a, b] = runs.split("|").map((t) => (t ? t.split(",").map(Number) : []));
	if (a.length !== b.length) throw new Error(`${label}: 区間の数が合いません`);
	const pos = new Map(list.map((id, i) => [id, i]));
	const out = [];
	a.forEach((s, k) => {
		const i = pos.get(s), j = pos.get(b[k]);
		if (i == null || j == null || j < i) throw new Error(`${label}: 区間 ${s}〜${b[k]} が一覧と合いません`);
		out.push(...list.slice(i, j + 1));
	});
	return out;
}
const [it, cd, en] = process.argv.slice(2);
const items = expand(it, ids([1, 2, 3, 4, 5, 6, 7].map((n) => `items${n}.csv`)), "装備");
const cards = [...expand(cd, ids(["cards.csv"]), "カード"), ...expand(en, ids(["enchants.csv"]), "エンチャント")];
fs.writeFileSync(new URL("./ro4/m/buildfinder/bf-exclude.json", import.meta.url), JSON.stringify({ items, cards }) + "\n");
console.log(`装備 ${items.length} / カード・エンチャ ${cards.length}`);
