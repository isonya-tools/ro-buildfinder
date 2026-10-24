// RO BuildFinder: 計算処理の中で装備IDを直接見ている（データのSPに出てこない効果を持つ）装備・カードの一覧を作る
// node ro4/m/buildfinder/tools-bf-hard.mjs > /tmp/bf-hard.json && mv /tmp/bf-hard.json ro4/m/buildfinder/bf-hard.json（probe を引き継ぐので直接リダイレクトしない）
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
// スキルごとの詠唱・CT: skill-cast-param.js / skill-cool.js の中で「skillId == SKILL_ID_◯◯」の枠の中で見ている装備・カード
const S = {};
for (const l of fs.readFileSync(root + '/skill/skill.dat.js', 'utf8').split('\n')) { const m = l.match(/^export const (SKILL_ID_\w+)\s*=\s*(\d+);/); if (m) S[m[1]] = +m[2]; }
const bySkill = {};
for (const f of ['status/skill-cast-param.js', 'status/skill-cool.js']) {
	const t = fs.readFileSync(root + '/' + f, 'utf8');
	const fstart = t.search(/\n(export\s+)?(async\s+)?function\b/);
	for (const m of t.matchAll(/\b(?:ITEM_ID|ITEM_SET_ID|CARD_ID|CARD_SET_ID)_\w+|EquipNumSearch\((\d+)|CardNumSearch\((\d+)/g)) {
		if (m.index < fstart) continue;
		const isCard = /^CARD_|^CardNum/.test(m[0]);
		const id = m[1] ? +m[1] : m[2] ? +m[2] : isCard ? C[m[0]] : I[m[0]];
		if (id == null) continue;
		// 囲んでいるブロックの見出しを外側へたどり、最初に SKILL_ID が出てきたものを対象スキルとする
		let depth = 0, skills = [];
		for (let i = m.index; i >= 0; i--) {
			const ch = t[i];
			if (ch === '}') depth++;
			else if (ch === '{') {
				if (depth > 0) { depth--; continue; }
				const lineStart = t.lastIndexOf('\n', i - 1);
				const head = t.slice(t.lastIndexOf('\n', lineStart - 1), i);
				const ss = [...head.matchAll(/SKILL_ID_\w+/g)].map((x) => S[x[0]]).filter((x) => x != null);
				if (ss.length) { skills = ss; break; }
				if (/^\s*(export\s+)?function\b/m.test(head)) break;
			}
		}
		for (const sid of skills.length ? skills : ['any']) {
			const e = bySkill[sid] ??= { items: new Set(), cards: new Set() };
			e[isCard ? 'cards' : 'items'].add(id);
		}
	}
}
out.castBySkill = Object.fromEntries(Object.entries(bySkill).map(([k, v]) => [k, { items: [...v.items].sort((a, b) => a - b), cards: [...v.cards].sort((a, b) => a - b) }]));

// 実際に装備して調べた結果（tools-bf-probe.js）は前のファイルから引き継ぐ
try { const prev = JSON.parse(fs.readFileSync(new URL('./bf-hard.json', import.meta.url), 'utf8')); if (prev.probe) out.probe = prev.probe; } catch { /* 初回 */ }
process.stdout.write(JSON.stringify(out));
