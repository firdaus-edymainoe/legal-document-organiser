import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

import { autoFixOntoA4, A4 } from "../src/lib/pdf-normalize.ts";

const SAMPLE_DIR =
	process.env.SAMPLE_DIR ??
	"/Users/m.firdaus98/Downloads/New Folder With Items";

const SMALL = [
	"1. Notis Usul(Kebenaran Untuk Merayu)(LSK) +@003.pdf",
	"5. L2052(A).Low Shiow Kian - AFIDAVIT JAWAPAN RESPONDEN PERTAMA 1 +@002.pdf",
	"9. b-08-352-11-2025 +@002.pdf",
	"14. Notis Makluman Butiran Pihak Pemohon (LSK) +@002.pdf",
	"15. Notis Butiran R2 - Kwan +@002.pdf",
	"18. 20260604 surat +@002.pdf",
];

async function assertCanonical(bytes, label) {
	const doc = await PDFDocument.load(bytes);
	if (doc.getPageCount() <= 0) {
		throw new Error(`${label}: expected pages`);
	}
	for (const [i, page] of doc.getPages().entries()) {
		const crop = page.getCropBox();
		const media = page.getMediaBox();
		if (page.getRotation().angle !== 0) {
			throw new Error(`${label} p${i}: rotate ${page.getRotation().angle}`);
		}
		if (Math.abs(crop.x) > 0.01 || Math.abs(crop.y) > 0.01) {
			throw new Error(`${label} p${i}: crop origin`);
		}
		if (Math.abs(crop.width - A4.widthPt) > 1 || Math.abs(crop.height - A4.heightPt) > 1) {
			throw new Error(`${label} p${i}: crop ${crop.width}x${crop.height}`);
		}
		if (Math.abs(media.width - A4.widthPt) > 1 || Math.abs(media.height - A4.heightPt) > 1) {
			throw new Error(`${label} p${i}: media ${media.width}x${media.height}`);
		}
	}
}

async function main() {
	const names = await readdir(SAMPLE_DIR);
	const pdfs = names.filter((n) => n.toLowerCase().endsWith(".pdf"));
	if (pdfs.length < 20) {
		throw new Error(`Sample folder has ${pdfs.length} PDFs`);
	}

	const docs = [];
	for (const name of SMALL) {
		const started = Date.now();
		const bytes = new Uint8Array(await readFile(path.join(SAMPLE_DIR, name)));
		const result = await autoFixOntoA4(bytes);
		console.log(
			`ingest ${name} → ${result.pageCount}p auto=${result.changedPages} ${Date.now() - started}ms`,
		);
		await assertCanonical(result.bytes, name);
		docs.push({ name, result });
	}

	const affidavit = docs.find((d) => d.name.startsWith("5."));
	if (!affidavit) throw new Error("missing affidavit sample");
	if (affidavit.result.pageCount !== 10) {
		throw new Error(`affidavit pages ${affidavit.result.pageCount}`);
	}
	if (!affidavit.result.autoFixApplied) {
		throw new Error("affidavit should be auto-fixed (/Rotate 270)");
	}

	const letter = docs.find((d) => d.name.startsWith("9."));
	if (!letter?.result.autoFixApplied) {
		throw new Error("letter sample should be auto-fixed");
	}

	const merged = await PDFDocument.create();
	for (const doc of docs) {
		const src = await PDFDocument.load(doc.result.bytes);
		const pages = await merged.copyPages(src, src.getPageIndices());
		for (const page of pages) merged.addPage(page);
	}
	const combined = await merged.save();
	await assertCanonical(combined, "combine");
	const expected = docs.reduce((n, d) => n + d.result.pageCount, 0);
	const combinedDoc = await PDFDocument.load(combined);
	if (combinedDoc.getPageCount() !== expected) {
		throw new Error(`combine pages ${combinedDoc.getPageCount()} != ${expected}`);
	}
	console.log(`combined ${expected} pages, ${combined.byteLength} bytes`);
	const outPath = "/Users/m.firdaus98/Downloads/e2e-combined.pdf";
	await writeFile(outPath, combined);
	console.log(`wrote ${outPath}`);
	await import(new URL("./validate-pages.mjs", import.meta.url).href);

	const largeStarted = Date.now();
	const submission = await readFile(
		path.join(
			SAMPLE_DIR,
			"21. 22519802(A).Low Shiow Kian - Hujahan Bertulis Responden Pertama.FINAL +@002.pdf",
		),
	);
	const authorities = await readFile(
		path.join(SAMPLE_DIR, "20. Ikatan Otoriti R2 - Kwan Yew Teck +@002.pdf"),
	);
	const a = await autoFixOntoA4(new Uint8Array(submission));
	if (a.pageCount !== 67) throw new Error(`submission pages ${a.pageCount}`);
	await assertCanonical(a.bytes, "67-page submission");
	const b = await autoFixOntoA4(new Uint8Array(authorities));
	if (b.pageCount !== 227) throw new Error(`authorities pages ${b.pageCount}`);
	await assertCanonical(b.bytes, "227-page authorities");
	console.log(`large files ok (${Date.now() - largeStarted}ms)`);
	console.log("ok");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
