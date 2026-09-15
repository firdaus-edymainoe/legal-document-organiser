import { PDFDocument, PDFName, degrees, rgb, toDegrees } from "pdf-lib";

import { loadPdfForEditing, SAVE_OPTIONS } from "./pdf-security";

export const A4 = {
	widthPt: 595.28,
	heightPt: 841.89,
} as const;

export type Rotation = 0 | 90 | 180 | 270;

export type AutoFixResult = {
	bytes: Uint8Array;
	pageCount: number;
	autoFixApplied: boolean;
	changedPages: number;
	rotatedPages: number;
	scaledPages: number;
	autoFixedPageFixTypes: Record<number, ("rotation" | "scaling")[]>;
};

function normalizeRotation(angle: number): Rotation {
	const snapped = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
	if (snapped === 0 || snapped === 90 || snapped === 180 || snapped === 270) {
		return snapped;
	}
	return 0;
}

function addRotation(a: Rotation, b: Rotation): Rotation {
	return normalizeRotation(a + b);
}

function displayedSize(
	width: number,
	height: number,
	rotateCw: Rotation,
): { width: number; height: number } {
	if (rotateCw === 90 || rotateCw === 270) {
		return { width: height, height: width };
	}
	return { width, height };
}

function cwToCcw(rotateCw: Rotation): Rotation {
	if (rotateCw === 0) return 0;
	return normalizeRotation(360 - rotateCw);
}

/**
 * Acrobat `/Rotate` is already the clockwise bake angle. `placementOnA4`
 * converts that to pdf-lib's CCW `drawPage` (once). Do not invert here —
 * doing so 90↔270's the page 180° off.
 */
export function flattenViewerRotation(sourceRotateCw: Rotation): Rotation {
	return sourceRotateCw;
}

/**
 * Visible text angle in clockwise degrees (same convention as `/Rotate`).
 * pdf.js content transforms are counter-clockwise; Acrobat `/Rotate` is clockwise.
 */
export function viewerTextAngle(
	contentCcw: Rotation,
	sourceRotateCw: Rotation,
): Rotation {
	return addRotation(sourceRotateCw, cwToCcw(contentCcw));
}

function placementOnA4(
	srcWidth: number,
	srcHeight: number,
	rotateCw: Rotation,
	destWidth = A4.widthPt,
	destHeight = A4.heightPt,
) {
	const bound = displayedSize(srcWidth, srcHeight, rotateCw);
	const scale = Math.min(destWidth / bound.width, destHeight / bound.height);
	const width = srcWidth * scale;
	const height = srcHeight * scale;
	const boundWidth = bound.width * scale;
	const boundHeight = bound.height * scale;
	const ox = (destWidth - boundWidth) / 2;
	const oy = (destHeight - boundHeight) / 2;
	const rotateCcw = cwToCcw(rotateCw);

	let x = ox;
	let y = oy;
	if (rotateCcw === 90) {
		x = ox + height;
		y = oy;
	} else if (rotateCcw === 180) {
		x = ox + width;
		y = oy + height;
	} else if (rotateCcw === 270) {
		x = ox;
		y = oy + width;
	}

	return { x, y, width, height, rotateCcw, scale };
}

export async function embedPageOntoA4(
	out: PDFDocument,
	srcPage: ReturnType<PDFDocument["getPage"]>,
	extraRotate: Rotation = 0,
	color?: { red: number; green: number; blue: number },
): Promise<void> {
	const crop = srcPage.getCropBox();
	const embedded = await out.embedPage(srcPage, {
		left: crop.x,
		bottom: crop.y,
		right: crop.x + crop.width,
		top: crop.y + crop.height,
	});
	const page = out.addPage([A4.widthPt, A4.heightPt]);
	page.setMediaBox(0, 0, A4.widthPt, A4.heightPt);
	page.setCropBox(0, 0, A4.widthPt, A4.heightPt);
	page.node.delete(PDFName.of("BleedBox"));
	page.node.delete(PDFName.of("TrimBox"));
	page.node.delete(PDFName.of("ArtBox"));
	page.setRotation(degrees(0));

	if (color) {
		page.drawRectangle({
			x: 0,
			y: 0,
			width: A4.widthPt,
			height: A4.heightPt,
			color: rgb(color.red, color.green, color.blue),
		});
	}

	const sourceRotation = normalizeRotation(toDegrees(srcPage.getRotation()));
	const totalCw = addRotation(flattenViewerRotation(sourceRotation), extraRotate);
	const place = placementOnA4(embedded.width, embedded.height, totalCw);
	page.drawPage(embedded, {
		x: place.x,
		y: place.y,
		width: place.width,
		height: place.height,
		rotate: degrees(place.rotateCcw),
	});
}

export async function normalizeOntoA4(
	sourceBytes: Uint8Array,
	extraRotateByPage: ReadonlyMap<number, Rotation> = new Map(),
): Promise<Uint8Array> {
	const source = await loadPdfForEditing(sourceBytes);
	const out = await PDFDocument.create();
	const pages = source.getPages();
	for (let i = 0; i < pages.length; i++) {
		const srcPage = pages[i];
		if (!srcPage) throw new Error(`Missing source page ${i}`);
		await embedPageOntoA4(out, srcPage, extraRotateByPage.get(i) ?? 0);
	}
	return out.save(SAVE_OPTIONS);
}

function isA4Size(width: number, height: number): boolean {
	return (
		(Math.abs(width - A4.widthPt) <= 5 && Math.abs(height - A4.heightPt) <= 5) ||
		(Math.abs(width - A4.heightPt) <= 5 && Math.abs(height - A4.widthPt) <= 5)
	);
}

export async function autoFixOntoA4(
	pdfBytes: Uint8Array,
	extraRotateByPage: ReadonlyMap<number, Rotation> = new Map(),
): Promise<AutoFixResult> {
	const source = await loadPdfForEditing(pdfBytes);
	const pages = source.getPages();
	const autoFixedPageFixTypes: Record<number, ("rotation" | "scaling")[]> = {};
	let rotatedPages = 0;
	let scaledPages = 0;

	for (let i = 0; i < pages.length; i++) {
		const page = pages[i];
		if (!page) continue;
		const { width, height } = page.getSize();
		const sourceRotation = normalizeRotation(toDegrees(page.getRotation()));
		const extra = extraRotateByPage.get(i) ?? 0;
		const fixes: ("rotation" | "scaling")[] = [];
		if (sourceRotation !== 0 || extra !== 0) {
			fixes.push("rotation");
			rotatedPages += 1;
		}
		if (!isA4Size(width, height) || sourceRotation === 90 || sourceRotation === 270) {
			fixes.push("scaling");
			scaledPages += 1;
		}
		if (fixes.length > 0) autoFixedPageFixTypes[i] = fixes;
	}

	const bytes = await normalizeOntoA4(pdfBytes, extraRotateByPage);
	const changedPages = Object.keys(autoFixedPageFixTypes).length;
	return {
		bytes,
		pageCount: pages.length,
		autoFixApplied: changedPages > 0,
		changedPages,
		rotatedPages,
		scaledPages,
		autoFixedPageFixTypes,
	};
}

export async function rebuildDocFittingPages(
	doc: PDFDocument,
	pageIndices: ReadonlySet<number>,
): Promise<PDFDocument> {
	const out = await PDFDocument.create();
	const pages = doc.getPages();
	for (let i = 0; i < pages.length; i++) {
		const srcPage = pages[i];
		if (!srcPage) continue;
		if (!pageIndices.has(i)) {
			const [copied] = await out.copyPages(doc, [i]);
			out.addPage(copied);
			continue;
		}
		await embedPageOntoA4(out, srcPage, 0);
	}
	return out;
}
