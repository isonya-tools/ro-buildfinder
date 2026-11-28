// 検索結果のマウスオーバー説明 bf-desc.json を作る
// e: エンチャント（カードID→説明。エンチャントDBの整理済みの説明 data.json の desc）
// c: カード（カードID→説明。ro4/m/items_part*.json の公式説明を整形）
// i: 装備（アイテムID→説明。エンチャントDBの xd、無ければ items_part*.json）
// どれにも無いものは画面側でらとりおの性能データから文章を作る
// 使い方: node ro4/m/buildfinder/tools-bf-desc.mjs [エンチャントDBの data.json]
import fs from "fs";
import { ItemObjNew } from "../../../engine/equip/item.dat.js";
import { CardObjNew } from "../../../engine/equip/card.dat.js";
import { CARD_KIND_ENCHANT } from "../../../engine/const/EnumCardKind.js";

const here = new URL(".", import.meta.url).pathname;
const src = process.argv[2] || "/mnt/project-files/enchant-db/v2/site/data.json";
const D = JSON.parse(fs.readFileSync(src, "utf8"));
const parts = JSON.parse(fs.readFileSync(here + "../items_manifest.json", "utf8")).parts;
const A = parts.flatMap((p) => JSON.parse(fs.readFileSync(here + "../" + p, "utf8")));

// 表記の揺れを寄せる（空白・全角英数・スロット表記）
const norm = (s) => String(s).normalize("NFKC").replace(/\[\d\]$/, "").replace(/\s+/g, "").replace(/[＜<>＞]/g, "");
const isJa = (c) => c && /[^\x00-\x7f]/.test(c) && !/[／]/.test(c);

// 公式説明は改行が空白になっているので、日本語どうしの間の空白（折り返し）を詰める。
// 「―――」で区切られた塊を1行にし、「系列 :」以降は性能欄（§ の後ろ）にする
function fmtFlat(t) {
	t = t.replace(/<[^>]*>/g, "").replace(/-{2,}カードセット効果-{2,}/g, "―――――").replace(/\s*・\s*/g, " ");
	const secs = t.split(/\s*―{3,}\s*/).map((s) => s.trim()).filter(Boolean);
	let spec = "";
	const lines = [];
	for (const s of secs) {
		const m = s.match(/^(.*?)\s*(系列 : .*)$/s);
		const body = m ? m[1] : s;
		if (m) spec = m[2];
		if (!body) continue;
		let o = "";
		for (let i = 0; i < body.length; i++) {
			const c = body[i];
			if (c === " " && (isJa(body[i - 1]) || body[i - 1] === "]") && (isJa(body[i + 1]) || body[i + 1] === "[")) continue;
			o += c;
		}
		o = o.replace(/\s+/g, " ").replace(/ \+ /g, " +").replace(/ - (\d)/g, " -$1");
		// 効果の値（数字・%）の後に続く次の効果・条件は改行する。「〜の時、追加で BaseLv」も改行
		o = o.replace(/([\d%]) (?=[^\x00-\x7f,／]|\[|BaseLv)/g, "$1\n").replace(/([、で]) (?=BaseLv)/g, "$1\n");
		lines.push(o);
	}
	// 最初の塊が数値を含まない文章なら、アイテムの紹介文として薄く出す
	if (lines.length > 1 && !/[+\-%]|\d/.test(lines[0])) lines[0] = "\x05" + lines[0];
	return lines.join("\n") + (spec ? "\n§\n" + spec : "");
}

const flatByName = new Map();
for (const x of A) {
	if (!x.description || x.description === "0") continue;
	const k = norm(x.displayname);
	if (!flatByName.has(k)) flatByName.set(k, x);
}
const descByName = new Map(Object.entries(D.desc).map(([k, v]) => [norm(k), v]));
const xdByName = new Map();
for (const it of D.items) {
	const t = D.xd[String(it.rid)];
	if (!t) continue;
	for (const n of [it.n, ...(it.v || [])]) if (!xdByName.has(norm(n))) xdByName.set(norm(n), t);
}

const out = { e: {}, c: {}, i: {}, o: { e: {}, c: {}, i: {} } }; // o: らとりおのID→公式ツールのID（ページへのリンク用）
const idsByName = new Map(Object.entries(D.ids).map(([k, v]) => [norm(k), v]));
const ridByName = new Map(D.items.filter((x) => x.rid).flatMap((x) => [x.n, ...(x.v || [])].map((n) => [norm(n), x.rid])));
let ne = 0, nc = 0, ni = 0, ce = 0, cc = 0, ci = 0;
for (const c of CardObjNew) {
	if (!c || !c[0]) continue;
	const id = c[0], name = c[2];
	if (!name || name === "(カードなし)") continue;
	if (c[1] === CARD_KIND_ENCHANT) {
		// エンチャント
		ce++;
		const oid = idsByName.get(norm(name));
		if (oid) out.o.e[id] = oid;
		const t = descByName.get(norm(name)) ?? (flatByName.get(norm(name)) && fmtFlat(flatByName.get(norm(name)).description));
		if (t) { out.e[id] = t; ne++; }
		continue;
	}
	cc++;
	const f = flatByName.get(norm(name) + "カード") || flatByName.get(norm(name));
	if (f && f.is_card) { out.c[id] = fmtFlat(f.description); out.o.c[id] = f.id; nc++; }
}
for (const x of ItemObjNew) {
	if (!x || !x[0] || !x[8] || /装備なし$/.test(x[8])) continue;
	ci++;
	const k = norm(x[8]);
	const fi = flatByName.get(k);
	const oid = ridByName.get(k) ?? (fi && !fi.is_card && !fi.is_enchant ? fi.id : null);
	if (oid) out.o.i[x[0]] = oid;
	const t = xdByName.get(k) ?? (flatByName.get(k) && !flatByName.get(k).is_card ? fmtFlat(flatByName.get(k).description) : null);
	if (t) { out.i[x[0]] = t; ni++; }
}
fs.writeFileSync(here + "bf-desc.json", JSON.stringify(out));
console.error(`link e${Object.keys(out.o.e).length} c${Object.keys(out.o.c).length} i${Object.keys(out.o.i).length}`);
console.error(`enchant ${ne}/${ce} card ${nc}/${cc} item ${ni}/${ci}`, (fs.statSync(here + "bf-desc.json").size / 1e6).toFixed(2) + "MB");
