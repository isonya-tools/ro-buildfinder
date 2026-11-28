/**
 * アクセス解析（Google アナリティクス）。検索条件・結果に出た装備・反映した構成を匿名で送る。
 * 個人を特定する情報（名前・入力した自由記述）は送らない。送れなかった場合は何もしない。
 */
const GA_ID = "G-PEQD1X40NW";
try {
	if (!window.gtag) {
		window.dataLayer = window.dataLayer || [];
		window.gtag = function () { window.dataLayer.push(arguments); };
		const s = document.createElement("script");
		s.async = true;
		s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
		document.head.append(s);
		window.gtag("js", new Date());
		window.gtag("config", GA_ID);
	}
} catch { /* 計測できなくても動作に影響させない */ }

/** イベントを送る（値は100文字までに切る） */
export function track(name, params = {}) {
	try {
		const p = {};
		for (const [k, v] of Object.entries(params)) p[k] = typeof v === "string" ? v.slice(0, 100) : v;
		window.gtag("event", name, p);
	} catch { /* 何もしない */ }
}
