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
import { loadPdfForEditing, normalizePdfForEditing } from "./lib/pdf-security";
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
	pageCount: number;
	autoFixApplied?: boolean;
	autoFixSummary?: string;
	autoFixedPageFixTypes?: Record<number, ("rotation" | "scaling")[]>;
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
	| { type: "fitToA4"; pageIndices: number[] };

const RIGHT_ANGLES = [0, 90, 180, 270] as const;
const TEXT_ORIENTATION_TOLERANCE_DEG = 20;
const IMAGE_ONLY_NOTICE =
	"Image-only PDF: protection was removed by rasterizing pages. Text is not selectable or highlightable.";
const PDF_POINTS_PER_INCH = 72;
const RASTER_TARGET_DPI = 300;
const RASTER_MAX_PIXELS = 20_000_000;

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
		return 0;
	}

	const candidates = [0, 180].map((finalRotation) => {
		const delta = normalizeAngle(finalRotation - currentPageRotation);
		// pdf.js text item transforms are in page content space and don't include page /Rotate.
		// So final visible orientation is content angle + final page rotation.
		const finalTextAngle = normalizeAngle(dominantTextAngle + finalRotation);
		const bestAllowedDistance = Math.min(
			circularDistance(finalTextAngle, 0),
			circularDistance(finalTextAngle, 90),
		);
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
	const allowedDistance = Math.min(
		circularDistance(visibleTextAngle, 0),
		circularDistance(visibleTextAngle, 90),
	);
	const upsideDistance = Math.min(
		circularDistance(visibleTextAngle, 180),
		circularDistance(visibleTextAngle, 270),
	);

	if (
		upsideDistance <= TEXT_ORIENTATION_TOLERANCE_DEG &&
		upsideDistance < allowedDistance
	) {
		return 180;
	}
	return 0;
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

async function getScaledPageHeightsForRender(
	pdfBytes: Uint8Array,
	targetWidth: number,
): Promise<number[]> {
	const doc = await loadPdfForEditing(pdfBytes);
	const heights: number[] = [];
	const fallbackHeight = targetWidth * Math.sqrt(2);
	const pageCount = doc.getPageCount();
	for (let i = 0; i < pageCount; i++) {
		try {
			const page = doc.getPage(i);
			const { width, height } = page.getSize();
			const rotation = normalizeAngle(page.getRotation().angle);
			const effectiveWidth = rotation % 180 === 0 ? width : height;
			const effectiveHeight = rotation % 180 === 0 ? height : width;
			heights.push((targetWidth * effectiveHeight) / effectiveWidth);
		} catch {
			heights.push(fallbackHeight);
		}
	}
	return heights;
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

function getRenderedHeightAtWidth(
	width: number,
	height: number,
	pageRotation: number,
	targetWidth: number,
	additionalRotation: number,
): number {
	const totalRotation = normalizeAngle(pageRotation + additionalRotation);
	const effectiveWidth = totalRotation % 180 === 0 ? width : height;
	const effectiveHeight = totalRotation % 180 === 0 ? height : width;
	return (targetWidth * effectiveHeight) / effectiveWidth;
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
	const [afterPreviewBytes, setAfterPreviewBytes] = useState<Uint8Array | null>(
		null,
	);
	const [compareView, setCompareView] = useState<CompareView>("after");
	const [isSaving, setIsSaving] = useState(false);
	const [isPreviewLoading, setIsPreviewLoading] = useState(true);
	const [applyToAll, setApplyToAll] = useState(false);
	const [modifications, setModifications] = useState<PageModification[]>([]);
	const [beforePageHeights, setBeforePageHeights] = useState<number[]>([]);
	const [afterPageHeights, setAfterPageHeights] = useState<number[]>([]);
	const [beforeDisplayRotations, setBeforeDisplayRotations] = useState<number[]>(
		[],
	);
	const splitPageRenderWidth = 420;
	const pageRenderWidth = compareView === "split" ? splitPageRenderWidth : 560;
	const renderedPageWidth =
		compareView === "split"
			? pageRenderWidth
			: Math.min(window.innerWidth * 0.3, pageRenderWidth);

	const workerRef = useRef<Worker | null>(null);
	const previewRequestIdRef = useRef(0);
	const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const previewUrlRef = useRef<string | null>(null);
	const beforePagePreviewRefs = useRef<Array<HTMLDivElement | null>>([]);
	const afterPagePreviewRefs = useRef<Array<HTMLDivElement | null>>([]);

	// Keep ref in sync for cleanup
	previewUrlRef.current = previewUrl;

	useEffect(() => {
		const url = URL.createObjectURL(
			new Blob([originalFileBytes], { type: "application/pdf" }),
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
			const heights = pages.map((page, index) => {
				const { width, height } = page.getSize();
				const pageRotation = normalizeAngle(page.getRotation().angle);
				return getRenderedHeightAtWidth(
					width,
					height,
					pageRotation,
					splitPageRenderWidth,
					normalizeAngle((rotations[index] ?? pageRotation) - pageRotation),
				);
			});
			return { rotations, heights };
		})()
			.then(({ rotations, heights }) => {
				if (!cancelled) {
					setBeforeDisplayRotations(rotations);
					setBeforePageHeights(heights);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setBeforeDisplayRotations([]);
					setBeforePageHeights([]);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [originalFileBytes]);

	// Single persistent worker - all heavy work runs off main thread
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
		};
	}, []);

	const hasTransferredBytesRef = useRef(false);

	const requestPreview = useCallback(() => {
		const worker = workerRef.current;
		if (!worker) return;

		const requestId = ++previewRequestIdRef.current;

		// First request: transfer bytes (worker caches). Subsequent: tiny message only.
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
			const bytesCopy = new Uint8Array(fileBytes);
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
	}, [fileBytes, modifications]);

	// Debounced preview: when modifications change, request after delay
	useEffect(() => {
		if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);

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

	// Handle worker responses
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
				if (requestId !== previewRequestIdRef.current) return; // stale
				const previewBytes =
					e.data.bytes instanceof Uint8Array
						? e.data.bytes
						: new Uint8Array(e.data.bytes);
				setAfterPreviewBytes(previewBytes);
				const url = URL.createObjectURL(
					new Blob([previewBytes], { type: "application/pdf" }),
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
		if (!afterPreviewBytes) {
			setAfterPageHeights([]);
			return;
		}

		let cancelled = false;

		void getScaledPageHeightsForRender(afterPreviewBytes, splitPageRenderWidth)
			.then((heights) => {
				if (!cancelled) {
					setAfterPageHeights(heights);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setAfterPageHeights([]);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [afterPreviewBytes]);

	const splitRowHeights = useMemo(
		() =>
			Array.from({ length: file.pageCount }, (_, index) =>
				Math.max(
					beforePageHeights[index] ?? 0,
					afterPageHeights[index] ?? 0,
					160,
				),
			),
		[file.pageCount, beforePageHeights, afterPageHeights],
	);

	const pageFixTypes = useMemo(() => {
		const perPage = new Map<number, { rotation: boolean; scaling: boolean }>();
		const ensure = (pageIndex: number) => {
			let existing = perPage.get(pageIndex);
			if (!existing) {
				existing = { rotation: false, scaling: false };
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

		if (
			file.autoFixApplied &&
			(!file.autoFixedPageFixTypes ||
				Object.keys(file.autoFixedPageFixTypes).length === 0)
		) {
			// Backward compatibility for files loaded before per-page fix-type tracking.
			for (const pageIndex of availablePageIndices) {
				const pageFix = ensure(pageIndex);
				pageFix.rotation = true;
				pageFix.scaling = true;
			}
		}

		for (const modification of modifications) {
			for (const pageIndex of modification.pageIndices) {
				const pageFix = ensure(pageIndex);
				if (modification.type === "rotate") pageFix.rotation = true;
				if (modification.type === "fitToA4") pageFix.scaling = true;
			}
		}

		return perPage;
	}, [availablePageIndices, file.autoFixApplied, file.autoFixedPageFixTypes, modifications]);

	useEffect(() => {
		const beforeNode = beforePagePreviewRefs.current[selectedPageIndex];
		const afterNode = afterPagePreviewRefs.current[selectedPageIndex];
		if (compareView !== "after" && beforeNode) {
			beforeNode.scrollIntoView({ block: "center", behavior: "smooth" });
		}
		if (compareView !== "before" && afterNode) {
			afterNode.scrollIntoView({ block: "center", behavior: "smooth" });
		}
	}, [compareView, selectedPageIndex, beforePreviewUrl, previewUrl]);

	const handleRotate = useCallback(
		(angle: number) => {
			const pageIndices = applyToAll
				? availablePageIndices
				: [selectedPageIndex];
			setModifications((prev) => [
				...prev,
				{ type: "rotate", pageIndices, angle },
			]);
		},
		[applyToAll, availablePageIndices, selectedPageIndex],
	);

	const handleFitToA4 = useCallback(() => {
		const indicesToProcess = applyToAll
			? availablePageIndices
			: [selectedPageIndex];
		setModifications((prev) => [
			...prev,
			{ type: "fitToA4", pageIndices: indicesToProcess },
		]);
	}, [applyToAll, availablePageIndices, selectedPageIndex]);

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
				// Use cached bytes if available, else transfer (e.g. save before first preview)
				if (hasTransferredBytesRef.current) {
					worker.postMessage({
						type: "save",
						useCachedBytes: true,
						modifications,
					});
				} else {
					const bytesCopy = new Uint8Array(fileBytes);
					worker.postMessage(
						{ type: "save", bytes: bytesCopy, modifications },
						[bytesCopy.buffer],
					);
				}
			});

			if (!result.ok || !result.bytes) {
				throw new Error(result.error ?? "Save failed");
			}

			onSave(
				{
					...file,
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
	}, [file, fileBytes, modifications, onSave]);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 sm:p-6">
			<div className="bg-white w-full h-full max-w-6xl rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
				<div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
					<h3 className="font-semibold text-slate-700 flex items-center gap-2 min-w-0">
						<AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
						<span className="truncate">
							Review & Amend: {file.name}
						</span>
					</h3>

					{/* Toolbar in Header */}
					<div className="flex items-center gap-2 mx-4">
						<div className="inline-flex items-center rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
							<button
								type="button"
								onClick={() => setCompareView("before")}
								className={cn(
									"px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors",
									compareView === "before"
										? "bg-indigo-600 text-white"
										: "text-slate-600 hover:bg-slate-100",
								)}
							>
								Before
							</button>
							<button
								type="button"
								onClick={() => setCompareView("after")}
								className={cn(
									"px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors",
									compareView === "after"
										? "bg-indigo-600 text-white"
										: "text-slate-600 hover:bg-slate-100",
								)}
							>
								After
							</button>
							<button
								type="button"
								onClick={() => setCompareView("split")}
								className={cn(
									"px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors",
									compareView === "split"
										? "bg-indigo-600 text-white"
										: "text-slate-600 hover:bg-slate-100",
								)}
							>
								Split
							</button>
						</div>

						<div className="w-px h-6 bg-slate-200 mx-1" />

						<button
							onClick={() => setApplyToAll(!applyToAll)}
							className={cn(
								"flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border",
								applyToAll
									? "bg-indigo-50 text-indigo-700 border-indigo-200"
									: "bg-white text-slate-600 border-slate-200 hover:bg-slate-50",
							)}
							title="Apply changes to all pages"
						>
							<Layers className="w-3.5 h-3.5" />
							{applyToAll ? "Applying to All" : "Apply to All"}
						</button>

						<div className="w-px h-6 bg-slate-200 mx-1" />

						<button
							onClick={() => handleRotate(-90)}
							className="p-2 text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
							title="Rotate 90° Counter-Clockwise"
						>
							<RotateCcw className="w-4 h-4" />
						</button>

						<button
							onClick={() => handleRotate(90)}
							className="p-2 text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
							title="Rotate 90° Clockwise"
						>
							<RotateCw className="w-4 h-4" />
						</button>

						<div className="w-px h-6 bg-slate-200 mx-1" />

						<button
							onClick={handleFitToA4}
							className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 hover:text-indigo-700 hover:bg-indigo-50 rounded-lg transition-colors"
							title="Scale to fit A4 Portrait"
						>
							<Maximize className="w-3.5 h-3.5" />
							Fit to A4
						</button>
					</div>

					<button
						onClick={onClose}
						className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded-lg"
					>
						<X className="w-5 h-5" />
					</button>
				</div>
				{file.imageOnly && (
					<div className="px-4 py-2 border-b border-rose-200 bg-rose-50 text-xs text-rose-700 flex items-center gap-2">
						<AlertTriangle className="w-4 h-4 flex-shrink-0" />
						<span>{IMAGE_ONLY_NOTICE}</span>
					</div>
				)}

				<div className="flex-1 flex overflow-hidden">
					{/* Sidebar with issues */}
					<div className="w-64 bg-slate-50 border-r border-slate-200 overflow-y-auto p-4 flex-shrink-0">
						<h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
							Pages
						</h4>
						<div className="space-y-2">
							{availablePageIndices.map((pageIndex) => {
								const issue = file.issues?.find(
									(item) => item.pageIndex === pageIndex,
								);
								return (
									<button
										key={pageIndex}
										onClick={() => setSelectedPageIndex(pageIndex)}
										className={cn(
											"w-full text-left p-3 rounded-lg text-sm transition-colors border",
											selectedPageIndex === pageIndex
												? "bg-indigo-50 border-indigo-200 text-indigo-700"
												: "bg-white border-slate-200 text-slate-600 hover:border-indigo-200",
										)}
									>
											<div className="font-medium mb-1">Page {pageIndex + 1}</div>
											{pageFixTypes.get(pageIndex) && (
												<div className="flex items-center gap-1 mb-1">
													{pageFixTypes.get(pageIndex)?.rotation && (
														<span
															className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
															title="This page has been rotated to portrait orientation."
														>
															Rotation
														</span>
													)}
													{pageFixTypes.get(pageIndex)?.scaling && (
														<span
															className="inline-flex items-center rounded-full bg-cyan-100 px-2 py-0.5 text-[11px] font-medium text-cyan-700"
															title="This page has been scaled to A4 size."
														>
															Scaling
														</span>
													)}
												</div>
											)}
											{issue && (
												<div className="text-xs opacity-80">{issue.description}</div>
											)}
										</button>
								);
							})}
						</div>
					</div>

					{/* Main Preview Area */}
					<div className="flex-1 bg-slate-100 overflow-auto p-6">
						{isPreviewLoading || !previewUrl || !beforePreviewUrl ? (
							<div className="h-full flex items-center justify-center">
								<Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
							</div>
						) : (
							<div
								className={cn(
									"gap-6 items-start",
									compareView === "split"
										? "grid grid-cols-2 min-w-[904px]"
										: "grid grid-cols-1",
								)}
								style={
									compareView === "split"
										? { gridTemplateColumns: "minmax(440px, 1fr) minmax(440px, 1fr)" }
										: undefined
								}
							>
								<div className={cn("min-w-0", compareView === "after" ? "hidden" : "block")}>
									<h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
										Before Auto-Fix
									</h4>
									<Document
										key={beforePreviewUrl}
										file={beforePreviewUrl}
										className="flex flex-col items-center gap-6 py-2"
										loading={
											<Loader2 className="w-8 h-8 animate-spin text-indigo-500 m-12" />
										}
										error={
											<div className="flex flex-col items-center justify-center h-64 text-red-500 p-4 text-center">
												<AlertTriangle className="w-8 h-8 mb-2" />
												<p>Failed to load original preview.</p>
											</div>
										}
									>
										{Array.from(
											new Array(file.pageCount),
											(_el, index) => (
												<div
													key={`before_editor_page_${index + 1}`}
													ref={(el) => {
														beforePagePreviewRefs.current[index] = el;
													}}
													onClick={() => setSelectedPageIndex(index)}
													className={cn(
														"relative shadow-lg border-2 cursor-pointer transition-colors",
														selectedPageIndex === index
															? "border-indigo-500"
															: "border-transparent hover:border-indigo-200",
														compareView === "split" &&
														"min-h-[1px] flex items-center justify-center",
													)}
													style={
														compareView === "split"
															? { minHeight: splitRowHeights[index] }
															: undefined
													}
												>
													<div className="absolute top-2 right-2 bg-black/55 text-white text-xs px-2 py-1 rounded z-10 pointer-events-none">
														Page {index + 1}
													</div>
													<Page
														pageNumber={index + 1}
														renderTextLayer={false}
														renderAnnotationLayer={false}
														width={renderedPageWidth}
														rotate={beforeDisplayRotations[index]}
													/>
												</div>
											),
										)}
									</Document>
								</div>

								<div className={cn("min-w-0", compareView === "before" ? "hidden" : "block")}>
									<h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
										After Changes
									</h4>
									<Document
										key={previewUrl}
										file={previewUrl}
										className="flex flex-col items-center gap-6 py-2"
										loading={
											<Loader2 className="w-8 h-8 animate-spin text-indigo-500 m-12" />
										}
										error={
											<div className="flex flex-col items-center justify-center h-64 text-red-500 p-4 text-center">
												<AlertTriangle className="w-8 h-8 mb-2" />
												<p>Failed to load edited preview.</p>
											</div>
										}
									>
										{Array.from(
											new Array(file.pageCount),
											(_el, index) => (
												<div
													key={`after_editor_page_${index + 1}`}
													ref={(el) => {
														afterPagePreviewRefs.current[index] = el;
													}}
													onClick={() => setSelectedPageIndex(index)}
													className={cn(
														"relative shadow-lg bg-white border-2 cursor-pointer transition-colors",
														selectedPageIndex === index
															? "border-indigo-500"
															: "border-transparent hover:border-indigo-200",
														compareView === "split" &&
														"min-h-[1px] flex items-center justify-center",
													)}
													style={
														compareView === "split"
															? { minHeight: splitRowHeights[index] }
															: undefined
													}
												>
													<div className="absolute top-2 right-2 bg-black/55 text-white text-xs px-2 py-1 rounded z-10 pointer-events-none">
														Page {index + 1}
													</div>
													<Page
														pageNumber={index + 1}
														renderTextLayer={false}
														renderAnnotationLayer={false}
														width={renderedPageWidth}
													/>
												</div>
											),
										)}
									</Document>
								</div>
							</div>
						)}
					</div>
				</div>

				<div className="p-4 border-t border-slate-200 bg-white flex justify-end gap-3">
					<button
						onClick={onClose}
						className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
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
		</div>
	);
}

function SortableItem({
	file,
	onRemove,
	onPreview,
	onEdit,
}: {
	file: PdfFile;
	onRemove: (id: string) => void;
	onPreview: (file: PdfFile) => void;
	onEdit: (file: PdfFile) => void;
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

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"flex items-center gap-3 p-4 bg-white border rounded-xl shadow-sm transition-colors",
				isDragging
					? "opacity-50 border-indigo-500 shadow-md z-10 relative"
					: "border-slate-200 hover:border-slate-300",
			)}
		>
				<button
					{...attributes}
					{...listeners}
					disabled={isProcessing}
					className={cn(
						"p-1 rounded-md transition-colors touch-none",
						isProcessing
							? "text-slate-300 cursor-not-allowed"
							: "text-slate-400 hover:text-slate-600 cursor-grab active:cursor-grabbing hover:bg-slate-100",
					)}
				>
					<GripVertical className="w-5 h-5" />
				</button>
			<FileText className="w-5 h-5 text-indigo-500 flex-shrink-0" />
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
						<span className="truncate font-medium text-slate-700">
							{file.name}
						</span>
						<div className="flex items-center gap-2 flex-wrap mt-1.5">
							{file.processingStage && (
								<span className="flex items-center gap-1 text-xs font-medium text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-200">
									<Loader2 className="w-3 h-3 animate-spin" />
									{getProcessingStageLabel(file.processingStage)}
								</span>
							)}
							{file.issues && file.issues.length > 0 && (
								<span className="flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
								<AlertTriangle className="w-3 h-3" />
								{file.issues.length} Issue
								{file.issues.length > 1 ? "s" : ""}
							</span>
						)}
						{file.autoFixApplied && (
							<span className="flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200" title={file.autoFixSummary || "All pages were auto-fixed to A4 and portrait constraints."}>
								<Check className="w-3 h-3" />
								Auto-Fixed
							</span>
						)}
							{file.imageOnly && (
								<ImageOnlyBadge />
							)}
					</div>
				</div>
			</div>

				{!isProcessing && ((file.issues && file.issues.length > 0) || file.autoFixApplied) ? (
					<button
						onClick={() => onEdit(file)}
						className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors flex items-center gap-1"
				>
					Review & Amend
				</button>
			) : null}

				<button
					onClick={() => onPreview(file)}
					disabled={isProcessing}
					className={cn(
						"p-2 rounded-lg transition-colors",
						isProcessing
							? "text-slate-300 cursor-not-allowed"
							: "text-slate-400 hover:text-indigo-500 hover:bg-indigo-50",
					)}
					title="Preview file"
				>
					<Eye className="w-4 h-4" />
				</button>
				<button
					onClick={() => onRemove(file.id)}
					disabled={isProcessing}
					className={cn(
						"p-2 rounded-lg transition-colors",
						isProcessing
							? "text-slate-300 cursor-not-allowed"
							: "text-slate-400 hover:text-red-500 hover:bg-red-50",
					)}
					title="Remove file"
				>
					<Trash2 className="w-4 h-4" />
				</button>
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

function BundleOfAuthoritiesPage() {
	const [coverFile, setCoverFile] = useState<PdfFile | null>(null);
	const [individualFiles, setIndividualFiles] = useState<PdfFile[]>([]);
	const bytesStoreRef = useRef<Map<string, Uint8Array>>(new Map());
	const originalBytesStoreRef = useRef<Map<string, Uint8Array>>(new Map());
	const coverUploadRequestIdRef = useRef(0);
	const [isGenerating, setIsGenerating] = useState(false);
	const [generatedPdfUrl, setGeneratedPdfUrl] = useState<string | null>(null);
	const [tabInfo, setTabInfo] = useState<TabInfo[]>([]);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [previewTitle, setPreviewTitle] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

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

			let finalBytes = firstPassBytes;
			try {
				const finalAngles = await detectDominantTextAngles(firstPassBytes);
				const firstPassDoc = await loadPdfForEditing(firstPassBytes);
				const firstPassPageCount = firstPassDoc.getPageCount();
				const upsideDownPages: number[] = [];
				for (let i = 0; i < Math.min(finalAngles.length, firstPassPageCount); i++) {
					try {
						const page = firstPassDoc.getPage(i);
						const rotation = normalizeAngle(page.getRotation().angle);
						if (
							getUpsideDownCorrectionFromAngle(finalAngles[i] ?? null, rotation) === 180
						) {
							upsideDownPages.push(i);
						}
						} catch {
							malformedPageEncountered = true;
						}
					}

					if (upsideDownPages.length > 0) {
						const correctedDoc = await loadPdfForEditing(firstPassBytes);
					for (const pageIndex of upsideDownPages) {
						try {
							const page = correctedDoc.getPage(pageIndex);
							const rotation = normalizeAngle(page.getRotation().angle);
							page.setRotation(degrees(rotation + 180));
								markFix(pageIndex, "rotation");
								rotatedPages++;
							} catch {
								malformedPageEncountered = true;
							}
						}
						finalBytes = await correctedDoc.save({
							useObjectStreams: true,
							objectsPerTick: 100,
						});
					}
				} catch {
					malformedPageEncountered = true;
				}

			let remainingIssues: PageIssue[] = [];
			try {
				const finalDocForIssues = await loadPdfForEditing(finalBytes);
				remainingIssues = getIssuesFromDoc(finalDocForIssues);
			} catch {
				remainingIssues = getIssuesFromDoc(srcDoc);
				malformedPageEncountered = true;
			}
			if (malformedPageEncountered) {
				throw new Error("Malformed page references detected");
			}

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
			console.error("Structured auto-fix failed, retrying with rasterization:", error);
			try {
				return await buildRasterizedFallbackResult();
			} catch (rasterError) {
				console.error("Raster fallback failed:", rasterError);
				throw new Error(
					"Unable to auto-fix this PDF. The file is unreadable even after rasterization.",
				);
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
				const {
					bytes: finalBytes,
					issues,
					pageCount,
					autoFixApplied,
					autoFixSummary,
					autoFixedPageFixTypes,
				} = await autoFixPdf(editableBytes);
				if (requestId !== coverUploadRequestIdRef.current) return;

				bytesStoreRef.current.set(coverId, finalBytes);
				originalBytesStoreRef.current.set(coverId, editableBytes);
				setCoverFile({
					id: coverId,
					name: file.name,
					file,
					pageCount,
					issues: issues.length > 0 ? issues : undefined,
					autoFixApplied,
					autoFixSummary: withImageOnlyNotice(
						autoFixSummary,
						prepared.imageOnly,
					),
					autoFixedPageFixTypes,
					imageOnly: prepared.imageOnly,
					processingStage: undefined,
				});
			} catch (error) {
				if (requestId !== coverUploadRequestIdRef.current) return;
				console.error("Failed to auto-fix cover PDF:", error);
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
				setIndividualFiles((prev) =>
					prev.map((existingFile) =>
						existingFile.id === id
							? {
								...existingFile,
								pageCount,
								issues: issues.length > 0 ? issues : undefined,
								autoFixApplied,
								autoFixSummary: withImageOnlyNotice(
									autoFixSummary,
									prepared.imageOnly,
								),
								autoFixedPageFixTypes,
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
		const files = Array.from(e.target.files || []) as File[];
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
		const files = Array.from(e.dataTransfer.files || []);
		await processIndividualFiles(files as File[]);
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
		// Revoke previous preview URL to free memory
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		const bytes = bytesStoreRef.current.get(file.id);
		if (!bytes) return;
		const blob = new Blob([bytes], { type: "application/pdf" });
		const url = URL.createObjectURL(blob);
		setPreviewUrl(url);
		setPreviewTitle(file.name);
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
		setIndividualFiles((prev) => prev.filter((f) => f.id !== id));
	};

	const generateSubmission = async () => {
		if (individualFiles.length === 0) return;

		setIsGenerating(true);
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

				// Add TAB-x page
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

				newTabInfo.push({
					tabNumber,
					fileName: file.name,
					pageNumber: currentPageNumber,
				});
				currentPageNumber++;

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

			const mergedPdfBytes = await mergedPdf.save();
			const blob = new Blob([mergedPdfBytes as any], {
				type: "application/pdf",
			});
			const url = URL.createObjectURL(blob);

			setGeneratedPdfUrl(url);
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
											<FileText className="w-8 h-8 text-indigo-500 mb-2" />
											<p className="text-sm font-medium text-slate-700">
												{coverFile.name}
											</p>

										<div className="flex flex-col items-center gap-2 mt-2 mb-1">
											<div className="flex items-center gap-2 flex-wrap justify-center">
												{coverFile.issues &&
													coverFile.issues.length > 0 && (
														<span className="flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
															<AlertTriangle className="w-3 h-3" />
															{
																coverFile.issues
																	.length
															}{" "}
															Issue
															{coverFile.issues
																.length > 1
																? "s"
																: ""}
														</span>
													)}
												{coverFile.processingStage && (
													<span className="flex items-center gap-1 text-xs font-medium text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-200">
														<Loader2 className="w-3 h-3 animate-spin" />
														{getProcessingStageLabel(coverFile.processingStage)}
													</span>
												)}
												{coverFile.autoFixApplied && (
													<span className="flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200" title={coverFile.autoFixSummary || "All pages were auto-fixed to A4 and portrait constraints."}>
														<Check className="w-3 h-3" />
														Auto-Fixed
													</span>
												)}
												{coverFile.imageOnly && (
													<ImageOnlyBadge />
												)}
											</div>

											</div>

											<p className="text-xs text-slate-500 mt-2">
												Click to replace
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
							{coverFile && (
									<div className="mt-3 flex flex-wrap gap-3">
										{((coverFile.issues &&
											coverFile.issues.length > 0) ||
											coverFile.autoFixApplied) &&
											!coverFile.processingStage && (
												<button
													type="button"
													onClick={() => handleEdit(coverFile)}
													className="px-4 py-2 text-sm font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors"
												>
													Review & Amend
												</button>
											)}
										<button
											type="button"
											onClick={() => handlePreview(coverFile)}
											disabled={Boolean(coverFile.processingStage)}
											className={cn(
												"px-4 py-2 text-sm font-medium border rounded-lg transition-colors flex items-center gap-2",
												coverFile.processingStage
													? "text-slate-400 bg-slate-100 border-slate-200 cursor-not-allowed"
													: "text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border-indigo-200",
											)}
										>
											<Eye className="w-4 h-4" />
											Preview
										</button>
										<button
											onClick={() => {
												if (coverFile) {
													bytesStoreRef.current.delete(coverFile.id);
												originalBytesStoreRef.current.delete(coverFile.id);
											}
											setCoverFile(null);
										}}
											disabled={Boolean(coverFile.processingStage)}
											className={cn(
												"px-4 py-2 text-sm font-medium border rounded-lg transition-colors flex items-center gap-2",
												coverFile.processingStage
													? "text-slate-400 bg-slate-100 border-slate-200 cursor-not-allowed"
													: "text-red-600 bg-red-50 hover:bg-red-100 border-red-200",
											)}
										>
											<Trash2 className="w-4 h-4" /> Remove
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
													onPreview={handlePreview}
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
						<p className="text-slate-400 text-sm mb-6">
							This will merge all documents, insert TAB pages, and
							add page numbers to the top right corner.
						</p>

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

						{generatedPdfUrl && (
							<div className="mt-6 pt-6 border-t border-slate-800">
								<div className="flex items-center justify-between mb-4">
									<h4 className="font-medium text-emerald-400 flex items-center gap-2">
										<div className="w-2 h-2 rounded-full bg-emerald-400"></div>
										Ready to download
									</h4>
								</div>
								<div className="flex gap-3">
									<button
										onClick={() => {
											setPreviewUrl(generatedPdfUrl);
											setPreviewTitle(
												"Bundle_of_Authorities.pdf",
											);
										}}
										className="flex-1 py-3 px-4 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
									>
										<Eye className="w-5 h-5" />
										Preview
									</button>
									<a
										href={generatedPdfUrl}
										download="Bundle_of_Authorities.pdf"
										className="flex-1 py-3 px-4 bg-white text-slate-900 hover:bg-slate-100 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
									>
										<Download className="w-5 h-5" />
										Download
									</a>
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
	const [uploadedFile, setUploadedFile] = useState<PdfFile | null>(null);
	const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
	const [originalBytes, setOriginalBytes] = useState<Uint8Array | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [previewTitle, setPreviewTitle] = useState<string | null>(null);
	const [isEditing, setIsEditing] = useState(false);

	useEffect(() => {
		return () => {
			if (previewUrl) {
				URL.revokeObjectURL(previewUrl);
			}
		};
	}, [previewUrl]);

	const processFile = async (file: File) => {
		if (file.type !== "application/pdf") return;

		const optimisticId = crypto.randomUUID();
		setFileBytes(null);
		setOriginalBytes(null);
		setIsEditing(false);
		setUploadedFile({
			id: optimisticId,
			name: file.name,
			file,
			pageCount: 0,
			processingStage: "uploading",
		});

		try {
			const rawBytes = new Uint8Array(await file.arrayBuffer());
			setUploadedFile((prev) =>
				prev && prev.id === optimisticId
					? { ...prev, processingStage: "scanning" }
					: prev,
			);
			const prepared = await prepareEditablePdfBytes(rawBytes);
			const editableBytes = prepared.bytes;
			const doc = await loadPdfForEditing(editableBytes);
			const issues = getIssuesFromDoc(doc);
			setUploadedFile({
				id: optimisticId,
				name: file.name,
				file,
				pageCount: doc.getPageCount(),
				issues: issues.length > 0 ? issues : undefined,
				imageOnly: prepared.imageOnly,
				processingStage: undefined,
			});
			setFileBytes(editableBytes);
			setOriginalBytes(editableBytes);
		} catch (error) {
			console.error("Failed to process PDF:", error);
			setUploadedFile(null);
			alert(
				error instanceof Error && error.message
					? error.message
					: "Unable to process this PDF.",
			);
		}
	};

	const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		await processFile(file);
	};

	const handleDrop = async (e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(false);
		const file = e.dataTransfer.files?.[0];
		if (!file) return;
		await processFile(file);
	};

	const handlePreview = () => {
		if (!uploadedFile || !fileBytes) return;
		setPreviewUrl((current) => {
			if (current) URL.revokeObjectURL(current);
			return URL.createObjectURL(new Blob([fileBytes], { type: "application/pdf" }));
		});
		setPreviewTitle(uploadedFile.name);
	};

	const handleDownload = () => {
		if (!uploadedFile || !fileBytes) return;
		const url = URL.createObjectURL(new Blob([fileBytes], { type: "application/pdf" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = `${uploadedFile.name.replace(/\.pdf$/i, "")}_fixed.pdf`;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	};

	const handleSaveEdit = (updatedFile: PdfFile, newBytes: Uint8Array) => {
		setUploadedFile((prev) =>
			prev
				? { ...updatedFile, file: prev.file }
				: { ...updatedFile, file: updatedFile.file },
		);
		setFileBytes(newBytes);
		setOriginalBytes(new Uint8Array(newBytes));
		setIsEditing(false);
	};

	return (
		<div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900">
			<PageHeader
				icon={<Wrench className="w-5 h-5 text-white" />}
				title="PDF Page Fixer"
				subtitle="Choose a PDF page and apply rotation/scaling fixes only"
				showBackButton
				maxWidth="max-w-4xl"
			/>

			<main className="max-w-4xl mx-auto px-6 py-10">
				<section className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
					<div>
						<h2 className="text-lg font-semibold">Upload PDF</h2>
						<p className="text-slate-500 text-sm mt-1">
							This tool only applies page rotation and A4 scaling fixes. It does not compile documents.
						</p>
					</div>

					<label
						className={cn(
							"flex flex-col items-center justify-center w-full h-44 border-2 border-dashed rounded-xl cursor-pointer transition-colors",
							isDragging
								? "border-indigo-500 bg-indigo-100"
								: uploadedFile
									? "border-indigo-300 bg-indigo-50/50"
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
							{uploadedFile ? (
								<>
									<FileText className="w-8 h-8 text-indigo-500 mb-2" />
									<p className="text-sm font-medium text-slate-700">{uploadedFile.name}</p>
									{uploadedFile.pageCount > 0 && (
										<p className="text-xs text-slate-500 mt-1">
											{uploadedFile.pageCount} {uploadedFile.pageCount === 1 ? "page" : "pages"}
										</p>
									)}
									{uploadedFile.processingStage && (
										<span className="mt-2 flex items-center gap-1 text-xs font-medium text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-200">
											<Loader2 className="w-3 h-3 animate-spin" />
											{getProcessingStageLabel(uploadedFile.processingStage)}
										</span>
									)}
									{uploadedFile.issues && uploadedFile.issues.length > 0 && (
										<span className="mt-2 flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
											<AlertTriangle className="w-3 h-3" />
											{uploadedFile.issues.length} issue{uploadedFile.issues.length > 1 ? "s" : ""} detected
										</span>
									)}
										{uploadedFile.imageOnly && (
											<ImageOnlyBadge className="mt-2" />
										)}
									<p className="text-xs text-slate-500 mt-2">Click to replace</p>
								</>
							) : (
								<>
									<FileUp className="w-8 h-8 text-slate-400 mb-2" />
									<p className="text-sm font-medium text-slate-700">Click to upload or drag and drop PDF</p>
									<p className="text-xs text-slate-500 mt-1">Single PDF file</p>
								</>
							)}
						</div>
						<input
							type="file"
							className="hidden"
							accept="application/pdf"
							onChange={handleUpload}
						/>
					</label>

					{uploadedFile && fileBytes && originalBytes ? (
						<div className="flex flex-wrap gap-3">
							<button
								onClick={() => setIsEditing(true)}
								className="px-4 py-2 text-sm font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors"
							>
								Open Page Fixer
							</button>
							<button
								onClick={handlePreview}
								className="px-4 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors flex items-center gap-2"
							>
								<Eye className="w-4 h-4" />
								Preview
							</button>
							<button
								onClick={handleDownload}
								className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors flex items-center gap-2"
							>
								<Download className="w-4 h-4" />
								Download Fixed PDF
							</button>
							<button
								onClick={() => {
									setUploadedFile(null);
									setFileBytes(null);
									setOriginalBytes(null);
								}}
								className="px-4 py-2 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors flex items-center gap-2"
							>
								<Trash2 className="w-4 h-4" />
								Remove
							</button>
						</div>
					) : null}
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

			{isEditing && uploadedFile && fileBytes && originalBytes ? (
				<PageEditorModal
					file={uploadedFile}
					fileBytes={fileBytes}
					originalFileBytes={originalBytes}
					onClose={() => setIsEditing(false)}
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
						Open a single PDF and manually choose pages to rotate or fit to A4 with before/after review.
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
