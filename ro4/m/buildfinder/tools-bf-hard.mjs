// RO BuildFinder: 計算処理の中で装備IDを直接見ている（データのSPに出てこない効果を持つ）装備・カードの一覧を作る
// node ro4/m/buildfinder/tools-bf-hard.mjs > ro4/m/buildfinder/bf-hard.json
import fs from 'fs'; import path from 'path';
const root = new URL('../../../engine', import.meta.url).pathname;
const I = {}, C = {};
for (const l of fs.readFileSync(root + '/equip/item.dat.js', 'utf8').split('\n')) { const m = l.match(/^export const ((?:ITEM_ID|ITEM_SET_ID)_\w+) = (\d+);/); if (m) I[m[1]] = +m[2]; }
for (const l of fs.readFileSync(root + '/equip/card.dat.js', 'utf8').split('\n')) { const m = l.match(/^export const ((?:CARD_ID|CARD_SET_ID)_\w+) = (\d+);/); if (m) C[m[1]] = +m[2]; }
// ファイル → 指標の分類
const CATS = {
	stat: /status\/(stallcalc|stplus-calc|aspd|avoid-flee|critical|stallcalc-motion-hp-sp|stallcalc-crit-matk|stallcalc-magic-dmg-aspd)\.js$|chara\/chara\.js$/,
	cast: /status\/(stallcalc|cast-delay|skill-cast-param|skill-cool)\.js$|chara\/chara\.js$/,
	ign: /status\/(stallcalc|stallcalc-boss-def-ignore|stallcalc-mdef-hit|stallcalc-mdef-elem-dmg)\.js$/,
	hit: /status\/(stallcalc|stallcalc-guaranteed-hit)\.js$/,
	resist: /status\/(stallcalc|resist-heal|stallcalc-player-race-resist|stallcalc-elem-size-longrange-resist)\.js$|chara\/chara\.js$/,
	elm: /chara\/chara\.js$/,
};
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const out = {};
for (const k of Object.keys(CATS)) out[k] = { items: new Set(), cards: new Set() };
for (const f of walk(root)) {
	if (!f.endsWith('.js')) continue;
	const cats = Object.keys(CATS).filter((k) => CATS[k].test(f));
	if (!cats.length) continue;
	const t = fs.readFileSync(f, 'utf8');
	const it = new Set(), cd = new Set();
	for (const m of t.matchAll(/\b(?:ITEM_ID|ITEM_SET_ID)_\w+/g)) if (I[m[0]] != null) it.add(I[m[0]]);
	for (const m of t.matchAll(/\b(?:CARD_ID|CARD_SET_ID)_\w+/g)) if (C[m[0]] != null) cd.add(C[m[0]]);
	for (const m of t.matchAll(/EquipNumSearch(?:MIG)?\((\d+)/g)) it.add(+m[1]);
	for (const m of t.matchAll(/CardNumSearch\((\d+)/g)) cd.add(+m[1]);
	for (const k of cats) { it.forEach((x) => out[k].items.add(x)); cd.forEach((x) => out[k].cards.add(x)); }
}
for (const k of Object.keys(out)) out[k] = { items: [...out[k].items].sort((a, b) => a - b), cards: [...out[k].cards].sort((a, b) => a - b) };
process.stdout.write(JSON.stringify(out));
