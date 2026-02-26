import {
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFName,
	PDFNumber,
} from "pdf-lib";

const LOAD_OPTIONS = {
	updateMetadata: false,
	ignoreEncryption: true,
} as const;

const SAVE_OPTIONS = {
	useObjectStreams: true,
	objectsPerTick: 100,
} as const;

export async function loadPdfForEditing(bytes: Uint8Array): Promise<PDFDocument> {
	return PDFDocument.load(bytes, LOAD_OPTIONS);
}

function hasSignatureField(field: PDFDict, visited: Set<PDFDict>): boolean {
	if (visited.has(field)) return false;
	visited.add(field);

	const fieldType = field.lookupMaybe(PDFName.of("FT"), PDFName);
	if (fieldType?.asString() === "/Sig") return true;

	const value = field.lookupMaybe(PDFName.of("V"), PDFDict);
	if (value instanceof PDFDict) return true;

	const kids = field.lookupMaybe(PDFName.of("Kids"), PDFArray);
	if (!(kids instanceof PDFArray)) return false;

	for (let i = 0; i < kids.size(); i++) {
		const childField = kids.lookupMaybe(i, PDFDict);
		if (childField && hasSignatureField(childField, visited)) {
			return true;
		}
	}

	return false;
}

function hasSignatureData(doc: PDFDocument): boolean {
	const acroForm = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
	if (!(acroForm instanceof PDFDict)) return false;

	const sigFlags = acroForm.lookupMaybe(PDFName.of("SigFlags"), PDFNumber);
	if (sigFlags && sigFlags.asNumber() > 0) return true;

	const fields = acroForm.lookupMaybe(PDFName.of("Fields"), PDFArray);
	if (!(fields instanceof PDFArray)) return false;

	const visited = new Set<PDFDict>();
	for (let i = 0; i < fields.size(); i++) {
		const field = fields.lookupMaybe(i, PDFDict);
		if (field && hasSignatureField(field, visited)) return true;
	}

	return false;
}

function getBypassReasons(doc: PDFDocument): string[] {
	const reasons = new Set<string>();

	if (doc.isEncrypted) reasons.add("encryption");

	try {
		const perms = doc.catalog.lookupMaybe(PDFName.of("Perms"), PDFDict);
		if (perms instanceof PDFDict) reasons.add("certification");
	} catch {
		// Ignore malformed permission dictionaries.
	}

	try {
		if (hasSignatureData(doc)) reasons.add("signature");
	} catch {
		// Ignore malformed form/signature structures.
	}

	return [...reasons];
}

function stripSecurityEntries(doc: PDFDocument) {
	doc.catalog.delete(PDFName.of("Perms"));

	const acroForm = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
	if (acroForm instanceof PDFDict) {
		acroForm.delete(PDFName.of("SigFlags"));
	}

	doc.context.trailerInfo.Encrypt = undefined;
}

async function copyPagesIntoFreshDocument(sourceDoc: PDFDocument): Promise<Uint8Array> {
	const unlockedDoc = await PDFDocument.create();
	const copiedPages = await unlockedDoc.copyPages(
		sourceDoc,
		sourceDoc.getPageIndices(),
	);
	for (const page of copiedPages) {
		unlockedDoc.addPage(page);
	}
	return unlockedDoc.save(SAVE_OPTIONS);
}

export async function normalizePdfForEditing(bytes: Uint8Array): Promise<{
	bytes: Uint8Array;
	bypassApplied: boolean;
	reasons: string[];
}> {
	let sourceDoc: PDFDocument;
	try {
		sourceDoc = await loadPdfForEditing(bytes);
	} catch {
		// Leave bytes unchanged when the PDF parser cannot read this file reliably.
		return { bytes, bypassApplied: false, reasons: [] };
	}
	const reasons = getBypassReasons(sourceDoc);
	if (reasons.length === 0) {
		return { bytes, bypassApplied: false, reasons };
	}

	try {
		const unlockedBytes = await copyPagesIntoFreshDocument(sourceDoc);
		return { bytes: unlockedBytes, bypassApplied: true, reasons };
	} catch {
		// Some certified PDFs contain broken form/page refs; fallback to in-place rewrite.
	}

	try {
		stripSecurityEntries(sourceDoc);
		const rewrittenBytes = await sourceDoc.save(SAVE_OPTIONS);
		return { bytes: rewrittenBytes, bypassApplied: true, reasons };
	} catch {
		return { bytes, bypassApplied: false, reasons };
	}
}
