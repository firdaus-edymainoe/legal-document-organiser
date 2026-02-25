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
import { cn } from "./lib/utils";

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PageIssue {
	pageIndex: number;
	issueType: "size" | "orientation" | "both";
	description: string;
}

interface PdfFile {
	id: string;
	name: string;
	file: File;
	issues?: PageIssue[];
	pageCount: number;
	autoFixApplied?: boolean;
	autoFixSummary?: string;
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
	const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
	if (!annots) return;

	for (let i = 0; i < annots.size(); i++) {
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
	}
}

function getIssuesFromDoc(doc: PDFDocument): PageIssue[] {
	const pages = doc.getPages();
	const [A4_WIDTH, A4_HEIGHT] = PageSizes.A4;
	const issues: PageIssue[] = [];

	pages.forEach((page, index) => {
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
	});

	return issues;
}

async function getScaledPageHeightsForRender(
	pdfBytes: Uint8Array,
	targetWidth: number,
): Promise<number[]> {
	const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
	return doc.getPages().map((page) => {
		const { width, height } = page.getSize();
		const rotation = normalizeAngle(page.getRotation().angle);
		const effectiveWidth = rotation % 180 === 0 ? width : height;
		const effectiveHeight = rotation % 180 === 0 ? height : width;
		return (targetWidth * effectiveHeight) / effectiveWidth;
	});
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
			const doc = await PDFDocument.load(originalFileBytes, {
				updateMetadata: false,
			});
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
				className="p-1 text-slate-400 hover:text-slate-600 cursor-grab active:cursor-grabbing rounded-md hover:bg-slate-100 transition-colors touch-none"
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
					</div>
				</div>
			</div>

			{(file.issues && file.issues.length > 0) || file.autoFixApplied ? (
				<button
					onClick={() => onEdit(file)}
					className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors flex items-center gap-1"
				>
					Review & Amend
				</button>
			) : null}

			<button
				onClick={() => onPreview(file)}
				className="p-2 text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 rounded-lg transition-colors"
				title="Preview file"
			>
				<Eye className="w-4 h-4" />
			</button>
			<button
				onClick={() => onRemove(file.id)}
				className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
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

export default function App() {
	const [coverFile, setCoverFile] = useState<PdfFile | null>(null);
	const [individualFiles, setIndividualFiles] = useState<PdfFile[]>([]);
	const bytesStoreRef = useRef<Map<string, Uint8Array>>(new Map());
	const originalBytesStoreRef = useRef<Map<string, Uint8Array>>(new Map());
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

	const autoFixPdf = async (
		pdfBytes: Uint8Array,
	): Promise<{
		bytes: Uint8Array;
		issues: PageIssue[];
		pageCount: number;
		autoFixApplied: boolean;
		autoFixSummary?: string;
	}> => {
		try {
			const srcDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
			const textAngles = await detectDominantTextAngles(pdfBytes);
			const [A4_WIDTH, A4_HEIGHT] = PageSizes.A4;
			const pageCount = srcDoc.getPageCount();
			let changedPages = 0;
			let rotatedPages = 0;

			for (let i = 0; i < pageCount; i++) {
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
					changedPages++;
				}
			}

			const firstPassBytes = await srcDoc.save({
				useObjectStreams: true,
				objectsPerTick: 100,
			});

			const finalAngles = await detectDominantTextAngles(firstPassBytes);
			const firstPassDoc = await PDFDocument.load(firstPassBytes, {
				updateMetadata: false,
			});
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
				const correctedDoc = await PDFDocument.load(firstPassBytes, {
					updateMetadata: false,
				});
				for (const pageIndex of upsideDownPages) {
					const page = correctedDoc.getPage(pageIndex);
					const rotation = normalizeAngle(page.getRotation().angle);
					page.setRotation(degrees(rotation + 180));
				}
				finalBytes = await correctedDoc.save({
					useObjectStreams: true,
					objectsPerTick: 100,
				});
				rotatedPages += upsideDownPages.length;
				changedPages += upsideDownPages.length;
			}

			const finalDocForIssues = await PDFDocument.load(finalBytes, {
				updateMetadata: false,
			});
			const remainingIssues = getIssuesFromDoc(finalDocForIssues);
			const autoFixApplied = changedPages > 0;
			const autoFixSummary = autoFixApplied
				? `${changedPages}/${pageCount} pages normalized to A4; ${rotatedPages} page(s) auto-rotated using text orientation detection.`
				: undefined;

			return {
				bytes: finalBytes,
				issues: remainingIssues,
				pageCount,
				autoFixApplied,
				autoFixSummary,
			};
		} catch (error) {
			console.error("Error auto-fixing PDF:", error);
			// Fallback: return original bytes and issues if it fails
			const srcDocFallback = await PDFDocument.load(pdfBytes, { updateMetadata: false });
			return {
				bytes: pdfBytes,
				issues: getIssuesFromDoc(srcDocFallback),
				pageCount: srcDocFallback.getPageCount(),
				autoFixApplied: false,
			};
		}
	};

	const processCoverFile = async (file: File) => {
		if (file.type === "application/pdf") {
			const arrayBuffer = await file.arrayBuffer();
			const originalBytes = new Uint8Array(arrayBuffer);
			const { bytes: finalBytes, issues, pageCount, autoFixApplied, autoFixSummary } =
				await autoFixPdf(originalBytes);
			const id = crypto.randomUUID();

			if (coverFile) {
				bytesStoreRef.current.delete(coverFile.id);
				originalBytesStoreRef.current.delete(coverFile.id);
			}

			bytesStoreRef.current.set(id, finalBytes);
			originalBytesStoreRef.current.set(id, originalBytes);
			setCoverFile({
				id,
				name: file.name,
				file,
				pageCount,
				issues: issues.length > 0 ? issues : undefined,
				autoFixApplied,
				autoFixSummary,
			});
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

		const newFiles: PdfFile[] = await Promise.all(
			pdfFiles.map(async (file) => {
				const arrayBuffer = await file.arrayBuffer();
				const originalBytes = new Uint8Array(arrayBuffer);
				const { bytes: finalBytes, issues, pageCount, autoFixApplied, autoFixSummary } =
					await autoFixPdf(originalBytes);
				const id = crypto.randomUUID();

				bytesStoreRef.current.set(id, finalBytes);
				originalBytesStoreRef.current.set(id, originalBytes);
				return {
					id,
					name: file.name,
					file,
					pageCount,
					issues: issues.length > 0 ? issues : undefined,
					autoFixApplied,
					autoFixSummary,
				};
			}),
		);

		setIndividualFiles((prev) => [...prev, ...newFiles]);
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
				const originalBytes = new Uint8Array(await file.file.arrayBuffer());
				originalBytesStoreRef.current.set(file.id, originalBytes);
				if (requestId !== editRequestIdRef.current) return;
				setEditingOriginalBytes(originalBytes);
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
				const coverDoc = await PDFDocument.load(coverBytes);
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
				const fileDoc = await PDFDocument.load(fileBytes);
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
			<header className="bg-white border-b border-slate-200 sticky top-0 z-20">
				<div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
					<div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-sm">
						<FileText className="w-5 h-5 text-white" />
					</div>
					<div>
						<h1 className="text-xl font-semibold text-slate-900 tracking-tight">
							Legal Document Organiser
						</h1>
						<p className="text-sm text-slate-500 font-medium">
							Prepare court bundles and submissions
						</p>
					</div>
				</div>
			</header>

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
								"flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-colors",
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
							<div className="flex flex-col items-center justify-center pt-5 pb-6">
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
												{coverFile.autoFixApplied && (
													<span className="flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200" title={coverFile.autoFixSummary || "All pages were auto-fixed to A4 and portrait constraints."}>
														<Check className="w-3 h-3" />
														Auto-Fixed
													</span>
												)}
											</div>

											<div className="flex items-center gap-2">
												{((coverFile.issues &&
													coverFile.issues.length > 0) ||
													coverFile.autoFixApplied) && (
														<button
															type="button"
															onClick={(e) => {
																e.preventDefault();
																e.stopPropagation();
																handleEdit(
																	coverFile,
																);
															}}
															className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors flex items-center gap-1"
														>
															Review & Amend
														</button>
													)}
											</div>
										</div>

										<p className="text-xs text-slate-500 mt-1">
											Click to replace
										</p>
										<button
											type="button"
											onClick={(e) => {
												e.preventDefault();
												e.stopPropagation();
												handlePreview(coverFile);
											}}
											className="mt-2 px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-md transition-colors flex items-center gap-1"
										>
											<Eye className="w-3 h-3" /> Preview
										</button>
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
							<div className="mt-3 flex justify-end">
								<button
									onClick={() => {
										if (coverFile) {
											bytesStoreRef.current.delete(coverFile.id);
											originalBytesStoreRef.current.delete(coverFile.id);
										}
										setCoverFile(null);
									}}
									className="text-sm text-red-500 hover:text-red-700 font-medium flex items-center gap-1"
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
								individualFiles.length === 0 || isGenerating
							}
							className="w-full py-3 px-4 bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
						>
							{isGenerating ? (
								<>
									<Loader2 className="w-5 h-5 animate-spin" />
									Generating...
								</>
							) : (
								<>
									Generate Submission
									<ArrowRight className="w-5 h-5" />
								</>
							)}
						</button>

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
												"Submission_Bundle.pdf",
											);
										}}
										className="flex-1 py-3 px-4 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
									>
										<Eye className="w-5 h-5" />
										Preview
									</button>
									<a
										href={generatedPdfUrl}
										download="Submission_Bundle.pdf"
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
