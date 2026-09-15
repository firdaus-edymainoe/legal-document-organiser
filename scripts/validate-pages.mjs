import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const SAMPLE_DIR = "/Users/m.firdaus98/Downloads/New Folder With Items";
const COMBINED = "/Users/m.firdaus98/Downloads/e2e-combined.pdf";
const SMALL = [
	"1. Notis Usul(Kebenaran Untuk Merayu)(LSK) +@003.pdf",
	"5. L2052(A).Low Shiow Kian - AFIDAVIT JAWAPAN RESPONDEN PERTAMA 1 +@002.pdf",
	"9. b-08-352-11-2025 +@002.pdf",
	"14. Notis Makluman Butiran Pihak Pemohon (LSK) +@002.pdf",
	"15. Notis Butiran R2 - Kwan +@002.pdf",
	"18. 20260604 surat +@002.pdf",
];

async function load(filePath) {
	const data = new Uint8Array(await readFile(filePath));
	return getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
}

function bandText(items, height, fromFrac, toFrac) {
	const y0 = height * fromFrac;
	const y1 = height * toFrac;
	return items
		.filter((it) => it.y >= y0 && it.y < y1 && it.str.trim())
		.map((it) => it.str.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join(" ")
		.slice(0, 180);
}

async function layout(page) {
	const viewport = page.getViewport({ scale: 1 });
	const content = await page.getTextContent();
	const items = [];
	for (const item of content.items) {
		if (!item.str || !item.transform) continue;
		const tx = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
		items.push({ str: item.str, x: tx[0], y: tx[1] });
	}
	return {
		rotate: page.rotate,
		width: viewport.width,
		height: viewport.height,
		top: bandText(items, viewport.height, 0, 0.28),
		bottom: bandText(items, viewport.height, 0.72, 1),
		all: items
			.filter((it) => it.str.trim())
			.sort((a, b) => a.y - b.y || a.x - b.x)
			.map((it) => it.str)
			.join(" ")
			.replace(/\s+/g, " ")
			.slice(0, 240),
	};
}

function overlap(a, b) {
	if (!a || !b) return 0;
	const tokens = (s) =>
		new Set(
			s
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((t) => t.length >= 4),
		);
	const A = tokens(a);
	const B = tokens(b);
	if (A.size === 0 || B.size === 0) return 0;
	let n = 0;
	for (const t of A) if (B.has(t)) n += 1;
	return n / Math.min(A.size, B.size);
}

async function main() {
	const combined = await load(COMBINED);
	let idx = 0;
	const upsided = [];
	console.log(
		["p", "srcRot", "verdict", "top~top", "top~bot", "srcTop", "outTop"].join("\t"),
	);
	for (const name of SMALL) {
		const src = await load(path.join(SAMPLE_DIR, name));
		for (let p = 1; p <= src.numPages; p++) {
			idx += 1;
			const srcPage = await src.getPage(p);
			const outPage = await combined.getPage(idx);
			const a = await layout(srcPage);
			const b = await layout(outPage);
			const topTop = overlap(a.top, b.top);
			const topBot = overlap(a.top, b.bottom);
			let verdict = "AMBIG";
			if (topBot >= 0.45 && topBot > topTop + 0.15) verdict = "UPSIDE";
			else if (overlap(a.bottom, b.top) >= 0.45 && overlap(a.bottom, b.top) > topTop + 0.15) {
				verdict = "UPSIDE";
			} else if (/serial number will be used/i.test(b.top) && !/serial number will be used/i.test(a.top)) {
				verdict = "UPSIDE";
			} else if (topTop >= 0.45 && topTop > topBot + 0.15) verdict = "OK";
			else if (!a.top && !b.top) verdict = "OK";
			else if (!a.top && b.top && overlap(a.bottom, b.bottom) >= 0.4) verdict = "OK";
			if (verdict === "UPSIDE") upsided.push(idx);
			console.log(
				[
					idx,
					a.rotate,
					verdict,
					topTop.toFixed(2),
					topBot.toFixed(2),
					JSON.stringify(a.top.slice(0, 70)),
					JSON.stringify(b.top.slice(0, 70)),
				].join("\t"),
			);
		}
	}
	console.log(`compared ${idx} / combined ${combined.numPages}`);
	if (upsided.length > 0) {
		console.error(`upside-down pages: ${upsided.join(", ")}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
