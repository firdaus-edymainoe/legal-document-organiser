import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
	PDFDocument,
	rgb,
	StandardFonts,
	PageSizes,
	degrees,
	PDFName,
	PDFArray,
	PDFNumber,
} from "pdf-lib";
import fontkit from '@pdf-lib/fontkit';
import { CarlitoBase64 } from './CarlitoFont';
import {
	FileUp,
	GripVertical,
	Trash2,
	FileText,
	Download,
	FilePlus,
	ArrowRight,
	ArrowLeft,
	Loader2,
	Eye,
	X,
	Copy,
	Check,
	AlertTriangle,
	RotateCw,
	RotateCcw,
	Maximize,
	Layers,
	Wrench,
	ScanLine,
	Image,
	Settings2,
	Sparkles,
} from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

import {
	DndContext,
	closestCenter,
	KeyboardSensor,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
	DragEndEvent,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
	loadPdfForEditing,
	normalizePdfForEditing,
	stripLogicalPageMetadata,
} from "./lib/pdf-security";
import { cn } from "./lib/utils";

interface PageHeaderProps {
	icon: React.ReactNode;
	title: string;
	subtitle?: string;
	showBackButton?: boolean;
	maxWidth?: string;
}

function PageHeader({
	icon,
	title,
	subtitle,
	showBackButton = false,
	maxWidth = "max-w-5xl",
}: PageHeaderProps) {
	const navigate = useNavigate();

	return (
		<header className="bg-white border-b border-slate-200 sticky top-0 z-20">
			<div className={cn("mx-auto px-6 py-4 flex items-center gap-3", maxWidth)}>
				{showBackButton ? (
					<button
						onClick={() => navigate("/")}
						className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors text-sm font-medium"
						title="Back to feature selection"
					>
						<ArrowLeft className="w-4 h-4" />
						Back
					</button>
				) : null}
				<div className="flex items-center gap-3">
					<div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-sm">
						{icon}
					</div>
					<div>
						<h1 className="text-xl font-semibold text-slate-900 tracking-tight">
							{title}
						</h1>
						{subtitle && (
							<p className="text-sm text-slate-500 font-medium">
								{subtitle}
							</p>
						)}
					</div>
				</div>
			</div>
		</header>
	);
}

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PageIssue {
	pageIndex: number;
	issueType: "size" | "orientation" | "both";
	description: string;
}

type ProcessingStage = "uploading" | "scanning" | "autofixing";

interface PdfFile {
	id: string;
	name: string;
	file: File;
	issues?: PageIssue[];
	originalIssues?: PageIssue[];
	savedAutoFixedIssues?: PageIssue[];
	pageCount: number;
	autoFixApplied?: boolean;
	autoFixDisabled?: boolean;
	autoFixSummary?: string;
	savedAutoFixSummary?: string;
	autoFixedPageFixTypes?: Record<number, ("rotation" | "scaling")[]>;
	savedAutoFixedPageFixTypes?: Record<number, ("rotation" | "scaling")[]>;
	imageOnly?: boolean;
	processingStage?: ProcessingStage;
	processingError?: string;
}

interface TabInfo {
	tabNumber: number;
	fileName: string;
	pageNumber: number;
}

type PageModification =
	| { type: "rotate"; pageIndices: number[]; angle: number }
	| { type: "fitToA4"; pageIndices: number[] }
	| { type: "setPageColor"; pageIndices: number[]; color: PageColor };

interface PageColor {
	red: number;
	green: number;
	blue: number;
}

const RIGHT_ANGLES = [0, 90, 180, 270] as const;
const TEXT_ORIENTATION_TOLERANCE_DEG = 20;
const UPSIDE_DOWN_MIN_CONFIDENCE_MARGIN_DEG = 8;
const IMAGE_ONLY_NOTICE =
	"Image-only PDF: protection was removed by rasterizing pages. Text is not selectable or highlightable.";
const PDF_POINTS_PER_INCH = 72;
const RASTER_TARGET_DPI = 300;
const RASTER_MAX_PIXELS = 20_000_000;
const PAGE_COLOR_RECENTS_STORAGE_KEY = "pdf-page-fixer-recent-page-colors";
const MAX_RECENT_PAGE_COLORS = 6;
const DEFAULT_PAGE_COLOR_HEX = "#ffffff";
const PRESET_PAGE_COLORS = [
	"#ffffff",
	"#fff7cc",
	"#dff1ff",
	"#e5f8df",
	"#fde2ec",
	"#f1f5f9",
];

interface EditablePdfPreparation {
	bytes: Uint8Array;
	imageOnly: boolean;
}

function getProcessingStageLabel(stage: ProcessingStage): string {
	switch (stage) {
		case "uploading":
			return "Uploading";
		case "scanning":
			return "Scanning issues";
		case "autofixing":
			return "Auto-fixing";
		default:
			return "Processing";
	}
}

function ImageOnlyBadge({ className }: { className?: string }) {
	return (
		<span className={cn("relative inline-flex group", className)}>
			<span
				tabIndex={0}
				className="flex items-center gap-1 text-xs font-medium text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full border border-rose-200 cursor-help focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
				aria-label="Image-only PDF details"
			>
				<AlertTriangle className="w-3 h-3" />
				Image-Only
			</span>
			<span
				role="tooltip"
				className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-64 max-w-[80vw] -translate-x-1/2 translate-y-1 rounded-md border border-rose-200 bg-white px-3 py-2 text-[11px] font-medium leading-snug text-rose-700 shadow-lg opacity-0 transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
			>
				{IMAGE_ONLY_NOTICE}
			</span>
		</span>
	);
}

function withImageOnlyNotice(
	summary: string | undefined,
	imageOnly: boolean,
): string | undefined {
	if (!imageOnly) return summary;
	if (summary?.includes(IMAGE_ONLY_NOTICE)) return summary;
	return `${summary ? `${summary} ` : ""}${IMAGE_ONLY_NOTICE}`;
}

function normalizeAngle(angle: number): number {
	const normalized = angle % 360;
	return normalized < 0 ? normalized + 360 : normalized;
}

function circularDistance(a: number, b: number): number {
	const diff = Math.abs(normalizeAngle(a) - normalizeAngle(b));
	return Math.min(diff, 360 - diff);
}

function snapToRightAngle(angle: number): number {
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of RIGHT_ANGLES) {
		const distance = circularDistance(angle, candidate);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = candidate;
		}
	}
	return best;
}

function chooseFinalPageRotationForPortrait(
	currentPageRotation: number,
	dominantTextAngle: number | null,
): number {
	if (dominantTextAngle === null) {
		return currentPageRotation;
	}

	const candidates = [0, 180].map((finalRotation) => {
		const delta = normalizeAngle(finalRotation - currentPageRotation);
		// pdf.js text item transforms are in page content space and don't include page /Rotate.
		// So final visible orientation is content angle + final page rotation.
		const finalTextAngle = normalizeAngle(dominantTextAngle + finalRotation);
		const bestAllowedDistance = circularDistance(finalTextAngle, 0);
		const turnCost = Math.min(delta, 360 - delta);
		return { finalRotation, bestAllowedDistance, turnCost };
	});

	candidates.sort((a, b) => {
		if (a.bestAllowedDistance !== b.bestAllowedDistance) {
			return a.bestAllowedDistance - b.bestAllowedDistance;
		}
		return a.turnCost - b.turnCost;
	});

	return candidates[0].finalRotation;
}

function getUpsideDownCorrectionFromAngle(
	dominantTextAngle: number | null,
	pageRotation: number,
): number {
	if (dominantTextAngle === null) return 0;

	const visibleTextAngle = normalizeAngle(dominantTextAngle + pageRotation);
	const allowedDistance = circularDistance(visibleTextAngle, 0);
	const upsideDistance = circularDistance(visibleTextAngle, 180);
	const confidenceMargin = allowedDistance - upsideDistance;

	if (
		upsideDistance <= TEXT_ORIENTATION_TOLERANCE_DEG &&
		confidenceMargin >= UPSIDE_DOWN_MIN_CONFIDENCE_MARGIN_DEG
	) {
		return 180;
	}
	return 0;
}

function buildPageFixTypesFromModifications(
	modifications: PageModification[],
): Record<number, ("rotation" | "scaling")[]> {
	const map = new Map<number, Set<"rotation" | "scaling">>();
	for (const modification of modifications) {
		if (modification.type === "setPageColor") continue;
		const fixType = modification.type === "rotate" ? "rotation" : "scaling";
		for (const pageIndex of modification.pageIndices) {
			const existing = map.get(pageIndex) ?? new Set<"rotation" | "scaling">();
			existing.add(fixType);
			map.set(pageIndex, existing);
		}
	}
	return Object.fromEntries(
		Array.from(map.entries()).map(([pageIndex, fixTypes]) => [
			pageIndex,
			Array.from(fixTypes),
		]),
	);
}

function normalizeHexColor(value: string): string | null {
	const trimmed = value.trim();
	const match = /^#?([0-9a-f]{6})$/i.exec(trimmed);
	return match ? `#${match[1].toLowerCase()}` : null;
}

function hexToPageColor(hex: string): PageColor {
	const normalized = normalizeHexColor(hex) ?? DEFAULT_PAGE_COLOR_HEX;
	const red = parseInt(normalized.slice(1, 3), 16) / 255;
	const green = parseInt(normalized.slice(3, 5), 16) / 255;
	const blue = parseInt(normalized.slice(5, 7), 16) / 255;
	return { red, green, blue };
}

function readRecentPageColors(): string[] {
	try {
		const raw = window.localStorage.getItem(PAGE_COLOR_RECENTS_STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((value) => (typeof value === "string" ? normalizeHexColor(value) : null))
			.filter((value): value is string => Boolean(value))
			.slice(0, MAX_RECENT_PAGE_COLORS);
	} catch {
		return [];
	}
}

function writeRecentPageColors(colors: string[]) {
	try {
		window.localStorage.setItem(
			PAGE_COLOR_RECENTS_STORAGE_KEY,
			JSON.stringify(colors.slice(0, MAX_RECENT_PAGE_COLORS)),
		);
	} catch {
		// Ignore unavailable storage.
	}
}

function addRecentPageColor(colors: string[], color: string): string[] {
	const normalized = normalizeHexColor(color);
	if (!normalized) return colors;
	const next = [
		normalized,
		...colors.filter((existing) => existing !== normalized),
	].slice(0, MAX_RECENT_PAGE_COLORS);
	writeRecentPageColors(next);
	return next;
}

function getOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

async function detectDominantTextAngles(pdfBytes: Uint8Array): Promise<(number | null)[]> {
	// pdf.js may transfer/detach the provided buffer when parsing in worker mode.
	// Clone first so callers can continue using the original bytes safely.
	const bytesForPdfJs = new Uint8Array(pdfBytes);
	const loadingTask = pdfjs.getDocument({ data: bytesForPdfJs });
	const pdf = await loadingTask.promise;

	try {
		const dominantAngles: (number | null)[] = [];

		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			const page = await pdf.getPage(pageNumber);
			const textContent = await page.getTextContent();
			const bins = new Map<number, number>(RIGHT_ANGLES.map((angle) => [angle, 0]));

			for (const item of textContent.items as any[]) {
				const text = typeof item?.str === "string" ? item.str.trim() : "";
				if (!text) continue;
				if (!Array.isArray(item?.transform) || item.transform.length < 2) {
					continue;
				}

				const angle = normalizeAngle(
					(Math.atan2(item.transform[1], item.transform[0]) * 180) /
					Math.PI,
				);
				const snapped = snapToRightAngle(angle);
				if (circularDistance(angle, snapped) > TEXT_ORIENTATION_TOLERANCE_DEG) {
					continue;
				}

				const weight = Math.max(1, text.length);
				bins.set(snapped, (bins.get(snapped) ?? 0) + weight);
			}

			let bestAngle: number | null = null;
			let bestScore = 0;
			for (const angle of RIGHT_ANGLES) {
				const score = bins.get(angle) ?? 0;
				if (score > bestScore) {
					bestScore = score;
					bestAngle = angle;
				}
			}
			dominantAngles.push(bestScore > 0 ? bestAngle : null);
		}

		return dominantAngles;
	} finally {
		await loadingTask.destroy();
	}
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					reject(new Error("Failed to encode canvas image"));
					return;
				}
				blob
					.arrayBuffer()
					.then((buffer) => resolve(new Uint8Array(buffer)))
					.catch(reject);
			},
			"image/png",
		);
	});
}

async function loadPdfJsWithPasswordPrompt(pdfBytes: Uint8Array): Promise<{
	loadingTask: any;
	pdf: any;
}> {
	let password: string | undefined;

	while (true) {
		const loadingTask = pdfjs.getDocument({
			data: new Uint8Array(pdfBytes),
			stopAtErrors: false,
			...(password !== undefined ? { password } : {}),
		});

		try {
			const pdf = await loadingTask.promise;
			return { loadingTask, pdf };
		} catch (error) {
			await loadingTask.destroy().catch(() => {});
			const name = (error as any)?.name;
			const message = String((error as any)?.message ?? "");
			const isPasswordError =
				name === "PasswordException" ||
				message.toLowerCase().includes("password");
			if (!isPasswordError) {
				throw error;
			}

			const nextPassword = window.prompt(
				password === undefined
					? "This PDF is password protected. Enter the password to continue."
					: "Incorrect password. Enter the PDF password to continue, or press Cancel to stop.",
				"",
			);
			if (nextPassword === null) {
				throw new Error("Password is required to open this PDF.");
			}
			password = nextPassword;
		}
	}
}

async function rasterizePdfToEditableA4(pdfBytes: Uint8Array): Promise<Uint8Array> {
	const { loadingTask, pdf } = await loadPdfJsWithPasswordPrompt(pdfBytes);

	try {
		const rebuiltDoc = await PDFDocument.create();
		const [A4_WIDTH, A4_HEIGHT] = PageSizes.A4;

		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			const page = await pdf.getPage(pageNumber);
			const baseViewport = page.getViewport({ scale: 1 });
			let renderScale = RASTER_TARGET_DPI / PDF_POINTS_PER_INCH;
			const estimatedPixels =
				baseViewport.width * baseViewport.height * renderScale * renderScale;
			if (estimatedPixels > RASTER_MAX_PIXELS) {
				renderScale = Math.sqrt(
					RASTER_MAX_PIXELS / Math.max(1, baseViewport.width * baseViewport.height),
				);
			}
			const viewport = page.getViewport({ scale: renderScale });
			const canvas = document.createElement("canvas");
			const context = canvas.getContext("2d", { alpha: false });
			if (!context) {
				throw new Error("Canvas 2D context is unavailable");
			}

			canvas.width = Math.max(1, Math.ceil(viewport.width));
			canvas.height = Math.max(1, Math.ceil(viewport.height));
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, canvas.width, canvas.height);

			await page.render({
				canvas,
				canvasContext: context,
				viewport,
			}).promise;

			const imageBytes = await canvasToPngBytes(canvas);
			const image = await rebuiltDoc.embedPng(imageBytes);
			const outputPage = rebuiltDoc.addPage([A4_WIDTH, A4_HEIGHT]);

			const scale = Math.min(A4_WIDTH / image.width, A4_HEIGHT / image.height);
			const width = image.width * scale;
			const height = image.height * scale;
			outputPage.drawImage(image, {
				x: (A4_WIDTH - width) / 2,
				y: (A4_HEIGHT - height) / 2,
				width,
				height,
			});

			page.cleanup();
			canvas.width = 0;
			canvas.height = 0;
		}

		return rebuiltDoc.save({
			useObjectStreams: true,
			objectsPerTick: 100,
		});
	} finally {
		await loadingTask.destroy();
	}
}

async function canReadAllPages(bytes: Uint8Array): Promise<boolean> {
	try {
		const doc = await loadPdfForEditing(bytes);
		const pageCount = doc.getPageCount();
		for (let i = 0; i < pageCount; i++) {
			const page = doc.getPage(i);
			page.getSize();
			page.getRotation();
		}
		return true;
	} catch {
		return false;
	}
}

async function prepareEditablePdfBytes(
	pdfBytes: Uint8Array,
): Promise<EditablePdfPreparation> {
	const normalized = await normalizePdfForEditing(pdfBytes);
	const canReadNormalized = await canReadAllPages(normalized.bytes);

	if (!normalized.bypassApplied && canReadNormalized) {
		return {
			bytes: normalized.bytes,
			imageOnly: false,
		};
	}

	const rasterizedBytes = await rasterizePdfToEditableA4(pdfBytes);
	return {
		bytes: rasterizedBytes,
		imageOnly: true,
	};
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

function getIssuesFromDoc(doc: PDFDocument): PageIssue[] {
	const [A4_WIDTH, A4_HEIGHT] = PageSizes.A4;
	const issues: PageIssue[] = [];
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
				const parts = [];

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

function getBeforePreviewDisplayRotation(
	width: number,
	height: number,
	pageRotation: number,
	dominantTextAngle: number | null,
): number {
	if (dominantTextAngle === null) return 0;

	const effectiveWidth = pageRotation % 180 === 0 ? width : height;
	const effectiveHeight = pageRotation % 180 === 0 ? height : width;
	const isPortraitPage = effectiveHeight >= effectiveWidth;
	if (!isPortraitPage) return 0;

	const visibleTextAngle = normalizeAngle(dominantTextAngle + pageRotation);
	if (visibleTextAngle === 90) return 270;
	if (visibleTextAngle === 270) return 90;
	return 0;
}

const PREVIEW_DEBOUNCE_MS = 120;

interface PageEditorModalProps {
	file: PdfFile;
	fileBytes: Uint8Array;
	originalFileBytes: Uint8Array;
	onClose: () => void;
	onSave: (file: PdfFile, newBytes: Uint8Array) => void;
}

function PageEditorModal({
	file,
	fileBytes,
	originalFileBytes,
	onClose,
	onSave,
}: PageEditorModalProps) {
	type CompareView = "before" | "after" | "split";

	const availablePageIndices = Array.from(
		{ length: file.pageCount },
		(_, i) => i,
	);

	const [selectedPageIndex, setSelectedPageIndex] = useState<number>(
		availablePageIndices[0] ?? 0,
	);
	const [beforePreviewUrl, setBeforePreviewUrl] = useState<string | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [compareView, setCompareView] = useState<CompareView>("after");
	const [isSaving, setIsSaving] = useState(false);
	const [isPreviewLoading, setIsPreviewLoading] = useState(true);
	const [modifications, setModifications] = useState<PageModification[]>([]);
	const [beforeDisplayRotations, setBeforeDisplayRotations] = useState<number[]>(
		[],
	);
	const [autoFixEnabled, setAutoFixEnabled] = useState(!file.autoFixDisabled);
	const [selectedPageIndices, setSelectedPageIndices] = useState<number[]>([]);
	const [pageColorHex, setPageColorHex] = useState(DEFAULT_PAGE_COLOR_HEX);
	const [recentPageColors, setRecentPageColors] = useState<string[]>(() =>
		readRecentPageColors(),
	);
	const splitPageRenderWidth = 420;
	const pageRenderWidth = compareView === "split" ? splitPageRenderWidth : 560;
	const renderedPageWidth =
		compareView === "split"
			? pageRenderWidth
			: Math.min(window.innerWidth * 0.3, pageRenderWidth);
	const editorSourceBytes = autoFixEnabled ? fileBytes : originalFileBytes;
	const selectedPageIndexSet = useMemo(
		() => new Set(selectedPageIndices),
		[selectedPageIndices],
	);
	const targetPageIndices = useMemo(
		() => (
			selectedPageIndices.length > 0
				? selectedPageIndices
				: [selectedPageIndex]
		),
		[selectedPageIndices, selectedPageIndex],
	);
	const colorSwatches = useMemo(
		() => Array.from(new Set([...PRESET_PAGE_COLORS, ...recentPageColors])),
		[recentPageColors],
	);

	const workerRef = useRef<Worker | null>(null);
	const previewRequestIdRef = useRef(0);
	const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const previewUrlRef = useRef<string | null>(null);
	const previewScrollRef = useRef<HTMLDivElement | null>(null);
	const pendingPreviewScrollTopRef = useRef<number | null>(null);
	const previewScrollRestoreIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
		null,
	);
	const previewScrollRestoreUntilRef = useRef(0);

	previewUrlRef.current = previewUrl;

	useEffect(() => {
		const url = URL.createObjectURL(
			new Blob([getOwnedArrayBuffer(originalFileBytes)], { type: "application/pdf" }),
		);
		setBeforePreviewUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [originalFileBytes]);

	useEffect(() => {
		let cancelled = false;

		void (async () => {
			const textAngles = await detectDominantTextAngles(originalFileBytes);
			const doc = await loadPdfForEditing(originalFileBytes);
			const pages = doc.getPages();
			const rotations = pages.map((page, index) => {
				const { width, height } = page.getSize();
				const pageRotation = normalizeAngle(page.getRotation().angle);
				const additionalRotation = getBeforePreviewDisplayRotation(
					width,
					height,
					pageRotation,
					textAngles[index] ?? null,
				);
				return normalizeAngle(pageRotation + additionalRotation);
			});
			return { rotations };
		})()
			.then(({ rotations }) => {
				if (!cancelled) {
					setBeforeDisplayRotations(rotations);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setBeforeDisplayRotations([]);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [originalFileBytes]);

	useEffect(() => {
		workerRef.current = new Worker(
			new URL("./pdf-save.worker.ts", import.meta.url),
			{ type: "module" },
		);
		return () => {
			workerRef.current?.terminate();
			workerRef.current = null;
			if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
			if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
			if (previewScrollRestoreIntervalRef.current) {
				clearInterval(previewScrollRestoreIntervalRef.current);
				previewScrollRestoreIntervalRef.current = null;
			}
		};
	}, []);

	const hasTransferredBytesRef = useRef(false);

	useEffect(() => {
		hasTransferredBytesRef.current = false;
	}, [editorSourceBytes]);

	const requestPreview = useCallback(() => {
		const worker = workerRef.current;
		if (!worker) return;

		const requestId = ++previewRequestIdRef.current;

		if (hasTransferredBytesRef.current) {
			worker.postMessage({
				type: "preview",
				useCachedBytes: true,
				modifications,
				fullDocumentPreview: true,
				requestId,
			});
		} else {
			hasTransferredBytesRef.current = true;
			const bytesCopy = new Uint8Array(editorSourceBytes);
			worker.postMessage(
				{
					type: "preview",
					bytes: bytesCopy,
					modifications,
					fullDocumentPreview: true,
					requestId,
				},
				[bytesCopy.buffer],
			);
		}
	}, [editorSourceBytes, modifications]);

	useEffect(() => {
		if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);

		if (previewScrollRef.current) {
			pendingPreviewScrollTopRef.current = previewScrollRef.current.scrollTop;
		}
		setIsPreviewLoading(true);
		previewTimeoutRef.current = setTimeout(() => {
			previewTimeoutRef.current = null;
			requestPreview();
		}, PREVIEW_DEBOUNCE_MS);

		return () => {
			if (previewTimeoutRef.current) {
				clearTimeout(previewTimeoutRef.current);
			}
		};
	}, [modifications, requestPreview]);

	useEffect(() => {
		const worker = workerRef.current;
		if (!worker) return;

		const handleMessage = (e: MessageEvent) => {
			const { type, ok, requestId } = e.data;
			if (!ok) {
				setIsPreviewLoading(false);
				return;
			}
			if (type === "preview") {
				if (requestId !== previewRequestIdRef.current) return;
				const previewBytes =
					e.data.bytes instanceof Uint8Array
						? e.data.bytes
						: new Uint8Array(e.data.bytes);
				const url = URL.createObjectURL(
					new Blob([getOwnedArrayBuffer(previewBytes)], { type: "application/pdf" }),
				);
				setPreviewUrl((prev) => {
					if (prev) URL.revokeObjectURL(prev);
					return url;
				});
				setIsPreviewLoading(false);
			}
		};

		worker.addEventListener("message", handleMessage);
		return () => worker.removeEventListener("message", handleMessage);
	}, []);

	useEffect(() => {
		const targetScrollTop = pendingPreviewScrollTopRef.current;
		if (targetScrollTop === null || !previewUrl) return;

		previewScrollRestoreUntilRef.current = Date.now() + 4000;
		let stableRestores = 0;
		const restore = () => {
			const node = previewScrollRef.current;
			if (!node) return;
			node.scrollTop = targetScrollTop;
			const reachedTarget = Math.abs(node.scrollTop - targetScrollTop) <= 2;
			if (reachedTarget) {
				stableRestores += 1;
			} else {
				stableRestores = 0;
			}
			if (stableRestores >= 3 || Date.now() >= previewScrollRestoreUntilRef.current) {
				pendingPreviewScrollTopRef.current = null;
				if (previewScrollRestoreIntervalRef.current) {
					clearInterval(previewScrollRestoreIntervalRef.current);
					previewScrollRestoreIntervalRef.current = null;
				}
			}
		};

		restore();
		if (previewScrollRestoreIntervalRef.current) {
			clearInterval(previewScrollRestoreIntervalRef.current);
		}
		previewScrollRestoreIntervalRef.current = setInterval(restore, 80);

		return () => {
			if (previewScrollRestoreIntervalRef.current) {
				clearInterval(previewScrollRestoreIntervalRef.current);
				previewScrollRestoreIntervalRef.current = null;
			}
		};
	}, [previewUrl, compareView]);

	const pageFixTypes = useMemo(() => {
		const perPage = new Map<number, { rotation: boolean; scaling: boolean; color: boolean }>();
		const ensure = (pageIndex: number) => {
			let existing = perPage.get(pageIndex);
			if (!existing) {
				existing = { rotation: false, scaling: false, color: false };
				perPage.set(pageIndex, existing);
			}
			return existing;
		};

		for (const [rawPageIndex, fixTypes] of Object.entries(
			file.autoFixedPageFixTypes ?? {},
		)) {
			const pageIndex = Number(rawPageIndex);
			if (!Number.isInteger(pageIndex)) continue;
			const pageFix = ensure(pageIndex);
			for (const fixType of fixTypes) {
				if (fixType === "rotation") pageFix.rotation = true;
				if (fixType === "scaling") pageFix.scaling = true;
			}
		}

		for (const modification of modifications) {
			for (const pageIndex of modification.pageIndices) {
				const pageFix = ensure(pageIndex);
				if (modification.type === "rotate") pageFix.rotation = true;
				if (modification.type === "fitToA4") pageFix.scaling = true;
				if (modification.type === "setPageColor") pageFix.color = true;
			}
		}

		return perPage;
	}, [file.autoFixedPageFixTypes, modifications]);

	const togglePageSelection = useCallback((pageIndex: number) => {
		setSelectedPageIndices((previous) => {
			if (previous.includes(pageIndex)) {
				return previous.filter((index) => index !== pageIndex);
			}
			return [...previous, pageIndex].sort((a, b) => a - b);
		});
	}, []);

	const selectAllPages = useCallback(() => {
		setSelectedPageIndices(Array.from({ length: file.pageCount }, (_, i) => i));
	}, [file.pageCount]);

	const clearSelectedPages = useCallback(() => {
		setSelectedPageIndices([]);
	}, []);

	const applyRotate = useCallback((angle: number) => {
		setModifications((prev) => [
			...prev,
			{ type: "rotate", pageIndices: targetPageIndices, angle },
		]);
	}, [targetPageIndices]);

	const applyModifications = useCallback((modType: "fitToA4") => {
		setModifications((prev) => [
			...prev,
			{ type: modType, pageIndices: targetPageIndices },
		]);
	}, [targetPageIndices]);

	const applyPageColor = useCallback((hex: string) => {
		const normalized = normalizeHexColor(hex);
		if (!normalized) return;
		setPageColorHex(normalized);
		setRecentPageColors((previous) => addRecentPageColor(previous, normalized));
		setModifications((prev) => [
			...prev,
			{
				type: "setPageColor",
				pageIndices: targetPageIndices,
				color: hexToPageColor(normalized),
			},
		]);
	}, [targetPageIndices]);

	const handleRasterize = useCallback(async () => {
		setIsSaving(true);
		const worker = workerRef.current;
		if (!worker) return;
		try {
			const modifiedBytes = await new Promise<Uint8Array>((resolve, reject) => {
				const handleMsg = (e: MessageEvent) => {
					if (e.data.type === "save") {
						worker.removeEventListener("message", handleMsg);
						if (e.data.ok && e.data.bytes) {
							resolve(
								e.data.bytes instanceof Uint8Array
									? e.data.bytes
									: new Uint8Array(e.data.bytes),
							);
						} else {
							reject(new Error(e.data.error ?? "Failed to prepare bytes for rasterization"));
						}
					}
				};
				worker.addEventListener("message", handleMsg);
				worker.onerror = (evt) => {
					worker.removeEventListener("message", handleMsg);
					reject(new Error(evt.message));
				};
				if (hasTransferredBytesRef.current) {
					worker.postMessage({ type: "save", useCachedBytes: true, modifications });
				} else {
					const bytesCopy = new Uint8Array(editorSourceBytes);
					worker.postMessage(
						{ type: "save", bytes: bytesCopy, modifications },
						[bytesCopy.buffer],
					);
				}
			});

			const rasterizedBytes = await rasterizePdfToEditableA4(modifiedBytes);

			const rasterizedDoc = await loadPdfForEditing(rasterizedBytes);
			const rasterizedIssues = getIssuesFromDoc(rasterizedDoc);

			onSave(
				{
					...file,
					imageOnly: true,
					issues: rasterizedIssues.length > 0 ? rasterizedIssues : undefined,
					autoFixSummary: withImageOnlyNotice(file.autoFixSummary, true),
					savedAutoFixSummary: withImageOnlyNotice(file.savedAutoFixSummary, true),
				},
				rasterizedBytes,
			);
		} catch (error) {
			console.error("Error rasterizing:", error);
			alert("Failed to rasterize the document. The file may be too large or corrupted.");
		} finally {
			setIsSaving(false);
		}
	}, [editorSourceBytes, file, modifications, onSave]);

	const handleSave = useCallback(async () => {
		setIsSaving(true);
		const worker = workerRef.current;
		if (!worker) return;

		try {
			const result = await new Promise<{
				type: string;
				ok: boolean;
				bytes?: Uint8Array;
				issues?: PageIssue[];
				error?: string;
			}>((resolve, reject) => {
				const handleSaveResponse = (e: MessageEvent) => {
					if (e.data.type === "save") {
						worker.removeEventListener("message", handleSaveResponse);
						resolve(e.data);
					}
				};
				worker.addEventListener("message", handleSaveResponse);
				worker.onerror = (e) => {
					worker.removeEventListener("message", handleSaveResponse);
					reject(new Error(e.message));
				};
				if (hasTransferredBytesRef.current) {
					worker.postMessage({
						type: "save",
						useCachedBytes: true,
						modifications,
					});
				} else {
					const bytesCopy = new Uint8Array(editorSourceBytes);
					worker.postMessage(
						{ type: "save", bytes: bytesCopy, modifications },
						[bytesCopy.buffer],
					);
				}
			});

			if (!result.ok || !result.bytes) {
				throw new Error(result.error ?? "Save failed");
			}
			const manualFixedPageFixTypes = buildPageFixTypesFromModifications(modifications);

			onSave(
				{
					...file,
					autoFixDisabled: !autoFixEnabled,
					autoFixApplied: autoFixEnabled && modifications.length > 0,
					autoFixedPageFixTypes: autoFixEnabled
						? manualFixedPageFixTypes
						: undefined,
					issues: (result.issues?.length ?? 0) > 0 ? result.issues : undefined,
				},
				result.bytes,
			);
		} catch (error) {
			console.error("Error saving PDF:", error);
			alert(
				"Failed to save. The document may be too large. Try again or use a smaller file.",
			);
		} finally {
			setIsSaving(false);
		}
	}, [autoFixEnabled, editorSourceBytes, file, modifications, onSave, originalFileBytes]);
	const navigatorPreviewUrl = compareView === "before" ? beforePreviewUrl : previewUrl;

	return (
		<div className="fixed inset-0 z-50 flex bg-slate-200/70 backdrop-blur-[1px]">
			<div className="flex-1 bg-white flex flex-col">
				<div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-white">
					<div className="flex items-center gap-4">
						<h3 className="font-semibold text-slate-900 flex items-center gap-2">
							<FileText className="w-5 h-5 text-slate-500" />
							<span className="truncate max-w-md">{file.name}</span>
						</h3>
						<span className="text-sm text-slate-500">
							{file.pageCount} {file.pageCount === 1 ? 'page' : 'pages'}
						</span>
					</div>

					<div className="flex items-center gap-2">
						<div className="inline-flex items-center rounded-lg bg-slate-100 p-1 border border-slate-200">
							<button
								type="button"
								onClick={() => setCompareView("before")}
								className={cn(
									"px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
									compareView === "before"
										? "bg-indigo-600 text-white"
										: "text-slate-600 hover:text-slate-900",
								)}
							>
								Before
							</button>
							<button
								type="button"
								onClick={() => setCompareView("after")}
								className={cn(
									"px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
									compareView === "after"
										? "bg-indigo-600 text-white"
										: "text-slate-600 hover:text-slate-900",
								)}
							>
								After
							</button>
							<button
								type="button"
								onClick={() => setCompareView("split")}
								className={cn(
									"px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
									compareView === "split"
										? "bg-indigo-600 text-white"
										: "text-slate-600 hover:text-slate-900",
								)}
							>
								Split
							</button>
						</div>

						<button
							onClick={onClose}
							className="ml-4 p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
						>
							<X className="w-5 h-5" />
						</button>
					</div>
				</div>

				<div className="flex-1 overflow-hidden flex bg-slate-100">
					<div className="w-64 border-r border-slate-200 bg-white overflow-y-auto px-3 py-4">
						<div className="mb-3 flex items-center justify-between px-2">
							<p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
								Pages
							</p>
							<span className="text-[11px] font-medium text-slate-500">
								{selectedPageIndices.length} selected
							</span>
						</div>
						<div className="mb-3 grid grid-cols-2 gap-2 px-2">
							<button
								type="button"
								onClick={selectAllPages}
								className="rounded-md border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
							>
								Select all
							</button>
							<button
								type="button"
								onClick={clearSelectedPages}
								className="rounded-md border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
							>
								Clear
							</button>
						</div>
						{navigatorPreviewUrl ? (
							<Document
								key={navigatorPreviewUrl}
								file={navigatorPreviewUrl}
								className="flex flex-col gap-3 pb-4"
								loading={
									<div className="px-2 py-6 flex justify-center">
										<Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
									</div>
								}
							>
								{Array.from(new Array(file.pageCount), (_el, index) => {
									const pageFix = pageFixTypes.get(index);
									const hasFix = Boolean(pageFix?.rotation || pageFix?.scaling || pageFix?.color);
									const isPageSelected = selectedPageIndexSet.has(index);
									const navigatorRotation =
										compareView === "before"
											? beforeDisplayRotations[index]
											: undefined;
									return (
										<button
											key={`nav_page_${index + 1}`}
											type="button"
											onClick={() => setSelectedPageIndex(index)}
											className={cn(
												"w-full text-left rounded-lg border p-2 transition-all",
												selectedPageIndex === index
													? "border-indigo-400 bg-indigo-50 shadow-sm"
													: isPageSelected
														? "border-indigo-300 bg-indigo-50/60"
														: "border-slate-200 bg-white hover:border-indigo-300 hover:bg-slate-50",
											)}
										>
											<div className="mb-2 flex items-center justify-between">
												<label
													className="flex items-center gap-2 text-xs font-medium text-slate-700"
													onClick={(event) => event.stopPropagation()}
												>
													<input
														type="checkbox"
														checked={isPageSelected}
														onChange={() => togglePageSelection(index)}
														className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
													/>
													Page {index + 1}
												</label>
												{hasFix && (
													<span className="text-[10px] font-semibold text-indigo-700 bg-indigo-100 px-1.5 py-0.5 rounded">
														Edited
													</span>
												)}
											</div>
											<div className="overflow-hidden rounded border border-slate-200 bg-slate-50">
												<Page
													pageNumber={index + 1}
													renderTextLayer={false}
													renderAnnotationLayer={false}
													width={150}
													rotate={navigatorRotation}
												/>
											</div>
										</button>
									);
								})}
							</Document>
						) : (
							<div className="px-2 py-6 flex justify-center">
								<Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
							</div>
						)}
					</div>
					<div
						ref={previewScrollRef}
						className="relative flex-1 overflow-auto p-8 flex items-start justify-center"
					>
						{!previewUrl || !beforePreviewUrl ? (
							<div className="h-full flex items-center justify-center">
								<Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
							</div>
						) : (
							<div
								className={cn(
									"gap-8 items-start justify-center",
									compareView === "split"
										? "grid grid-cols-2 min-w-[920px]"
										: "grid grid-cols-1",
								)}
								style={
									compareView === "split"
										? { gridTemplateColumns: "minmax(440px, 1fr) minmax(440px, 1fr)" }
										: undefined
								}
							>
								<div className={cn("min-w-0", compareView === "after" ? "hidden" : "block")}>
									<h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4">
										Before
									</h4>
									<Document
										file={beforePreviewUrl}
										className="flex flex-col items-center gap-6 py-2"
										loading={null}
										error={
											<div className="flex flex-col items-center justify-center h-64 text-red-400 p-4 text-center">
												<AlertTriangle className="w-8 h-8 mb-2" />
												<p>Failed to load preview.</p>
											</div>
										}
									>
										{Array.from(new Array(file.pageCount), (_el, index) => (
											<div
												key={`before_editor_page_${index + 1}`}
												onClick={() => setSelectedPageIndex(index)}
												className={cn(
													"relative shadow-xl bg-white border-2 cursor-pointer transition-all",
													selectedPageIndex === index
														? "border-indigo-500 ring-4 ring-indigo-500/20"
														: "border-transparent hover:border-indigo-400/50",
												)}
											>
												<span className="absolute -top-6 left-0 text-xs text-slate-500 font-medium">
													Page {index + 1}
												</span>
												<Page
													pageNumber={index + 1}
													renderTextLayer={false}
													renderAnnotationLayer={false}
													width={renderedPageWidth}
													rotate={beforeDisplayRotations[index]}
												/>
											</div>
										))}
									</Document>
								</div>

								<div className={cn("min-w-0", compareView === "before" ? "hidden" : "block")}>
									<h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4">
										After
									</h4>
									<Document
										file={previewUrl}
										className="flex flex-col items-center gap-6 py-2"
										loading={null}
										error={
											<div className="flex flex-col items-center justify-center h-64 text-red-400 p-4 text-center">
												<AlertTriangle className="w-8 h-8 mb-2" />
												<p>Failed to load preview.</p>
											</div>
										}
									>
										{Array.from(new Array(file.pageCount), (_el, index) => (
											<div
												key={`after_editor_page_${index + 1}`}
												onClick={() => setSelectedPageIndex(index)}
												className={cn(
													"relative shadow-xl bg-white border-2 cursor-pointer transition-all",
													selectedPageIndex === index
														? "border-indigo-500 ring-4 ring-indigo-500/20"
														: "border-transparent hover:border-indigo-400/50",
												)}
											>
												<span className="absolute -top-6 left-0 text-xs text-slate-500 font-medium">
													Page {index + 1}
												</span>
												<Page
													pageNumber={index + 1}
													renderTextLayer={false}
													renderAnnotationLayer={false}
													width={renderedPageWidth}
												/>
											</div>
										))}
									</Document>
								</div>
							</div>
						)}
						{isPreviewLoading && previewUrl && beforePreviewUrl && (
							<div className="pointer-events-none absolute top-4 right-4 rounded-md bg-white/90 border border-slate-200 px-2 py-1 shadow-sm">
								<Loader2 className="w-4 h-4 animate-spin text-indigo-500" />
							</div>
						)}
					</div>
				</div>

				<div className="px-6 py-4 border-t border-slate-200 bg-white flex justify-end gap-3">
					<button
						onClick={onClose}
						className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
					>
						Cancel
					</button>
					<button
						onClick={handleSave}
						disabled={isSaving}
						className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors flex items-center gap-2"
					>
						{isSaving ? (
							<Loader2 className="w-4 h-4 animate-spin" />
						) : (
							<Check className="w-4 h-4" />
						)}
						Save Changes
					</button>
				</div>
			</div>

			<div className="w-80 bg-white border-l border-slate-200 flex flex-col overflow-hidden">
				<div className="p-4 border-b border-slate-100">
					<h3 className="text-sm font-semibold text-slate-900 mb-1">
						Settings
					</h3>
					<p className="text-xs text-slate-500">
						{selectedPageIndices.length > 0
							? `${selectedPageIndices.length} page${selectedPageIndices.length === 1 ? "" : "s"} selected`
							: `Page ${selectedPageIndex + 1} active`}
					</p>
				</div>

				<div className="flex-1 overflow-auto p-4 space-y-4">
					<div className="space-y-3">
						<h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
							Auto-Fix
						</h4>
						<label className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
							<div className="flex items-center gap-2">
								<Sparkles className="w-4 h-4 text-slate-500" />
								<span className="text-sm font-medium text-slate-700">Enable</span>
							</div>
							<button
								onClick={() => setAutoFixEnabled(!autoFixEnabled)}
								className={cn(
									"relative w-10 h-6 rounded-full transition-colors",
									autoFixEnabled ? "bg-indigo-600" : "bg-slate-300",
								)}
							>
								<div
									className={cn(
										"absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform",
										autoFixEnabled ? "translate-x-5" : "translate-x-1",
									)}
								/>
							</button>
						</label>
						<p className="text-xs text-slate-500 px-1">
							When enabled, auto-fix will apply rotation and scaling to all pages.
						</p>
					</div>

					<div className="h-px bg-slate-200" />

					<div className="space-y-3">
						<h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
							Manual Fixes
						</h4>

						<div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
							<div className="flex items-center gap-2">
								<Layers className="w-4 h-4 text-slate-500" />
								<span className="text-sm font-medium text-slate-700">Target</span>
							</div>
							<span className="text-xs font-semibold text-slate-600">
								{selectedPageIndices.length > 0
									? `${selectedPageIndices.length} selected`
									: `Page ${selectedPageIndex + 1}`}
							</span>
						</div>
						<p className="text-xs text-slate-500 px-1">
							Use the page checkboxes for batch edits; with none selected, edits apply to the active page.
						</p>

						<div className="space-y-2">
							<p className="text-xs text-slate-500 font-medium">Rotate (90° increments)</p>
							<div className="grid grid-cols-2 gap-2">
								<button
									onClick={() => applyRotate(-90)}
									className="p-3 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors flex flex-col items-center gap-1"
								>
									<RotateCcw className="w-5 h-5" />
									<span className="text-xs font-medium">90° Left</span>
								</button>
								<button
									onClick={() => applyRotate(90)}
									className="p-3 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors flex flex-col items-center gap-1"
								>
									<RotateCw className="w-5 h-5" />
									<span className="text-xs font-medium">90° Right</span>
								</button>
							</div>
						</div>

						<div className="space-y-2">
							<p className="text-xs text-slate-500 font-medium">Scale</p>
							<button
								onClick={() => applyModifications("fitToA4")}
								className="w-full p-3 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors flex items-center justify-center gap-2"
							>
								<Maximize className="w-4 h-4" />
								<span className="text-sm font-medium">Fit to A4</span>
							</button>
						</div>

						<div className="space-y-2">
							<p className="text-xs text-slate-500 font-medium">Page Colour</p>
							<div className="grid grid-cols-6 gap-2">
								{colorSwatches.map((color) => (
									<button
										key={color}
										type="button"
										onClick={() => applyPageColor(color)}
										className={cn(
											"h-8 rounded-md border transition-all",
											pageColorHex === color
												? "border-indigo-500 ring-2 ring-indigo-500/20"
												: "border-slate-300 hover:border-indigo-400",
										)}
										style={{ backgroundColor: color }}
										title={`Apply ${color}`}
										aria-label={`Apply page colour ${color}`}
									/>
								))}
							</div>
							<div className="flex items-center gap-2">
								<label className="flex h-10 w-12 cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white p-1 hover:border-indigo-300">
									<input
										type="color"
										value={pageColorHex}
										onChange={(event) => setPageColorHex(event.target.value)}
										onBlur={(event) => applyPageColor(event.target.value)}
										className="h-full w-full cursor-pointer border-0 bg-transparent p-0"
										aria-label="Choose custom page colour"
									/>
								</label>
								<button
									type="button"
									onClick={() => applyPageColor(pageColorHex)}
									className="flex-1 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200"
								>
									Apply custom
								</button>
								<button
									type="button"
									onClick={() => applyPageColor(DEFAULT_PAGE_COLOR_HEX)}
									className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
								>
									Reset
								</button>
							</div>
						</div>
					</div>

					<div className="h-px bg-slate-200" />

					<div className="space-y-3">
						<h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
							Advanced
						</h4>

						<button
							onClick={handleRasterize}
							disabled={isSaving}
							className="w-full p-3 rounded-lg text-sm font-medium bg-rose-50 text-rose-600 hover:bg-rose-100 transition-colors flex items-center justify-center gap-2"
						>
							{isSaving ? (
								<Loader2 className="w-4 h-4 animate-spin" />
							) : (
								<Image className="w-4 h-4" />
							)}
							Rasterize to Image
						</button>
						<p className="text-xs text-slate-500 px-1">
							Converts this page to an image. Useful for protected PDFs.
						</p>
					</div>
				</div>

				{file.issues && file.issues.length > 0 && (
					<div className="p-4 border-t border-slate-100 bg-amber-50">
						<div className="flex items-center gap-2 mb-2">
							<AlertTriangle className="w-4 h-4 text-amber-500" />
							<span className="text-xs font-semibold text-amber-700">
								{file.issues.length} Issue{file.issues.length > 1 ? 's' : ''} Found
							</span>
						</div>
						<div className="space-y-1">
							{file.issues.slice(0, 3).map((issue, i) => (
								<p key={i} className="text-xs text-amber-600">
									Page {issue.pageIndex + 1}: {issue.description}
								</p>
							))}
							{file.issues.length > 3 && (
								<p className="text-xs text-amber-500">
									+{file.issues.length - 3} more...
								</p>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function SortableItem({
	file,
	onRemove,
	onEdit,
	onDownload,
}: {
	file: PdfFile;
	onRemove: (id: string) => void;
	onEdit: (file: PdfFile) => void;
	onDownload?: (file: PdfFile) => void;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: file.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};
	const isProcessing = Boolean(file.processingStage);
	const statusPill = isProcessing
		? {
			label: getProcessingStageLabel(file.processingStage!),
			className: "bg-slate-100 text-slate-600",
		}
		: file.issues && file.issues.length > 0
			? { label: "Needs review", className: "bg-amber-100 text-amber-700" }
			: file.autoFixDisabled
				? { label: "Auto-fix off", className: "bg-slate-100 text-slate-600" }
				: file.autoFixApplied
					? { label: "Auto-fixed", className: "bg-emerald-100 text-emerald-700" }
					: { label: "Ready", className: "bg-indigo-100 text-indigo-700" };

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"group flex items-center gap-3 px-4 py-3 bg-white border-b border-slate-100 transition-all",
				isDragging
					? "opacity-50 bg-indigo-50 z-10 relative shadow-lg"
					: "hover:bg-slate-50",
			)}
		>
			<button
				{...attributes}
				{...listeners}
				disabled={isProcessing}
				className={cn(
					"p-1 rounded transition-colors touch-none",
					isProcessing
						? "text-slate-300 cursor-not-allowed"
						: "text-slate-400 hover:text-slate-600 cursor-grab active:cursor-grabbing hover:bg-slate-100",
				)}
			>
				<GripVertical className="w-4 h-4" />
			</button>

			<button
				onClick={() => !isProcessing && onEdit(file)}
				disabled={isProcessing}
				className={cn(
					"flex-1 flex items-center gap-3 text-left",
					isProcessing ? "cursor-not-allowed" : "cursor-pointer",
				)}
			>
				<div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-indigo-50">
					<FileText className="w-4 h-4 text-indigo-500" />
				</div>

				<div className="flex-1 min-w-0">
					<p className={cn(
						"text-sm font-medium truncate",
						isProcessing ? "text-slate-400" : "text-slate-700"
					)}>
						{file.name}
					</p>
					<div className="flex items-center gap-2 mt-0.5">
						<span className="text-xs text-slate-400">
							{file.pageCount} {file.pageCount === 1 ? 'page' : 'pages'}
						</span>
						<span
							className={cn(
								"inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
								statusPill.className,
							)}
						>
							{statusPill.label}
						</span>
						{file.imageOnly && (
							<span className="flex items-center gap-1 text-xs text-rose-500">
								<Image className="w-3 h-3" />
								Image-only
							</span>
						)}
					</div>
				</div>
			</button>

			<div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
				{onDownload && !isProcessing && (
					<button
						onClick={() => onDownload(file)}
						className="p-2 text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 rounded-lg transition-colors"
						title="Download"
					>
						<Download className="w-4 h-4" />
					</button>
				)}
				<button
					onClick={() => onRemove(file.id)}
					disabled={isProcessing}
					className={cn(
						"p-2 rounded-lg transition-colors",
						isProcessing
							? "text-slate-300 cursor-not-allowed"
							: "text-slate-400 hover:text-red-500 hover:bg-red-50",
					)}
					title="Remove"
				>
					<Trash2 className="w-4 h-4" />
				</button>
			</div>
		</div>
	);
}

function PdfPreviewModal({
	url,
	title,
	onClose,
}: {
	url: string;
	title: string;
	onClose: () => void;
}) {
	const [numPages, setNumPages] = useState<number>(0);

	function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
		setNumPages(numPages);
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 sm:p-6">
			<div className="bg-white w-full h-full max-w-6xl rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
				<div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
					<h3 className="font-semibold text-slate-700 flex items-center gap-2 truncate max-w-md">
						<FileText className="w-4 h-4 text-indigo-500 flex-shrink-0" />
						<span className="truncate">{title}</span>
					</h3>

					<div className="flex items-center gap-4">
						{numPages > 0 && (
							<span className="text-xs font-medium text-slate-500 bg-white px-2 py-1 rounded-md border border-slate-200 tabular-nums">
								{numPages} {numPages === 1 ? 'page' : 'pages'}
							</span>
						)}

						<button
							onClick={onClose}
							className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
						>
							<X className="w-5 h-5" />
						</button>
					</div>
				</div>

				<div className="flex-1 bg-slate-100 overflow-auto flex flex-col items-center p-4">
					<Document
						file={url}
						onLoadSuccess={onDocumentLoadSuccess}
						className="flex flex-col items-center gap-6 py-4"
						loading={
							<div className="flex flex-col items-center justify-center h-64">
								<Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-2" />
								<p className="text-sm text-slate-500">
									Loading PDF...
								</p>
							</div>
						}
						error={
							<div className="flex flex-col items-center justify-center h-64 text-red-500">
								<p>Failed to load PDF.</p>
							</div>
						}
					>
						{Array.from(new Array(numPages), (_el, index) => (
							<div key={`page_${index + 1}`} className="shadow-lg relative group">
								<div className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
									Page {index + 1}
								</div>
								<Page
									pageNumber={index + 1}
									renderTextLayer={false}
									renderAnnotationLayer={false}
									className="bg-white"
									width={Math.min(
										window.innerWidth * 0.8,
										800,
									)}
								/>
							</div>
						))}
					</Document>
				</div>
			</div>
		</div>
	);
}

function createPdfObjectUrl(bytes: Uint8Array): string {
	return URL.createObjectURL(
		new Blob([getOwnedArrayBuffer(bytes)], { type: "application/pdf" }),
	);
}

function triggerPdfDownload(bytes: Uint8Array, filename: string): void {
	const url = createPdfObjectUrl(bytes);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BundleOfAuthoritiesPage() {
	const [coverFile, setCoverFile] = useState<PdfFile | null>(null);
	const [individualFiles, setIndividualFiles] = useState<PdfFile[]>([]);
	const bytesStoreRef = useRef<Map<string, Uint8Array>>(new Map());
	const originalBytesStoreRef = useRef<Map<string, Uint8Array>>(new Map());
	const autoFixedBytesStoreRef = useRef<Map<string, Uint8Array>>(new Map());
	const generatedPdfBytesRef = useRef<Uint8Array | null>(null);
	const coverUploadRequestIdRef = useRef(0);
	const [isGenerating, setIsGenerating] = useState(false);
	const [hasGeneratedPdf, setHasGeneratedPdf] = useState(false);
	const [tabInfo, setTabInfo] = useState<TabInfo[]>([]);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [previewTitle, setPreviewTitle] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [addTabPages, setAddTabPages] = useState(true);
	const [autoFixEnabled, setAutoFixEnabled] = useState(true);

	const [isCoverDragging, setIsCoverDragging] = useState(false);
	const [isFilesDragging, setIsFilesDragging] = useState(false);

	const sensors = useSensors(
		useSensor(MouseSensor, {
			activationConstraint: {
				distance: 8,
			},
		}),
		useSensor(TouchSensor, {
			activationConstraint: {
				delay: 200,
				tolerance: 5,
			},
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const [editingFile, setEditingFile] = useState<PdfFile | null>(null);
	const [editingOriginalBytes, setEditingOriginalBytes] =
		useState<Uint8Array | null>(null);
	const editRequestIdRef = useRef(0);
	const hasPendingUploads = Boolean(coverFile?.processingStage) ||
		individualFiles.some((file) => Boolean(file.processingStage));

	useEffect(() => {
		return () => {
			if (previewUrl) {
				URL.revokeObjectURL(previewUrl);
			}
		};
	}, [previewUrl]);

	const autoFixPdf = async (
		pdfBytes: Uint8Array,
	): Promise<{
		bytes: Uint8Array;
		issues: PageIssue[];
		pageCount: number;
		autoFixApplied: boolean;
		autoFixSummary?: string;
		autoFixedPageFixTypes: Record<number, ("rotation" | "scaling")[]>;
	}> => {
		const buildRasterizedFallbackResult = async () => {
			const rasterizedBytes = await rasterizePdfToEditableA4(pdfBytes);
			const rasterizedDoc = await loadPdfForEditing(rasterizedBytes);
			const pageCount = rasterizedDoc.getPageCount();
			const autoFixedPageFixTypes = Object.fromEntries(
				Array.from({ length: pageCount }, (_, pageIndex) => [
					pageIndex,
					["scaling"] as ("rotation" | "scaling")[],
				]),
			);
			return {
				bytes: rasterizedBytes,
				issues: getIssuesFromDoc(rasterizedDoc),
				pageCount,
				autoFixApplied: true,
				autoFixSummary: `${pageCount}/${pageCount} pages rasterized and normalized to A4 to bypass PDF protection. ${IMAGE_ONLY_NOTICE}`,
				autoFixedPageFixTypes,
			};
		};

		try {
			const srcDoc = await loadPdfForEditing(pdfBytes);
			const [A4_WIDTH, A4_HEIGHT] = PageSizes.A4;
			const pageCount = srcDoc.getPageCount();
			let malformedPageEncountered = false;
			let textAngles: (number | null)[] = [];
			try {
				textAngles = await detectDominantTextAngles(pdfBytes);
			} catch {
				textAngles = Array.from({ length: pageCount }, () => null);
			}
			const autoFixedPageFixes = new Map<
				number,
				{ rotation: boolean; scaling: boolean }
			>();
			const markFix = (
				pageIndex: number,
				type: "rotation" | "scaling",
			) => {
				const existing = autoFixedPageFixes.get(pageIndex) ?? {
					rotation: false,
					scaling: false,
				};
				existing[type] = true;
				autoFixedPageFixes.set(pageIndex, existing);
			};
			let rotatedPages = 0;

			for (let i = 0; i < pageCount; i++) {
				try {
					const page = srcDoc.getPage(i);
					const { width, height } = page.getSize();
					const currentRotation = normalizeAngle(page.getRotation().angle);
					const detectedTextAngle = textAngles[i] ?? null;
					const nextRotation = chooseFinalPageRotationForPortrait(
						currentRotation,
						detectedTextAngle,
					);
					page.setRotation(degrees(nextRotation));
					if (nextRotation !== currentRotation) rotatedPages++;

					const targetW = A4_WIDTH;
					const targetH = A4_HEIGHT;
					const scale = Math.min(targetW / width, targetH / height);
					const scaledWidth = width * scale;
					const scaledHeight = height * scale;
					const dx = (targetW - scaledWidth) / 2;
					const dy = (targetH - scaledHeight) / 2;

					page.setSize(targetW, targetH);
					page.scaleContent(scale, scale);
					page.translateContent(dx, dy);
					scaleAndTranslatePageAnnotations(page, scale, dx, dy);

					if (
						nextRotation !== currentRotation ||
						Math.abs(width - targetW) > 0.5 ||
						Math.abs(height - targetH) > 0.5
					) {
						if (nextRotation !== currentRotation) {
							markFix(i, "rotation");
						}
						if (
							Math.abs(width - targetW) > 0.5 ||
							Math.abs(height - targetH) > 0.5
						) {
							markFix(i, "scaling");
						}
					}
				} catch {
					malformedPageEncountered = true;
				}
			}

			const firstPassBytes = await srcDoc.save({
				useObjectStreams: true,
				objectsPerTick: 100,
			});

			const finalAngles = await detectDominantTextAngles(firstPassBytes);
			const firstPassDoc = await loadPdfForEditing(firstPassBytes);
			const firstPassRotations = firstPassDoc
				.getPages()
				.map((page) => normalizeAngle(page.getRotation().angle));
			const upsideDownPages: number[] = [];
			for (let i = 0; i < finalAngles.length; i++) {
				if (
					getUpsideDownCorrectionFromAngle(
						finalAngles[i],
						firstPassRotations[i] ?? 0,
					) === 180
				) {
					upsideDownPages.push(i);
				}
			}

			let finalBytes = firstPassBytes;
			if (upsideDownPages.length > 0) {
				const correctedDoc = await loadPdfForEditing(firstPassBytes);
				for (const pageIndex of upsideDownPages) {
					const page = correctedDoc.getPage(pageIndex);
					const rotation = normalizeAngle(page.getRotation().angle);
					page.setRotation(degrees(rotation + 180));
					markFix(pageIndex, "rotation");
				}
				finalBytes = await correctedDoc.save({
					useObjectStreams: true,
					objectsPerTick: 100,
				});
				rotatedPages += upsideDownPages.length;
			}

			const finalDocForIssues = await loadPdfForEditing(finalBytes);
			const remainingIssues = getIssuesFromDoc(finalDocForIssues);
			const changedPages = autoFixedPageFixes.size;
			const autoFixApplied = changedPages > 0;
			const autoFixSummary = autoFixApplied
				? `${changedPages}/${pageCount} pages normalized to A4; ${rotatedPages} page(s) auto-rotated using text orientation detection.`
				: undefined;
			const autoFixedPageFixTypes = Object.fromEntries(
				Array.from(autoFixedPageFixes.entries()).map(([pageIndex, fix]) => [
					pageIndex,
					[
						...(fix.rotation ? (["rotation"] as const) : []),
						...(fix.scaling ? (["scaling"] as const) : []),
					],
				]),
			);

			return {
				bytes: finalBytes,
				issues: remainingIssues,
				pageCount,
				autoFixApplied,
				autoFixSummary,
				autoFixedPageFixTypes,
			};
		} catch (error) {
			console.error("Error auto-fixing PDF:", error);
			try {
				return await buildRasterizedFallbackResult();
			} catch (rasterError) {
				console.error("Raster fallback failed:", rasterError);
				const srcDocFallback = await loadPdfForEditing(pdfBytes);
				return {
					bytes: pdfBytes,
					issues: getIssuesFromDoc(srcDocFallback),
					pageCount: srcDocFallback.getPageCount(),
					autoFixApplied: false,
					autoFixSummary: undefined,
					autoFixedPageFixTypes: {},
				};
			}
		}
	};

	const processCoverFile = async (file: File) => {
		if (file.type === "application/pdf") {
			const requestId = ++coverUploadRequestIdRef.current;
			const coverId = crypto.randomUUID();
			if (coverFile) {
				bytesStoreRef.current.delete(coverFile.id);
				originalBytesStoreRef.current.delete(coverFile.id);
				autoFixedBytesStoreRef.current.delete(coverFile.id);
			}
			setCoverFile({
				id: coverId,
				name: file.name,
				file,
				pageCount: 0,
				processingStage: "uploading",
			});

			try {
				const rawBytes = new Uint8Array(await file.arrayBuffer());
				if (requestId !== coverUploadRequestIdRef.current) return;
				setCoverFile((prev) =>
					prev && prev.id === coverId
						? { ...prev, processingStage: "scanning" }
						: prev,
				);
				const prepared = await prepareEditablePdfBytes(rawBytes);
				const editableBytes = prepared.bytes;
				const originalDoc = await loadPdfForEditing(editableBytes);
				const originalIssues = getIssuesFromDoc(originalDoc);
				if (requestId !== coverUploadRequestIdRef.current) return;
				setCoverFile((prev) =>
					prev && prev.id === coverId
						? {
							...prev,
							processingStage: "autofixing",
							imageOnly: prepared.imageOnly,
						}
						: prev,
				);
				let finalBytes: Uint8Array;
				let issues: PageIssue[];
				let pageCount: number;
				let autoFixApplied: boolean;
				let autoFixSummary: string | undefined;
				let autoFixedPageFixTypes: Record<number, ("rotation" | "scaling")[]>;

				if (autoFixEnabled) {
					const result = await autoFixPdf(editableBytes);
					finalBytes = result.bytes;
					issues = result.issues;
					pageCount = result.pageCount;
					autoFixApplied = result.autoFixApplied;
					autoFixSummary = result.autoFixSummary;
					autoFixedPageFixTypes = result.autoFixedPageFixTypes;
				} else {
					const editableDoc = await loadPdfForEditing(editableBytes);
					finalBytes = editableBytes;
					issues = getIssuesFromDoc(editableDoc);
					pageCount = editableDoc.getPageCount();
					autoFixApplied = false;
					autoFixSummary = undefined;
					autoFixedPageFixTypes = {};
				}
				if (requestId !== coverUploadRequestIdRef.current) return;

				bytesStoreRef.current.set(coverId, finalBytes);
				originalBytesStoreRef.current.set(coverId, editableBytes);
				autoFixedBytesStoreRef.current.set(
					coverId,
					autoFixEnabled ? finalBytes : editableBytes,
				);
				setCoverFile({
					id: coverId,
					name: file.name,
					file,
					pageCount,
					originalIssues: originalIssues.length > 0 ? originalIssues : undefined,
					savedAutoFixedIssues:
						autoFixEnabled && issues.length > 0 ? issues : undefined,
					issues: issues.length > 0 ? issues : undefined,
					autoFixApplied,
					autoFixSummary: withImageOnlyNotice(
						autoFixSummary,
						prepared.imageOnly,
					),
					savedAutoFixSummary: autoFixEnabled
						? withImageOnlyNotice(autoFixSummary, prepared.imageOnly)
						: undefined,
					autoFixedPageFixTypes,
					savedAutoFixedPageFixTypes: autoFixEnabled ? autoFixedPageFixTypes : undefined,
					imageOnly: prepared.imageOnly,
					processingStage: undefined,
				});
			} catch (error) {
				if (requestId !== coverUploadRequestIdRef.current) return;
				console.error("Failed to auto-fix cover PDF:", error);
				autoFixedBytesStoreRef.current.delete(coverId);
				setCoverFile(null);
				alert(
					error instanceof Error && error.message
						? `Unable to auto-fix "${file.name}": ${error.message}`
						: `Unable to auto-fix "${file.name}". The file may be severely corrupted or unsupported.`,
				);
			}
		}
	};

	const handleCoverUpload = async (
		e: React.ChangeEvent<HTMLInputElement>,
	) => {
		const file = e.target.files?.[0];
		if (file) {
			await processCoverFile(file);
		}
	};

	const handleCoverDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		setIsCoverDragging(true);
	};

	const handleCoverDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		setIsCoverDragging(false);
	};

	const handleCoverDrop = async (e: React.DragEvent) => {
		e.preventDefault();
		setIsCoverDragging(false);
		const file = e.dataTransfer.files?.[0];
		if (file) {
			await processCoverFile(file);
		}
	};

	const processIndividualFiles = async (files: File[]) => {
		const pdfFiles = files.filter((f) => f.type === "application/pdf");
		if (pdfFiles.length === 0) return;

		const optimisticFiles: PdfFile[] = pdfFiles.map((file) => ({
			id: crypto.randomUUID(),
			name: file.name,
			file,
			pageCount: 0,
			processingStage: "uploading",
		}));
		setIndividualFiles((prev) => [...prev, ...optimisticFiles]);

		for (const optimisticFile of optimisticFiles) {
			const { id, file } = optimisticFile;
			try {
				const rawBytes = new Uint8Array(await file.arrayBuffer());
				setIndividualFiles((prev) =>
					prev.map((existingFile) =>
						existingFile.id === id
							? { ...existingFile, processingStage: "scanning" }
							: existingFile,
					),
				);
				const prepared = await prepareEditablePdfBytes(rawBytes);
				const editableBytes = prepared.bytes;
				const originalDoc = await loadPdfForEditing(editableBytes);
				const originalIssues = getIssuesFromDoc(originalDoc);
				setIndividualFiles((prev) =>
					prev.map((existingFile) =>
						existingFile.id === id
							? {
								...existingFile,
								processingStage: "autofixing",
								imageOnly: prepared.imageOnly,
							}
							: existingFile,
					),
				);
				const {
					bytes: finalBytes,
					issues,
					pageCount,
					autoFixApplied,
					autoFixSummary,
					autoFixedPageFixTypes,
				} = await autoFixPdf(editableBytes);

				bytesStoreRef.current.set(id, finalBytes);
				originalBytesStoreRef.current.set(id, editableBytes);
				autoFixedBytesStoreRef.current.set(id, finalBytes);
				setIndividualFiles((prev) =>
					prev.map((existingFile) =>
						existingFile.id === id
							? {
								...existingFile,
								pageCount,
								originalIssues:
									originalIssues.length > 0 ? originalIssues : undefined,
								savedAutoFixedIssues:
									issues.length > 0 ? issues : undefined,
								issues: issues.length > 0 ? issues : undefined,
								autoFixApplied,
								autoFixSummary: withImageOnlyNotice(
									autoFixSummary,
									prepared.imageOnly,
								),
								savedAutoFixSummary: withImageOnlyNotice(
									autoFixSummary,
									prepared.imageOnly,
								),
								autoFixedPageFixTypes,
								savedAutoFixedPageFixTypes: autoFixedPageFixTypes,
								imageOnly: prepared.imageOnly,
								processingStage: undefined,
							}
							: existingFile,
					),
				);
			} catch (error) {
				console.error(`Failed to auto-fix PDF ${file.name}:`, error);
				bytesStoreRef.current.delete(id);
				originalBytesStoreRef.current.delete(id);
				autoFixedBytesStoreRef.current.delete(id);
				setIndividualFiles((prev) =>
					prev.filter((existingFile) => existingFile.id !== id),
				);
				alert(
					error instanceof Error && error.message
						? `Unable to auto-fix "${file.name}": ${error.message}`
						: `Unable to auto-fix "${file.name}". The file may be severely corrupted or unsupported.`,
				);
			}
		}
	};

	const handleIndividualFilesUpload = async (
		e: React.ChangeEvent<HTMLInputElement>,
	) => {
		const files = Array.from<File>(e.target.files || []);
		await processIndividualFiles(files);
	};

	const handleFilesDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		setIsFilesDragging(true);
	};

	const handleFilesDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		setIsFilesDragging(false);
	};

	const handleFilesDrop = async (e: React.DragEvent) => {
		e.preventDefault();
		setIsFilesDragging(false);
		const files = Array.from<File>(e.dataTransfer.files || []);
		await processIndividualFiles(files);
	};

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;

		if (over && active.id !== over.id) {
			setIndividualFiles((items) => {
				const oldIndex = items.findIndex(
					(item) => item.id === active.id,
				);
				const newIndex = items.findIndex((item) => item.id === over.id);
				return arrayMove(items, oldIndex, newIndex);
			});
		}
	};

	const handlePreview = (file: PdfFile) => {
		const bytes = bytesStoreRef.current.get(file.id);
		if (!bytes) return;
		setPreviewUrl((current) => {
			if (current) URL.revokeObjectURL(current);
			return createPdfObjectUrl(bytes);
		});
		setPreviewTitle(file.name);
	};

	const handleGeneratedPreview = () => {
		const bytes = generatedPdfBytesRef.current;
		if (!bytes) return;
		setPreviewUrl((current) => {
			if (current) URL.revokeObjectURL(current);
			return createPdfObjectUrl(bytes);
		});
		setPreviewTitle("Bundle_of_Authorities.pdf");
	};

	const handleGeneratedDownload = () => {
		const bytes = generatedPdfBytesRef.current;
		if (!bytes) return;
		triggerPdfDownload(bytes, "Bundle_of_Authorities.pdf");
	};

	const handleEdit = (file: PdfFile) => {
		setEditingFile(file);
		setEditingOriginalBytes(null);
		const requestId = ++editRequestIdRef.current;

		const existingOriginalBytes = originalBytesStoreRef.current.get(file.id);
		if (existingOriginalBytes) {
			setEditingOriginalBytes(existingOriginalBytes);
			return;
		}

		void (async () => {
			try {
				const rawBytes = new Uint8Array(await file.file.arrayBuffer());
				const prepared = await prepareEditablePdfBytes(rawBytes);
				const editableBytes = prepared.bytes;
				originalBytesStoreRef.current.set(file.id, editableBytes);
				if (requestId !== editRequestIdRef.current) return;
				setEditingOriginalBytes(editableBytes);
			} catch (error) {
				console.error("Failed to load original bytes for edit preview:", error);
				const fallbackBytes = bytesStoreRef.current.get(file.id) ?? null;
				if (requestId !== editRequestIdRef.current) return;
				setEditingOriginalBytes(fallbackBytes);
			}
		})();
	};

	const handleSaveEdit = (updatedFile: PdfFile, newBytes: Uint8Array) => {
		// Store updated bytes in ref (outside React state) to avoid GC pressure
		bytesStoreRef.current.set(updatedFile.id, newBytes);

		const finalFile = {
			...updatedFile,
			issues: updatedFile.issues,
		};

		if (!updatedFile.autoFixDisabled) {
			autoFixedBytesStoreRef.current.set(updatedFile.id, newBytes);
			finalFile.savedAutoFixedIssues = updatedFile.issues;
			finalFile.savedAutoFixSummary = updatedFile.autoFixSummary;
			finalFile.savedAutoFixedPageFixTypes = updatedFile.autoFixedPageFixTypes;
		}

		if (coverFile && coverFile.id === updatedFile.id) {
			setCoverFile(finalFile);
		} else {
			setIndividualFiles((prev) =>
				prev.map((f) => (f.id === updatedFile.id ? finalFile : f)),
			);
		}
		setEditingFile(null);
		setEditingOriginalBytes(null);
	};

	const copyPageNumbers = () => {
		const pageNumbers = tabInfo.map((info) => info.pageNumber).join("\n");
		navigator.clipboard.writeText(pageNumbers);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const removeIndividualFile = (id: string) => {
		bytesStoreRef.current.delete(id);
		originalBytesStoreRef.current.delete(id);
		autoFixedBytesStoreRef.current.delete(id);
		setIndividualFiles((prev) => prev.filter((f) => f.id !== id));
	};

	const toggleFileAutoFix = (file: PdfFile) => {
		const isDisabling = !file.autoFixDisabled;
		if (isDisabling) {
			const originalBytes = originalBytesStoreRef.current.get(file.id);
			if (!originalBytes) return;
			bytesStoreRef.current.set(file.id, originalBytes);
		} else {
			const autoFixedBytes = autoFixedBytesStoreRef.current.get(file.id);
			if (!autoFixedBytes) return;
			bytesStoreRef.current.set(file.id, autoFixedBytes);
		}

		const applyToggle = (currentFile: PdfFile): PdfFile =>
			isDisabling
				? {
					...currentFile,
					issues: currentFile.originalIssues,
					autoFixApplied: false,
					autoFixDisabled: true,
					autoFixSummary: undefined,
					autoFixedPageFixTypes: undefined,
				}
				: {
					...currentFile,
					issues: currentFile.savedAutoFixedIssues,
					autoFixApplied: true,
					autoFixDisabled: false,
					autoFixSummary: currentFile.savedAutoFixSummary,
					autoFixedPageFixTypes: currentFile.savedAutoFixedPageFixTypes,
				};

		if (coverFile?.id === file.id) {
			setCoverFile((prev) => (prev ? applyToggle(prev) : prev));
			return;
		}

		setIndividualFiles((prev) =>
			prev.map((currentFile) =>
				currentFile.id === file.id ? applyToggle(currentFile) : currentFile,
			),
		);
	};

	const generateSubmission = async () => {
		if (individualFiles.length === 0) return;

		setIsGenerating(true);
		generatedPdfBytesRef.current = null;
		setHasGeneratedPdf(false);
		try {
			const mergedPdf = await PDFDocument.create();
			const font = await mergedPdf.embedFont(StandardFonts.HelveticaBold);
			const regularFont = await mergedPdf.embedFont(
				StandardFonts.Helvetica,
			);

			let currentPageNumber = 1;
			const newTabInfo: TabInfo[] = [];

			// 1. Append Cover & Index
			if (coverFile) {
				const coverBytes = bytesStoreRef.current.get(coverFile.id);
				if (!coverBytes) throw new Error("Cover file bytes not found");
				const coverDoc = await loadPdfForEditing(coverBytes);
				const copiedPages = await mergedPdf.copyPages(
					coverDoc,
					coverDoc.getPageIndices(),
				);
				copiedPages.forEach((page) => {
					mergedPdf.addPage(page);
					currentPageNumber++;
				});
			}

			// 2. Append Individual Files with TAB-x
			for (let i = 0; i < individualFiles.length; i++) {
				const tabNumber = i + 1;
				const file = individualFiles[i];

				newTabInfo.push({
					tabNumber,
					fileName: file.name,
					pageNumber: currentPageNumber,
				});

				// Add TAB-x page
				if (addTabPages) {
					const tabPage = mergedPdf.addPage([595.28, 841.89]); // A4 size
					const { width, height } = tabPage.getSize();
					const text = `TAB-${tabNumber}`;
					const fontSize = 48;
					const textWidth = font.widthOfTextAtSize(text, fontSize);
					const textHeight = font.heightAtSize(fontSize);

					tabPage.drawText(text, {
						x: width / 2 - textWidth / 2,
						y: height / 2 - textHeight / 4, // Adjust for baseline
						size: fontSize,
						font: font,
						color: rgb(0, 0, 0),
					});
					currentPageNumber++;
				}

				// Append individual file pages
				const fileBytes = bytesStoreRef.current.get(file.id);
				if (!fileBytes) throw new Error(`File bytes not found for ${file.name}`);
				const fileDoc = await loadPdfForEditing(fileBytes);
				const copiedPages = await mergedPdf.copyPages(
					fileDoc,
					fileDoc.getPageIndices(),
				);
				copiedPages.forEach((page) => {
					mergedPdf.addPage(page);
					currentPageNumber++;
				});
			}

			// 3. Add page numbers to top right corner
			const pages = mergedPdf.getPages();
			for (let i = 0; i < pages.length; i++) {
				const page = pages[i];
				const { width, height } = page.getSize();
				const text = `${i + 1}`;
				const fontSize = 30;
				const textWidth = regularFont.widthOfTextAtSize(text, fontSize);

				page.drawText(text, {
					x: width - textWidth - 30,
					y: height - 30 - 10,
					size: fontSize,
					font: regularFont,
					color: rgb(0, 0, 0),
				});
			}

			stripLogicalPageMetadata(mergedPdf);
			const mergedPdfBytes = await mergedPdf.save();
			generatedPdfBytesRef.current = mergedPdfBytes;
			setHasGeneratedPdf(true);
			setTabInfo(newTabInfo);
		} catch (error) {
			console.error("Error generating PDF:", error);
			alert(
				"An error occurred while generating the PDF. Please check the console for details.",
			);
		} finally {
			setIsGenerating(false);
		}
	};

	return (
		<div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900 pb-24">
			<PageHeader
				icon={<FileText className="w-5 h-5 text-white" />}
				title="Bundle of Authorities"
				subtitle="Compile cover/index, TAB pages, and merged bundle output"
				showBackButton
			/>

			<main className="max-w-5xl mx-auto px-6 py-10 grid grid-cols-1 lg:grid-cols-12 gap-10">
				<div className="lg:col-span-7 space-y-8">
					{/* Section 1: Cover & Index */}
					<section className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
						<div className="flex items-center gap-3 mb-4">
							<div className="w-8 h-8 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-sm">
								1
							</div>
							<h2 className="text-lg font-semibold">
								Cover & Index (Optional)
							</h2>
						</div>
						<p className="text-slate-500 text-sm mb-6">
							Upload your combined cover page and index document.
							This will be placed at the very beginning. Pages are auto-fixed to A4 and portrait on upload.
						</p>

						<label
							className={cn(
								"flex flex-col items-center justify-center w-full h-44 border-2 border-dashed rounded-xl cursor-pointer transition-colors",
								isCoverDragging
									? "border-indigo-500 bg-indigo-100"
									: coverFile
										? "border-indigo-300 bg-indigo-50/50"
										: "border-slate-300 bg-slate-50 hover:bg-slate-100 hover:border-slate-400",
							)}
							onDragOver={handleCoverDragOver}
							onDragLeave={handleCoverDragLeave}
							onDrop={handleCoverDrop}
						>
							<div className="flex flex-col items-center justify-center px-4 text-center">
								{coverFile ? (
									<>
										<div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center mb-3">
											{coverFile.processingStage ? (
												<Loader2 className="w-5 h-5 text-slate-400 animate-spin" />
											) : coverFile.issues && coverFile.issues.length > 0 ? (
												<AlertTriangle className="w-5 h-5 text-amber-500" />
											) : coverFile.autoFixApplied ? (
												<Sparkles className="w-5 h-5 text-emerald-500" />
											) : (
												<FileText className="w-5 h-5 text-indigo-500" />
											)}
										</div>
										<p className="text-sm font-medium text-slate-700">
											{coverFile.name}
										</p>
										<div className="flex items-center gap-3 mt-2">
											<span className="text-xs text-slate-400">
												{coverFile.processingStage 
													? getProcessingStageLabel(coverFile.processingStage)
													: `${coverFile.pageCount} pages`
												}
											</span>
											{coverFile.autoFixDisabled && !coverFile.processingStage && (
												<span className="text-xs text-slate-400">Auto-fix off</span>
											)}
										</div>
										<p className="text-xs text-indigo-500 mt-2">
											Click to edit settings
										</p>
									</>
								) : (
									<>
										<FileUp className={cn("w-8 h-8 mb-2", isCoverDragging ? "text-indigo-500" : "text-slate-400")} />
									<p className={cn("text-sm font-medium", isCoverDragging ? "text-indigo-700" : "text-slate-700")}>
										Click to upload or drag and drop PDF
									</p>
									<p className="text-xs text-slate-500 mt-1">
										Single PDF file
									</p>
								</>
								)}
							</div>
							<input
								type="file"
								className="hidden"
								accept="application/pdf"
								onChange={handleCoverUpload}
							/>
						</label>
						{coverFile && !coverFile.processingStage && (
							<div className="mt-3 flex gap-2">
								<button
									onClick={() => handleEdit(coverFile)}
									className="flex-1 px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors"
								>
									Edit Settings
								</button>
								<button
									onClick={() => handlePreview(coverFile)}
									className="px-4 py-2 text-sm font-medium text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
								>
									Preview
								</button>
								<button
									onClick={() => {
										bytesStoreRef.current.delete(coverFile.id);
										originalBytesStoreRef.current.delete(coverFile.id);
										autoFixedBytesStoreRef.current.delete(coverFile.id);
										setCoverFile(null);
									}}
									className="px-4 py-2 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors"
								>
									Remove
								</button>
							</div>
						)}
					</section>

					{/* Section 2: Individual Files */}
					<section className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
						<div className="flex items-center gap-3 mb-4">
							<div className="w-8 h-8 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-sm">
								2
							</div>
							<h2 className="text-lg font-semibold">
								Individual Documents
							</h2>
						</div>
						<p className="text-slate-500 text-sm mb-6">
							Upload the documents to be appended. A "TAB-x" page
							will be inserted before each document automatically.
							Drag to reorder. Uploads are auto-fixed (A4 + portrait/text orientation checks).
						</p>

						<label
							className={cn(
								"flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-colors mb-6",
								isFilesDragging
									? "border-indigo-500 bg-indigo-100"
									: "border-slate-300 bg-slate-50 hover:bg-slate-100 hover:border-slate-400"
							)}
							onDragOver={handleFilesDragOver}
							onDragLeave={handleFilesDragLeave}
							onDrop={handleFilesDrop}
						>
							<div className="flex flex-col items-center justify-center pt-5 pb-6">
								<FilePlus className={cn("w-8 h-8 mb-2", isFilesDragging ? "text-indigo-500" : "text-slate-400")} />
								<p className={cn("text-sm font-medium", isFilesDragging ? "text-indigo-700" : "text-slate-700")}>
									Click to upload or drag and drop multiple PDFs
								</p>
								<p className="text-xs text-slate-500 mt-1">
									You can select multiple files at once
								</p>
							</div>
							<input
								type="file"
								className="hidden"
								accept="application/pdf"
								multiple
								onChange={handleIndividualFilesUpload}
							/>
						</label>

						{individualFiles.length > 0 && (
							<div className="space-y-3">
								<DndContext
									sensors={sensors}
									collisionDetection={closestCenter}
									onDragEnd={handleDragEnd}
								>
									<SortableContext
										items={individualFiles.map((f) => f.id)}
										strategy={verticalListSortingStrategy}
									>
										{individualFiles.map((file, index) => (
											<div
												key={file.id}
												className="relative"
											>
												<div className="absolute -left-3 top-1/2 -translate-y-1/2 w-6 text-right text-xs font-bold text-slate-400">
													{index + 1}
												</div>
												<SortableItem
													file={file}
													onRemove={
														removeIndividualFile
													}
													onEdit={handleEdit}
												/>
											</div>
										))}
									</SortableContext>
								</DndContext>
							</div>
						)}

						{individualFiles.length === 0 && (
							<div className="text-center py-8 text-slate-400 text-sm border border-dashed border-slate-200 rounded-xl">
								No documents added yet.
							</div>
						)}
					</section>
				</div>

				<div className="lg:col-span-5 space-y-6">
					{/* Action Panel */}
					<div className="bg-slate-900 rounded-2xl p-6 text-white shadow-xl relative">
						<h3 className="text-lg font-semibold mb-2">
							Ready to compile?
						</h3>
						<p className="text-slate-400 text-sm mb-4">
							This will merge all documents and add page numbers
							to the top right corner.
						</p>

						<label className="flex items-center gap-3 cursor-pointer mb-6">
							<div
								className={cn(
									"relative w-11 h-6 rounded-full transition-colors",
									addTabPages ? "bg-indigo-500" : "bg-slate-600",
								)}
								onClick={() => setAddTabPages(!addTabPages)}
							>
								<div
									className={cn(
										"absolute top-1 w-4 h-4 bg-white rounded-full transition-transform",
										addTabPages
											? "translate-x-6"
											: "translate-x-1",
									)}
								/>
							</div>
							<span className="text-sm font-medium">
								Add TAB pages
							</span>
						</label>

							<button
								onClick={generateSubmission}
								disabled={
									individualFiles.length === 0 || isGenerating || hasPendingUploads
								}
								className="w-full py-3 px-4 bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
							>
								{isGenerating ? (
									<>
										<Loader2 className="w-5 h-5 animate-spin" />
										Generating...
									</>
								) : hasPendingUploads ? (
									<>
										<Loader2 className="w-5 h-5 animate-spin" />
										Processing uploads...
									</>
								) : (
									<>
										Generate Submission
										<ArrowRight className="w-5 h-5" />
									</>
								)}
							</button>
							{hasPendingUploads && (
								<p className="text-xs text-slate-400 mt-2">
									Please wait until scanning and auto-fixing complete.
								</p>
							)}

						{hasGeneratedPdf && (
							<div className="mt-6 pt-6 border-t border-slate-800">
								<div className="flex items-center justify-between mb-4">
									<h4 className="font-medium text-emerald-400 flex items-center gap-2">
										<div className="w-2 h-2 rounded-full bg-emerald-400"></div>
										Ready to download
									</h4>
								</div>
								<div className="flex gap-3">
									<button
										onClick={handleGeneratedPreview}
										className="flex-1 py-3 px-4 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
									>
										<Eye className="w-5 h-5" />
										Preview
									</button>
									<button
										type="button"
										onClick={handleGeneratedDownload}
										className="flex-1 py-3 px-4 bg-white text-slate-900 hover:bg-slate-100 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
									>
										<Download className="w-5 h-5" />
										Download
									</button>
								</div>
							</div>
						)}
					</div>

					{/* Tab Index Info */}
					{tabInfo.length > 0 && (
						<div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
							<div className="flex items-center justify-between mb-4">
								<div>
									<h3 className="text-lg font-semibold mb-1">
										Tab Index Reference
									</h3>
									<p className="text-slate-500 text-sm">
										Use these page numbers to update your
										Index page.
									</p>
								</div>
								<button
									onClick={copyPageNumbers}
									className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
									title="Copy page numbers column"
								>
									{copied ? (
										<>
											<Check className="w-3.5 h-3.5" />
											Copied
										</>
									) : (
										<>
											<Copy className="w-3.5 h-3.5" />
											Copy Pages
										</>
									)}
								</button>
							</div>

							<div className="overflow-hidden rounded-xl border border-slate-200">
								<table className="w-full text-sm text-left">
									<thead className="bg-slate-50 text-slate-600 font-medium border-b border-slate-200">
										<tr>
											<th className="px-4 py-3">Tab</th>
											<th className="px-4 py-3">
												Document
											</th>
											<th className="px-4 py-3 text-right">
												Page
											</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-slate-100">
										{tabInfo.map((info) => (
											<tr
												key={info.tabNumber}
												className="hover:bg-slate-50/50"
											>
												<td className="px-4 py-3 font-medium text-slate-900 whitespace-nowrap">
													TAB-{info.tabNumber}
												</td>
												<td
													className="px-4 py-3 text-slate-600 truncate max-w-[150px]"
													title={info.fileName}
												>
													{info.fileName}
												</td>
												<td className="px-4 py-3 text-right font-mono text-slate-900">
													{info.pageNumber}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>
					)}
				</div>
			</main>

			{previewUrl && previewTitle && (
				<PdfPreviewModal
					url={previewUrl}
					title={previewTitle}
					onClose={() => {
						if (previewUrl) URL.revokeObjectURL(previewUrl);
						setPreviewUrl(null);
						setPreviewTitle(null);
					}}
				/>
			)}

			{editingFile &&
				bytesStoreRef.current.get(editingFile.id) &&
				editingOriginalBytes && (
					<PageEditorModal
						file={editingFile}
						fileBytes={bytesStoreRef.current.get(editingFile.id)!}
						originalFileBytes={editingOriginalBytes}
						onClose={() => {
							setEditingFile(null);
							setEditingOriginalBytes(null);
						}}
						onSave={handleSaveEdit}
					/>
				)}
		</div>
	);
}

function PdfPageFixerPage() {
	const [uploadedFiles, setUploadedFiles] = useState<PdfFile[]>([]);
	const bytesStoreRef = useRef<Map<string, Uint8Array>>(new Map());
	const originalBytesStoreRef = useRef<Map<string, Uint8Array>>(new Map());
	const autoFixedBytesStoreRef = useRef<Map<string, Uint8Array>>(new Map());
	const [isDragging, setIsDragging] = useState(false);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [previewTitle, setPreviewTitle] = useState<string | null>(null);
	const [editingFile, setEditingFile] = useState<PdfFile | null>(null);
	const [editingOriginalBytes, setEditingOriginalBytes] =
		useState<Uint8Array | null>(null);
	const editRequestIdRef = useRef(0);
	const [isGenerating, setIsGenerating] = useState(false);
	const [addPageNumbers, setAddPageNumbers] = useState(false);
	const [autoFixEnabled, setAutoFixEnabled] = useState(true);
	const [pageNumberStart, setPageNumberStart] = useState(1);
	const hasPendingUploads = uploadedFiles.some((file) => Boolean(file.processingStage));

	const sensors = useSensors(
		useSensor(MouseSensor, {
			activationConstraint: {
				distance: 8,
			},
		}),
		useSensor(TouchSensor, {
			activationConstraint: {
				delay: 200,
				tolerance: 5,
			},
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	useEffect(() => {
		return () => {
			if (previewUrl) {
				URL.revokeObjectURL(previewUrl);
			}
		};
	}, [previewUrl]);

	const autoFixPdf = async (
		pdfBytes: Uint8Array,
	): Promise<{
		bytes: Uint8Array;
		issues: PageIssue[];
		pageCount: number;
		autoFixApplied: boolean;
		autoFixSummary?: string;
		autoFixedPageFixTypes: Record<number, ("rotation" | "scaling")[]>;
	}> => {
		const buildRasterizedFallbackResult = async () => {
			const rasterizedBytes = await rasterizePdfToEditableA4(pdfBytes);
			const rasterizedDoc = await loadPdfForEditing(rasterizedBytes);
			const pageCount = rasterizedDoc.getPageCount();
			const autoFixedPageFixTypes = Object.fromEntries(
				Array.from({ length: pageCount }, (_, pageIndex) => [
					pageIndex,
					["scaling"] as ("rotation" | "scaling")[],
				]),
			);
			return {
				bytes: rasterizedBytes,
				issues: getIssuesFromDoc(rasterizedDoc),
				pageCount,
				autoFixApplied: true,
				autoFixSummary: `${pageCount}/${pageCount} pages rasterized and normalized to A4 to bypass PDF protection. ${IMAGE_ONLY_NOTICE}`,
				autoFixedPageFixTypes,
			};
		};

		try {
			const srcDoc = await loadPdfForEditing(pdfBytes);
			const [A4_WIDTH, A4_HEIGHT] = PageSizes.A4;
			const pageCount = srcDoc.getPageCount();
			let malformedPageEncountered = false;
			let textAngles: (number | null)[] = [];
			try {
				textAngles = await detectDominantTextAngles(pdfBytes);
			} catch {
				textAngles = Array.from({ length: pageCount }, () => null);
			}
			const autoFixedPageFixes = new Map<
				number,
				{ rotation: boolean; scaling: boolean }
			>();
			const markFix = (
				pageIndex: number,
				type: "rotation" | "scaling",
			) => {
				const existing = autoFixedPageFixes.get(pageIndex) ?? {
					rotation: false,
					scaling: false,
				};
				existing[type] = true;
				autoFixedPageFixes.set(pageIndex, existing);
			};
			let rotatedPages = 0;

			for (let i = 0; i < pageCount; i++) {
				try {
					const page = srcDoc.getPage(i);
					const { width, height } = page.getSize();
					const currentRotation = normalizeAngle(page.getRotation().angle);
					const detectedTextAngle = textAngles[i] ?? null;
					const nextRotation = chooseFinalPageRotationForPortrait(
						currentRotation,
						detectedTextAngle,
					);
					page.setRotation(degrees(nextRotation));
					if (nextRotation !== currentRotation) rotatedPages++;

					const targetW = A4_WIDTH;
					const targetH = A4_HEIGHT;
					const scale = Math.min(targetW / width, targetH / height);
					const scaledWidth = width * scale;
					const scaledHeight = height * scale;
					const dx = (targetW - scaledWidth) / 2;
					const dy = (targetH - scaledHeight) / 2;

					page.setSize(targetW, targetH);
					page.scaleContent(scale, scale);
					page.translateContent(dx, dy);
					scaleAndTranslatePageAnnotations(page, scale, dx, dy);

					if (
						nextRotation !== currentRotation ||
						Math.abs(width - targetW) > 0.5 ||
						Math.abs(height - targetH) > 0.5
					) {
						if (nextRotation !== currentRotation) {
							markFix(i, "rotation");
						}
						if (
							Math.abs(width - targetW) > 0.5 ||
							Math.abs(height - targetH) > 0.5
						) {
							markFix(i, "scaling");
						}
					}
				} catch {
					malformedPageEncountered = true;
				}
			}

			const firstPassBytes = await srcDoc.save({
				useObjectStreams: true,
				objectsPerTick: 100,
			});

			const finalAngles = await detectDominantTextAngles(firstPassBytes);
			const firstPassDoc = await loadPdfForEditing(firstPassBytes);
			const firstPassRotations = firstPassDoc
				.getPages()
				.map((page) => normalizeAngle(page.getRotation().angle));
			const upsideDownPages: number[] = [];
			for (let i = 0; i < finalAngles.length; i++) {
				if (
					getUpsideDownCorrectionFromAngle(
						finalAngles[i],
						firstPassRotations[i] ?? 0,
					) === 180
				) {
					upsideDownPages.push(i);
				}
			}

			let finalBytes = firstPassBytes;
			if (upsideDownPages.length > 0) {
				const correctedDoc = await loadPdfForEditing(firstPassBytes);
				for (const pageIndex of upsideDownPages) {
					const page = correctedDoc.getPage(pageIndex);
					const rotation = normalizeAngle(page.getRotation().angle);
					page.setRotation(degrees(rotation + 180));
					markFix(pageIndex, "rotation");
				}
				finalBytes = await correctedDoc.save({
					useObjectStreams: true,
					objectsPerTick: 100,
				});
				rotatedPages += upsideDownPages.length;
			}

			const finalDocForIssues = await loadPdfForEditing(finalBytes);
			const remainingIssues = getIssuesFromDoc(finalDocForIssues);
			const changedPages = autoFixedPageFixes.size;
			const autoFixApplied = changedPages > 0;
			const autoFixSummary = autoFixApplied
				? `${changedPages}/${pageCount} pages normalized to A4; ${rotatedPages} page(s) auto-rotated using text orientation detection.`
				: undefined;
			const autoFixedPageFixTypes = Object.fromEntries(
				Array.from(autoFixedPageFixes.entries()).map(([pageIndex, fix]) => [
					pageIndex,
					[
						...(fix.rotation ? (["rotation"] as const) : []),
						...(fix.scaling ? (["scaling"] as const) : []),
					],
				]),
			);

			return {
				bytes: finalBytes,
				issues: remainingIssues,
				pageCount,
				autoFixApplied,
				autoFixSummary,
				autoFixedPageFixTypes,
			};
		} catch (error) {
			console.error("Error auto-fixing PDF:", error);
			try {
				return await buildRasterizedFallbackResult();
			} catch (rasterError) {
				console.error("Raster fallback failed:", rasterError);
				const srcDocFallback = await loadPdfForEditing(pdfBytes);
				return {
					bytes: pdfBytes,
					issues: getIssuesFromDoc(srcDocFallback),
					pageCount: srcDocFallback.getPageCount(),
					autoFixApplied: false,
					autoFixSummary: undefined,
					autoFixedPageFixTypes: {},
				};
			}
		}
	};

	const processFiles = async (files: File[]) => {
		const pdfFiles = files.filter((file) => file.type === "application/pdf");
		if (pdfFiles.length === 0) return;

		const optimisticFiles: PdfFile[] = pdfFiles.map((file) => ({
			id: crypto.randomUUID(),
			name: file.name,
			file,
			pageCount: 0,
			processingStage: "uploading",
		}));
		setUploadedFiles((prev) => [...prev, ...optimisticFiles]);

		for (const optimisticFile of optimisticFiles) {
			const { id, file } = optimisticFile;
			try {
				const rawBytes = new Uint8Array(await file.arrayBuffer());
				setUploadedFiles((prev) =>
					prev.map((existingFile) =>
						existingFile.id === id
							? { ...existingFile, processingStage: "scanning" }
							: existingFile,
					),
				);
				const prepared = await prepareEditablePdfBytes(rawBytes);
				const editableBytes = prepared.bytes;
				const originalDoc = await loadPdfForEditing(editableBytes);
				const originalIssues = getIssuesFromDoc(originalDoc);
				setUploadedFiles((prev) =>
					prev.map((existingFile) =>
						existingFile.id === id
							? {
								...existingFile,
								processingStage: "autofixing",
								imageOnly: prepared.imageOnly,
							}
							: existingFile,
					),
				);
				const {
					bytes: finalBytes,
					issues,
					pageCount,
					autoFixApplied,
					autoFixSummary,
					autoFixedPageFixTypes,
				} = await autoFixPdf(editableBytes);

				bytesStoreRef.current.set(id, finalBytes);
				originalBytesStoreRef.current.set(id, editableBytes);
				autoFixedBytesStoreRef.current.set(id, finalBytes);
				setUploadedFiles((prev) =>
					prev.map((existingFile) =>
						existingFile.id === id
							? {
								...existingFile,
								pageCount,
								originalIssues:
									originalIssues.length > 0 ? originalIssues : undefined,
								savedAutoFixedIssues:
									issues.length > 0 ? issues : undefined,
								issues: issues.length > 0 ? issues : undefined,
								autoFixApplied,
								autoFixSummary: withImageOnlyNotice(
									autoFixSummary,
									prepared.imageOnly,
								),
								savedAutoFixSummary: withImageOnlyNotice(
									autoFixSummary,
									prepared.imageOnly,
								),
								autoFixedPageFixTypes,
								savedAutoFixedPageFixTypes: autoFixedPageFixTypes,
								imageOnly: prepared.imageOnly,
								processingStage: undefined,
							}
							: existingFile,
					),
				);
			} catch (error) {
				console.error(`Failed to auto-fix PDF ${file.name}:`, error);
				bytesStoreRef.current.delete(id);
				originalBytesStoreRef.current.delete(id);
				autoFixedBytesStoreRef.current.delete(id);
				setUploadedFiles((prev) =>
					prev.filter((existingFile) => existingFile.id !== id),
				);
				alert(
					error instanceof Error && error.message
						? `Unable to auto-fix "${file.name}": ${error.message}`
						: `Unable to auto-fix "${file.name}". The file may be severely corrupted or unsupported.`,
				);
			}
		}
	};

	const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from<File>(e.target.files || []);
		await processFiles(files);
		e.target.value = "";
	};

	const handleDrop = async (e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(false);
		const files = Array.from<File>(e.dataTransfer.files || []);
		await processFiles(files);
	};

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (over && active.id !== over.id) {
			setUploadedFiles((items) => {
				const oldIndex = items.findIndex((item) => item.id === active.id);
				const newIndex = items.findIndex((item) => item.id === over.id);
				return arrayMove(items, oldIndex, newIndex);
			});
		}
	};

	const handlePreview = (file: PdfFile) => {
		const bytes = bytesStoreRef.current.get(file.id);
		if (!bytes) return;
		setPreviewUrl((current) => {
			if (current) URL.revokeObjectURL(current);
			return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
		});
		setPreviewTitle(file.name);
	};

	const handleDownloadFile = (file: PdfFile) => {
		const bytes = bytesStoreRef.current.get(file.id);
		if (!bytes) return;
		triggerPdfDownload(bytes, `${file.name.replace(/\.pdf$/i, "")}_fixed.pdf`);
	};

	const handleEdit = (file: PdfFile) => {
		setEditingFile(file);
		setEditingOriginalBytes(null);
		const requestId = ++editRequestIdRef.current;

		const existingOriginalBytes = originalBytesStoreRef.current.get(file.id);
		if (existingOriginalBytes) {
			setEditingOriginalBytes(existingOriginalBytes);
			return;
		}

		void (async () => {
			try {
				const rawBytes = new Uint8Array(await file.file.arrayBuffer());
				const prepared = await prepareEditablePdfBytes(rawBytes);
				const editableBytes = prepared.bytes;
				originalBytesStoreRef.current.set(file.id, editableBytes);
				if (requestId !== editRequestIdRef.current) return;
				setEditingOriginalBytes(editableBytes);
			} catch (error) {
				console.error("Failed to load original bytes for edit preview:", error);
				const fallbackBytes = bytesStoreRef.current.get(file.id) ?? null;
				if (requestId !== editRequestIdRef.current) return;
				setEditingOriginalBytes(fallbackBytes);
			}
		})();
	};

	const handleSaveEdit = (updatedFile: PdfFile, newBytes: Uint8Array) => {
		bytesStoreRef.current.set(updatedFile.id, newBytes);
		const nextFile = { ...updatedFile };
		if (!updatedFile.autoFixDisabled) {
			autoFixedBytesStoreRef.current.set(updatedFile.id, newBytes);
			nextFile.savedAutoFixedIssues = updatedFile.issues;
			nextFile.savedAutoFixSummary = updatedFile.autoFixSummary;
			nextFile.savedAutoFixedPageFixTypes = updatedFile.autoFixedPageFixTypes;
		}
		setUploadedFiles((prev) =>
			prev.map((file) => (file.id === updatedFile.id ? nextFile : file)),
		);
		setEditingFile(null);
		setEditingOriginalBytes(null);
	};

	const removeFile = (id: string) => {
		bytesStoreRef.current.delete(id);
		originalBytesStoreRef.current.delete(id);
		autoFixedBytesStoreRef.current.delete(id);
		setUploadedFiles((prev) => prev.filter((file) => file.id !== id));
	};

	const toggleFileAutoFix = (file: PdfFile) => {
		const isDisabling = !file.autoFixDisabled;
		if (isDisabling) {
			const originalBytes = originalBytesStoreRef.current.get(file.id);
			if (!originalBytes) return;
			bytesStoreRef.current.set(file.id, originalBytes);
		} else {
			const autoFixedBytes = autoFixedBytesStoreRef.current.get(file.id);
			if (!autoFixedBytes) return;
			bytesStoreRef.current.set(file.id, autoFixedBytes);
		}

		setUploadedFiles((prev) =>
			prev.map((currentFile) =>
				currentFile.id !== file.id
					? currentFile
					: isDisabling
						? {
							...currentFile,
							issues: currentFile.originalIssues,
							autoFixApplied: false,
							autoFixDisabled: true,
							autoFixSummary: undefined,
							autoFixedPageFixTypes: undefined,
						}
						: {
							...currentFile,
							issues: currentFile.savedAutoFixedIssues,
							autoFixApplied: true,
							autoFixDisabled: false,
							autoFixSummary: currentFile.savedAutoFixSummary,
							autoFixedPageFixTypes: currentFile.savedAutoFixedPageFixTypes,
						},
			),
		);
	};

	const generateMergedPdf = async () => {
		if (uploadedFiles.length === 0) return;
		setIsGenerating(true);
		try {
			const mergedPdf = await PDFDocument.create();
			for (const file of uploadedFiles) {
				const fileBytes = bytesStoreRef.current.get(file.id);
				if (!fileBytes) throw new Error(`File bytes not found for ${file.name}`);
				const fileDoc = await loadPdfForEditing(fileBytes);
				const copiedPages = await mergedPdf.copyPages(
					fileDoc,
					fileDoc.getPageIndices(),
				);
				copiedPages.forEach((page) => mergedPdf.addPage(page));
			}

			if (addPageNumbers) {
				const helveticaFont = await mergedPdf.embedFont(StandardFonts.Helvetica);
				const pageCount = mergedPdf.getPageCount();
				for (let i = 0; i < pageCount; i++) {
					const page = mergedPdf.getPage(i);
					const { width, height } = page.getSize();
					const pageNumber = pageNumberStart + i;
					const fontSize = 30;
					const text = `${pageNumber}`;
					const textWidth = helveticaFont.widthOfTextAtSize(text, fontSize);

					page.drawText(text, {
						x: width - textWidth - 30,
						y: height - 30 - 10,
						size: fontSize,
						font: helveticaFont,
						color: rgb(0, 0, 0),
					});
				}
			}

			stripLogicalPageMetadata(mergedPdf);
			const mergedPdfBytes = await mergedPdf.save();
			triggerPdfDownload(mergedPdfBytes, "fixed_merged.pdf");
		} catch (error) {
			console.error("Failed to generate merged PDF:", error);
			alert(
				error instanceof Error && error.message
					? `Unable to generate merged PDF: ${error.message}`
					: "Unable to generate merged PDF.",
			);
		} finally {
			setIsGenerating(false);
		}
	};

	return (
		<div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900">
			<PageHeader
				icon={<Wrench className="w-5 h-5 text-white" />}
				title="PDF Page Fixer"
				subtitle="Auto-fix multiple PDFs and optionally merge them in your chosen order"
				showBackButton
				maxWidth="max-w-4xl"
			/>

			<main className="max-w-4xl mx-auto px-6 py-10">
				<section className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
					<div>
						<h2 className="text-lg font-semibold">Upload PDFs</h2>
						<p className="text-slate-500 text-sm mt-1">
							Each file is auto-fixed for unlock/normalization, portrait rotation, and A4 scaling. Drag to reorder for merged download.
						</p>
					</div>

					<label
						className={cn(
							"flex flex-col items-center justify-center w-full h-36 border-2 border-dashed rounded-xl cursor-pointer transition-colors",
							isDragging
								? "border-indigo-500 bg-indigo-100"
								: "border-slate-300 bg-slate-50 hover:bg-slate-100 hover:border-slate-400",
						)}
						onDragOver={(e) => {
							e.preventDefault();
							setIsDragging(true);
						}}
						onDragLeave={(e) => {
							e.preventDefault();
							setIsDragging(false);
						}}
						onDrop={handleDrop}
					>
						<div className="flex flex-col items-center justify-center px-4 text-center">
							<FileUp className={cn("w-8 h-8 mb-2", isDragging ? "text-indigo-500" : "text-slate-400")} />
							<p className={cn("text-sm font-medium", isDragging ? "text-indigo-700" : "text-slate-700")}>
								Click to upload or drag and drop multiple PDFs
							</p>
							<p className="text-xs text-slate-500 mt-1">
								You can select multiple files at once
							</p>
						</div>
						<input
							type="file"
							className="hidden"
							accept="application/pdf"
							multiple
							onChange={handleUpload}
						/>
					</label>

					{uploadedFiles.length > 0 ? (
						<div className="space-y-3">
							<DndContext
								sensors={sensors}
								collisionDetection={closestCenter}
								onDragEnd={handleDragEnd}
							>
								<SortableContext
									items={uploadedFiles.map((file) => file.id)}
									strategy={verticalListSortingStrategy}
								>
									{uploadedFiles.map((file, index) => (
										<div key={file.id} className="relative">
											<div className="absolute -left-3 top-1/2 -translate-y-1/2 w-6 text-right text-xs font-bold text-slate-400">
												{index + 1}
											</div>
											<SortableItem
												file={file}
												onRemove={removeFile}
												onEdit={handleEdit}
												onDownload={handleDownloadFile}
											/>
										</div>
									))}
								</SortableContext>
							</DndContext>
						</div>
					) : (
						<div className="text-center py-8 text-slate-400 text-sm border border-dashed border-slate-200 rounded-xl">
							No PDFs added yet.
						</div>
					)}

					<div className="border-t border-slate-200 pt-6">
						<button
							onClick={() => setAddPageNumbers(!addPageNumbers)}
							className={cn(
								"w-full py-2 px-4 text-sm font-medium rounded-lg transition-colors border mb-3",
								addPageNumbers
									? "bg-indigo-50 text-indigo-700 border-indigo-200"
									: "bg-white text-slate-600 border-slate-200 hover:bg-slate-50",
							)}
						>
							{addPageNumbers ? "Page Numbers: ON (will be added to merged PDF)" : "Page Numbers: OFF (click to enable for merged PDF)"}
						</button>
						{addPageNumbers && (
							<div className="flex items-center gap-3 mb-3">
								<label className="text-sm text-slate-600">Start page number:</label>
								<input
									type="number"
									min="0"
									value={pageNumberStart}
									onChange={(e) => setPageNumberStart(Math.max(0, parseInt(e.target.value) || 0))}
									className="w-20 px-2 py-1 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
								/>
							</div>
						)}
						<button
							onClick={generateMergedPdf}
							disabled={uploadedFiles.length === 0 || isGenerating || hasPendingUploads}
							className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-500 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
						>
							{isGenerating ? (
								<>
									<Loader2 className="w-5 h-5 animate-spin" />
									Generating merged PDF...
								</>
							) : hasPendingUploads ? (
								<>
									<Loader2 className="w-5 h-5 animate-spin" />
									Processing uploads...
								</>
							) : (
								<>
									<Download className="w-5 h-5" />
									Download Merged PDF
								</>
							)}
						</button>
						{hasPendingUploads ? (
							<p className="text-xs text-slate-500 mt-2">
								Please wait until scanning and auto-fixing complete.
							</p>
						) : null}
					</div>
				</section>
			</main>

			{previewUrl && previewTitle && (
				<PdfPreviewModal
					url={previewUrl}
					title={previewTitle}
					onClose={() => {
						if (previewUrl) URL.revokeObjectURL(previewUrl);
						setPreviewUrl(null);
						setPreviewTitle(null);
					}}
				/>
			)}

			{editingFile &&
			bytesStoreRef.current.get(editingFile.id) &&
			editingOriginalBytes ? (
				<PageEditorModal
					file={editingFile}
					fileBytes={bytesStoreRef.current.get(editingFile.id)!}
					originalFileBytes={editingOriginalBytes}
					onClose={() => {
						setEditingFile(null);
						setEditingOriginalBytes(null);
					}}
					onSave={handleSaveEdit}
				/>
			) : null}
		</div>
	);
}

function LandingPage() {
	return (
		<div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900">
			<PageHeader
				icon={<FileText className="w-5 h-5 text-white" />}
				title="Legal Document Organiser"
				subtitle="Choose a feature to continue"
			/>
			<main className="max-w-5xl mx-auto px-6 py-10 grid grid-cols-1 md:grid-cols-2 gap-6">
				<Link
					to="/bundle-of-authorities"
					className="text-left bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md hover:border-indigo-300 transition-all"
				>
					<div className="w-11 h-11 rounded-xl bg-indigo-600 text-white flex items-center justify-center mb-4">
						<FileText className="w-5 h-5" />
					</div>
					<h2 className="text-lg font-semibold">Bundle of Authorities</h2>
					<p className="text-sm text-slate-500 mt-2">
						Compile cover/index with multiple documents, auto-insert TAB-x pages, and export one merged bundle.
					</p>
				</Link>

				<Link
					to="/pdf-page-fixer"
					className="text-left bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md hover:border-indigo-300 transition-all"
				>
					<div className="w-11 h-11 rounded-xl bg-slate-900 text-white flex items-center justify-center mb-4">
						<Wrench className="w-5 h-5" />
					</div>
					<h2 className="text-lg font-semibold">PDF Page Fixer</h2>
					<p className="text-sm text-slate-500 mt-2">
						Auto-fix multiple PDFs, manually amend pages when needed, and optionally download one merged file.
					</p>
				</Link>
			</main>
		</div>
	);
}

export default function App() {
	return (
		<Routes>
			<Route path="/" element={<LandingPage />} />
			<Route path="/bundle-of-authorities" element={<BundleOfAuthoritiesPage />} />
			<Route path="/pdf-page-fixer" element={<PdfPageFixerPage />} />
			<Route path="*" element={<Navigate to="/" replace />} />
		</Routes>
	);
}
