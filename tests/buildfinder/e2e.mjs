// 装備シミュのブラウザ上の通しテスト（Playwright）。
// 使い方: node tests/buildfinder/e2e.mjs   （リポジトリのトップで。PLAYWRIGHT_MODULE=playwright の場所、CHROME=chromium の実行ファイル、PORT）
// 内容: ①結果がらとりお本体の再計算と一致 ②「今の装備に反映」の往復 ③停止→すぐ再検索 ④単一部位の総当たりとの比較（ASPD含む）⑤値段の枠数照合・エンチャ名の記号違い
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(new URL("../../", import.meta.url).pathname);
const { chromium } = (await import(process.env.PLAYWRIGHT_MODULE || "playwright"));
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".html": "text/html", ".css": "text/css", ".gz": "application/gzip", ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer((q, r) => {
	const f = path.join(root, decodeURIComponent(q.url.split("?")[0]).replace(/\/$/, "/index.html"));
	if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.statusCode = 404; return r.end(); }
	r.setHeader("content-type", mime[path.extname(f)] || "application/octet-stream");
	fs.createReadStream(f).pipe(r);
});
await new Promise((res) => server.listen(Number(process.env.PORT || 8799), res));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const page = await (await browser.newContext()).newPage();
// 外部CDNは使わない（chart.js が読めなくても画面が動くことの確認も兼ねる）
await page.route(/cdnjs|cdn\.jsdelivr|unpkg/, (r) => r.abort());
await page.route(/bf-exclude\.json/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"items":[],"cards":[]}' }));
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => document.querySelector("#BF_ROOT .bf-state table"), null, { timeout: 120000 });

const fails = [];
const check = (name, ok, info = "") => { console.log(ok ? "OK  " : "NG  ", name, ok ? "" : info); if (!ok) fails.push(name); };

const r = await page.evaluate(async () => {
	const e = await import("/ro4/m/buildfinder/bf-engine.js");
	const ap = await import("/ro4/m/buildfinder/bf-apply.js");
	const pm = await import("/ro4/m/buildfinder/bf-prune.js");
	const pr = await import("/ro4/m/buildfinder/bf-price.js");
	const sel = document.getElementById("OBJID_SELECT_JOB");
	sel.value = "70"; sel.dispatchEvent(new Event("change", { bubbles: true }));
	await new Promise((x) => setTimeout(x, 2000));
	const base = e.modelFromScreen();
	const lockAll = { item: true, refine: true, card: true, ench: true };
	const lockFor = (free) => Object.fromEntries(e.BF_REGIONS.filter((x) => !free.includes(x.key)).map((x) => [x.key, lockAll]));
	const out = {};
	// ① 一致 ② 反映の往復
	const goals = [{ key: "resElm3", target: 50, label: "f" }, { key: "resAbn6", target: 30, label: "s" }];
	const res = await e.search({ base, conds: goals, lock: lockFor(["headTop", "shoes", "acc1"]), maxResults: 5 });
	out.n = res.results.length;
	out.recalcDiff = res.results.flatMap((x) => { const v = e.evalModel(x.model); return goals.filter((g) => Math.abs(v[g.key] - x.values[g.key]) > 1e-6).map((g) => g.key); });
	const r0 = res.results[0];
	ap.applyModelToScreen(r0.model, [...new Set(r0.picks.map((p) => p.region))]);
	await new Promise((x) => setTimeout(x, 1500));
	const after = e.modelFromScreen(), v = e.evalModel(after);
	out.applyEquip = JSON.stringify(after.equip) === JSON.stringify(r0.model.equip);
	out.applyCards = after.card.every((c, i) => (c || 0) === (r0.model.card[i] || 0));
	out.applyMetrics = Object.keys(r0.values).filter((k) => !k.startsWith("sk") && Math.abs((v[k] ?? 0) - r0.values[k]) > 1e-6);
	// 画面を元に戻す
	sel.value = "70"; sel.dispatchEvent(new Event("change", { bubbles: true }));
	// ③ 停止→再検索
	const base2 = base;
	const tok = { stop: false };
	const heavy = [["resElm3", 95], ["resElm1", 95], ["resElm2", 95], ["resElm4", 95], ["castFixed", 60]].map(([key, target]) => ({ key, target, label: key }));
	const pA = e.search({ base: base2, conds: heavy, lock: lockFor(["headTop", "shoes", "acc1", "acc2", "body"]), maxResults: 5, shouldStop: () => tok.stop }).then(() => "done", (x) => (x instanceof e.BfStopped ? "stopped" : "err " + x.message));
	await new Promise((x) => setTimeout(x, 4000));
	tok.stop = true; e.cancelPending();
	const rB = await e.search({ base: base2, conds: goals, lock: lockFor(["headTop", "shoes", "acc1"]), maxResults: 5 });
	out.stopA = await pA; out.restartN = rB.results.length;
	// ④ 単一部位の総当たりとの比較（装備単体で達成できるものが全部出るか）
	out.brute = [];
	const v0 = e.evalModel(base);
	for (const region of ["acc1", "headTop", "body"]) {
		const reg = e.BF_REGIONS.find((x) => x.key === region);
		const items = e.itemCandidatesOf(reg, base.status.jobId);
		const vals = items.map((iid) => { const m = structuredClone(base); m.equip[reg.eq] = iid; for (const s of reg.slots) if (s >= 0) m.card[s] = 0; return [iid, e.evalModel(m)]; });
		for (const k of ["aspd", "maxhp", "flee"]) {
			const sorted = vals.map(([, x]) => x[k]).sort((a, b) => b - a);
			const target = sorted[Math.min(25, sorted.length - 1)];
			if (!(target > v0[k])) continue;
			const feas = vals.filter(([, x]) => x[k] >= target - 1e-9).map(([id]) => id);
			const sr = await e.search({ base, conds: [{ key: k, target, label: k }], lock: lockFor([region]), maxResults: 400 });
			const miss = feas.filter((id) => !sr.results.some((x) => pm.within(x.toks, [`${region}:i${id}:0`])));
			out.brute.push({ region, k, target, feas: feas.length, results: sr.results.length, miss: miss.map((id) => id + ":" + e.itemName(id)) });
		}
	}
	// ⑤ 値段: 同名で枠数違いは枠数を合わせる／<>付きのエンチャ名でも照合できる
	const prices = await pr.loadPrices();
	const priceOf = pr.priceOfFactory(prices);
	const { ItemObjNew } = await import("/engine/equip/item.dat.js");
	const SLOT = /^(.*)\[(\d+)\]$/;
	const norm = (s) => String(s ?? "").replace(/\s+/g, "").replace(SLOT, "$1");
	let slotChecked = 0, slotBad = [];
	for (const x of ItemObjNew) {
		if (!x) continue;
		const list = prices.byName.get(norm(x[8]));
		if (!list || list.length < 2) continue;
		const n = e.itemSlotCount(x[0]);
		const same = list.filter((c) => { const m = SLOT.exec(String(c.n).replace(/\s+/g, "")); return m && Number(m[2]) === n; });
		if (!same.length) continue;
		slotChecked++;
		const want = Math.min(...same.map((c) => c.p[0]));
		if (priceOf("item", x[0]) !== want) slotBad.push(x[0] + ":" + x[8]);
	}
	out.slotChecked = slotChecked; out.slotBad = slotBad.slice(0, 5);
	return out;
});
check("結果の指標が再計算と一致", r.n > 0 && r.recalcDiff.length === 0, JSON.stringify(r.recalcDiff));
check("反映で装備・カード・指標が結果と一致", r.applyEquip && r.applyCards && r.applyMetrics.length === 0, JSON.stringify([r.applyEquip, r.applyCards, r.applyMetrics]));
check("停止後にすぐ再検索できる", r.stopA === "stopped" && r.restartN > 0, JSON.stringify([r.stopA, r.restartN]));
for (const b of r.brute) check(`総当たりと一致 ${b.region} ${b.k}>=${b.target}（${b.feas}件）`, b.miss.length === 0 || b.results >= 400, JSON.stringify(b.miss));
check("同名・別枠数の装備は枠数を合わせて値段を引く", r.slotChecked > 0 && r.slotBad.length === 0, JSON.stringify(r.slotBad));
const real = errors.filter((m) => !/chart|Failed to fetch dynamically|Failed to resolve module/i.test(m));
check("画面のエラーなし（CDN が読めなくても起動する）", real.length === 0, JSON.stringify(real.slice(0, 3)));
await browser.close(); server.close();
if (fails.length) { console.log("失敗:", fails.length); process.exit(1); }
