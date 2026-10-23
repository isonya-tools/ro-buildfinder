// bf-hard.json（計算処理がIDを直接見る装備・カードの分類）が、今のアイテムデータに追いついているか確かめる。
// 使い方: node ro4/m/buildfinder/tools-bf-hard-check.mjs            … 確認（追いついていなければ終了コード1）
//         node ro4/m/buildfinder/tools-bf-hard-check.mjs --update   … 分類（tools-bf-hard.mjs と tools-bf-probe.js）をやり直したあとに、記録を今の状態に更新
// 上流（らとりお）にアイテム・カードが追加されたら、分類をやり直す（tools-bf-hard.mjs → tools-bf-probe.js を10分ほど）。
import fs from "fs";
const root = new URL("../../../", import.meta.url);
const { ItemObjNew } = await import(new URL("engine/equip/item.dat.js", root));
const { CardObjNew } = await import(new URL("engine/equip/card.dat.js", root));
const ids = (a) => a.filter(Boolean).map((x) => x[0]);
const now = { maxItemId: Math.max(...ids(ItemObjNew)), items: ids(ItemObjNew).length, maxCardId: Math.max(...ids(CardObjNew)), cards: ids(CardObjNew).length };
const file = new URL("bf-hard-meta.json", import.meta.url);
if (process.argv.includes("--update")) {
	fs.writeFileSync(file, JSON.stringify({ ...now, date: new Date().toISOString().slice(0, 10) }, null, 1) + "\n");
	console.log("記録を更新しました", now);
} else {
	const old = JSON.parse(fs.readFileSync(file, "utf8"));
	const same = ["maxItemId", "items", "maxCardId", "cards"].every((k) => old[k] === now[k]);
	console.log(same ? "追いついています" : "アイテム・カードが増えています。分類をやり直してください", { 記録: old, 今: now });
	process.exit(same ? 0 : 1);
}
