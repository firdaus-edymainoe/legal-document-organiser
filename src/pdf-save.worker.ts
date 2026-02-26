import {
	PDFDocument,
	PageSizes,
	degrees,
	PDFName,
	PDFArray,
	PDFNumber,
} from "pdf-lib";
import { loadPdfForEditing, normalizePdfForEditing } from "./lib/pdf-security";

export type PageModification =
	| { type: "rotate"; pageIndices: number[]; angle: number }
	| { type: "fitToA4"; pageIndices: number[] };

export interface WorkerRequest {
	type: "preview" | "save";
	bytes?: Uint8Array; // omit when useCachedBytes
	modifications: PageModification[];
	pageIndex?: number; // for preview
	fullDocumentPreview?: boolean; // when true, return all pages for scrolling preview
	requestId?: number; // for preview - to ignore stale responses
	useCachedBytes?: boolean; // use bytes from first transfer
}

function getIssuesFromDoc(doc: PDFDocument) {
	const [A4_WIDTH, A4_HEIGHT] = PageSizes.A4;
	const issues: { pageIndex: number; issueType: string; description: string }[] =
		[];
	let pageCount = 0;
	try {
		pageCount = doc.getPageCount();
	} catch {
		return issues;
	}

	for (let index = 0; index < pageCount; index++) {
		try {
			const page = doc.getPage(index);
			const { width, height } = page.getSize();
			const rotation = page.getRotation();

			const isPortrait = height >= width;
			const isPortraitRotation = rotation.angle % 180 === 0;
			const isA4Dimensions =
				Math.abs(width - A4_WIDTH) <= 5 && Math.abs(height - A4_HEIGHT) <= 5;

			if (!isPortrait || !isA4Dimensions || !isPortraitRotation) {
				let type: "size" | "orientation" | "both" = "size";
				const parts: string[] = [];

				if (!isPortrait) {
					parts.push("Landscape Page Box");
					type = "orientation";
				}
				if (!isA4Dimensions) {
					parts.push("Non-A4 Size");
					type = "size";
				}
				if (!isPortraitRotation) {
					parts.push("Sideways Page Rotation");
					type = "orientation";
				}
				if (
					(!isPortrait || !isPortraitRotation) &&
					!isA4Dimensions
				) {
					type = "both";
				}

				issues.push({
					pageIndex: index,
					issueType: type,
					description: parts.join(", "),
				});
			}
		} catch {
			issues.push({
				pageIndex: index,
				issueType: "both",
				description: "Malformed page object",
			});
		}
	}

	return issues;
}

function applyModifications(
	doc: PDFDocument,
	modifications: PageModification[],
) {
	const pageCount = doc.getPageCount();

	for (const mod of modifications) {
		const indices = new Set(mod.pageIndices);

		if (mod.type === "rotate") {
			for (let i = 0; i < pageCount; i++) {
				if (indices.has(i)) {
					try {
						const page = doc.getPage(i);
						const rotation = page.getRotation();
						page.setRotation(degrees(rotation.angle + mod.angle));
					} catch {
						// Ignore malformed pages.
					}
				}
			}
		} else if (mod.type === "fitToA4") {
			const [A4_WIDTH, A4_HEIGHT] = PageSizes.A4;
			for (let i = 0; i < pageCount; i++) {
				if (indices.has(i)) {
					try {
						const page = doc.getPage(i);
						const { width, height } = page.getSize();

						const scale = Math.min(
							A4_WIDTH / width,
							A4_HEIGHT / height,
						);
						const scaledWidth = width * scale;
						const scaledHeight = height * scale;
						const dx = (A4_WIDTH - scaledWidth) / 2;
						const dy = (A4_HEIGHT - scaledHeight) / 2;

						page.setSize(A4_WIDTH, A4_HEIGHT);
						page.scaleContent(scale, scale);
						page.translateContent(dx, dy);
						scaleAndTranslatePageAnnotations(page, scale, dx, dy);
					} catch {
						// Ignore malformed pages.
					}
				}
			}
		}
	}
}

function scaleAndTranslateAnnotationArray(
	array: PDFArray,
	scale: number,
	dx: number,
	dy: number,
) {
	for (let i = 0; i + 1 < array.size(); i += 2) {
		const xObj = array.get(i);
		const yObj = array.get(i + 1);
		if (!(xObj instanceof PDFNumber) || !(yObj instanceof PDFNumber)) continue;
		array.set(i, PDFNumber.of(xObj.asNumber() * scale + dx));
		array.set(i + 1, PDFNumber.of(yObj.asNumber() * scale + dy));
	}
}

function scaleAndTranslatePageAnnotations(
	page: ReturnType<PDFDocument["getPage"]>,
	scale: number,
	dx: number,
	dy: number,
) {
	try {
		const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
		if (!annots) return;

		for (let i = 0; i < annots.size(); i++) {
			try {
				const annotRef = annots.get(i);
				const annotDict = page.doc.context.lookup(annotRef);
				if (!annotDict || typeof (annotDict as any).lookupMaybe !== "function") {
					continue;
				}

				const rect = (annotDict as any).lookupMaybe(PDFName.of("Rect"), PDFArray);
				if (rect instanceof PDFArray) {
					scaleAndTranslateAnnotationArray(rect, scale, dx, dy);
				}

				const quadPoints = (annotDict as any).lookupMaybe(
					PDFName.of("QuadPoints"),
					PDFArray,
				);
				if (quadPoints instanceof PDFArray) {
					scaleAndTranslateAnnotationArray(quadPoints, scale, dx, dy);
				}
			} catch {
				// Ignore malformed annotation references.
			}
		}
	} catch {
		// Ignore malformed annotation collections.
	}
}

// ── Preview: cache the parsed PDFDocument so we don't re-parse on every page switch ──

let cachedBytes: Uint8Array | null = null;
let cachedDoc: PDFDocument | null = null;

async function getOrParseDoc(bytes: Uint8Array): Promise<PDFDocument> {
	// If we already parsed these exact bytes, re-use the cached doc
	if (cachedDoc && cachedBytes === bytes) {
		return cachedDoc;
	}
	const { bytes: editableBytes } = await normalizePdfForEditing(bytes);
	cachedDoc = await loadPdfForEditing(editableBytes);
	cachedBytes = editableBytes;
	return cachedDoc;
}

async function handlePreview(
	bytes: Uint8Array,
	modifications: PageModification[],
	pageIndex: number,
	fullDocumentPreview: boolean,
): Promise<Uint8Array> {
	// Parse once, re-use across preview requests for the same file
	const sourceDoc = await getOrParseDoc(bytes);

	// Work on a lightweight copy so modifications don't accumulate on the cached doc
	const workDoc = await loadPdfForEditing(await sourceDoc.save());
	applyModifications(workDoc, modifications);

	if (fullDocumentPreview) {
		return workDoc.save();
	}

	const tempDoc = await PDFDocument.create();
	const [copiedPage] = await tempDoc.copyPages(workDoc, [pageIndex]);
	tempDoc.addPage(copiedPage);

	return tempDoc.save();
}

// ── Save: apply modifications in-place, no intermediate copies ──

async function handleSave(
	bytes: Uint8Array,
	modifications: PageModification[],
): Promise<{ bytes: Uint8Array; issues: ReturnType<typeof getIssuesFromDoc> }> {
	const { bytes: editableBytes } = await normalizePdfForEditing(bytes);
	const doc = await loadPdfForEditing(editableBytes);

	// Apply all modifications directly to the existing pages — no copies needed
	applyModifications(doc, modifications);

	const issues = getIssuesFromDoc(doc);
	const savedBytes = await doc.save({
		useObjectStreams: true,
		objectsPerTick: 100,
	});

	return { bytes: savedBytes, issues };
}

// ── Message handler ──

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
	const { type, modifications } = e.data;

	// Cache bytes on first transfer to avoid main-thread copy on every preview
	let bytes = e.data.bytes;
	if (bytes) {
		cachedBytes = bytes;
		cachedDoc = null; // invalidate parsed cache when new bytes arrive
	} else if (e.data.useCachedBytes && cachedBytes) {
		bytes = cachedBytes;
	}

	if (!bytes) {
		self.postMessage({
			type,
			ok: false,
			error: "No bytes available",
		});
		return;
	}

	try {
		if (type === "preview") {
			const pageIndex = e.data.pageIndex ?? 0;
			const fullDocumentPreview = e.data.fullDocumentPreview ?? false;
			const requestId = e.data.requestId;
			const previewBytes = await handlePreview(
				bytes,
				modifications,
				pageIndex,
				fullDocumentPreview,
			);
			self.postMessage(
				{ type: "preview", ok: true, bytes: previewBytes, requestId },
				{ transfer: [previewBytes.buffer as ArrayBuffer] },
			);
		} else {
			// Release cached doc before heavy save to free memory
			cachedDoc = null;
			cachedBytes = null;
			const result = await handleSave(bytes, modifications);
			// Transfer buffer to avoid blocking main thread during structured clone
			self.postMessage(
				{ type: "save", ok: true, bytes: result.bytes, issues: result.issues },
				{ transfer: [result.bytes.buffer as ArrayBuffer] },
			);
		}
	} catch (err) {
		self.postMessage({
			type,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
};
