import React, { useState, useCallback, useRef, useEffect } from "react";
import { PDFDocument, rgb, StandardFonts, PageSizes } from "pdf-lib";
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
	RefreshCw,
	Layers,
} from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

import {
	DndContext,
	closestCenter,
	KeyboardSensor,
	PointerSensor,
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
	autoFixedSizes?: boolean;
}

interface TabInfo {
	tabNumber: number;
	fileName: string;
	pageNumber: number;
}

type PageModification =
	| { type: "rotate"; pageIndices: number[]; angle: number }
	| { type: "fitToA4"; pageIndices: number[] };

function getIssuesFromDoc(doc: PDFDocument): PageIssue[] {
	const pages = doc.getPages();
	const [A4_WIDTH, A4_HEIGHT] = PageSizes.A4;
	const issues: PageIssue[] = [];

	pages.forEach((page, index) => {
		const { width, height } = page.getSize();
		const rotation = page.getRotation();

		const effectiveWidth = rotation.angle % 180 === 0 ? width : height;
		const effectiveHeight = rotation.angle % 180 === 0 ? height : width;

		const isPortrait = effectiveHeight >= effectiveWidth;

		const isA4Dimensions =
			(Math.abs(width - A4_WIDTH) <= 5 &&
				Math.abs(height - A4_HEIGHT) <= 5) ||
			(Math.abs(width - A4_HEIGHT) <= 5 &&
				Math.abs(height - A4_WIDTH) <= 5);

		if (!isPortrait || !isA4Dimensions) {
			let type: "size" | "orientation" | "both" = "size";
			const parts = [];

			if (!isPortrait) {
				parts.push("Landscape");
				type = "orientation";
			}
			if (!isA4Dimensions) {
				parts.push("Non-A4 Size");
				type = "size";
			}
			if (!isPortrait && !isA4Dimensions) type = "both";

			issues.push({
				pageIndex: index,
				issueType: type,
				description: parts.join(", "),
			});
		}
	});

	return issues;
}

const PREVIEW_DEBOUNCE_MS = 120;

interface PageEditorModalProps {
	file: PdfFile;
	fileBytes: Uint8Array;
	onClose: () => void;
	onSave: (file: PdfFile, newBytes: Uint8Array) => void;
}

function PageEditorModal({
	file,
	fileBytes,
	onClose,
	onSave,
}: PageEditorModalProps) {
	const [selectedPageIndex, setSelectedPageIndex] = useState<number>(
		file.issues?.[0]?.pageIndex ?? 0,
	);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [isSaving, setIsSaving] = useState(false);
	const [isPreviewLoading, setIsPreviewLoading] = useState(true);
	const [applyToAll, setApplyToAll] = useState(false);
	const [modifications, setModifications] = useState<PageModification[]>([]);

	const workerRef = useRef<Worker | null>(null);
	const previewRequestIdRef = useRef(0);
	const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const previewUrlRef = useRef<string | null>(null);

	// Keep ref in sync for cleanup
	previewUrlRef.current = previewUrl;

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
				pageIndex: selectedPageIndex,
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
					pageIndex: selectedPageIndex,
					requestId,
				},
				[bytesCopy.buffer],
			);
		}
	}, [fileBytes, modifications, selectedPageIndex]);

	// Debounced preview: when page or modifications change, request after delay
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
	}, [selectedPageIndex, modifications, requestPreview]);

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
				const url = URL.createObjectURL(
					new Blob([e.data.bytes], { type: "application/pdf" }),
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

	const handleRotate = useCallback(
		(angle: number) => {
			const pageIndices = applyToAll
				? (file.issues?.map((issue) => issue.pageIndex) || [])
				: [selectedPageIndex];
			setModifications((prev) => [
				...prev,
				{ type: "rotate", pageIndices, angle },
			]);
		},
		[applyToAll, file.issues, selectedPageIndex],
	);

	const handleFitToA4 = useCallback(() => {
		const indicesToProcess = applyToAll
			? (file.issues?.map((issue) => issue.pageIndex) || [])
			: [selectedPageIndex];
		setModifications((prev) => [
			...prev,
			{ type: "fitToA4", pageIndices: indicesToProcess },
		]);
	}, [applyToAll, file.issues, selectedPageIndex]);

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
							Fix Issues: {file.name}
						</span>
					</h3>

					{/* Toolbar in Header */}
					<div className="flex items-center gap-2 mx-4">
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
							Pages with Issues
						</h4>
						<div className="space-y-2">
							{file.issues?.map((issue) => (
								<button
									key={issue.pageIndex}
									onClick={() =>
										setSelectedPageIndex(issue.pageIndex)
									}
									className={cn(
										"w-full text-left p-3 rounded-lg text-sm transition-colors border",
										selectedPageIndex === issue.pageIndex
											? "bg-indigo-50 border-indigo-200 text-indigo-700"
											: "bg-white border-slate-200 text-slate-600 hover:border-indigo-200",
									)}
								>
									<div className="font-medium mb-1">
										Page {issue.pageIndex + 1}
									</div>
									<div className="text-xs opacity-80">
										{issue.description}
									</div>
								</button>
							))}
							{(!file.issues || file.issues.length === 0) && (
								<div className="text-sm text-slate-500 italic">
									No issues detected.
								</div>
							)}
						</div>
					</div>

					{/* Main Preview Area */}
					<div className="flex-1 bg-slate-100 p-8 flex flex-col items-center overflow-y-auto">
						<div className="bg-white shadow-lg min-w-[500px] min-h-[400px] flex items-center justify-center">
							{isPreviewLoading || !previewUrl ? (
								<Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
							) : (
								<Document
									key={previewUrl}
									file={previewUrl}
									loading={
										<Loader2 className="w-8 h-8 animate-spin text-indigo-500 m-12" />
									}
									error={
										<div className="flex flex-col items-center justify-center h-64 text-red-500 p-4 text-center">
											<AlertTriangle className="w-8 h-8 mb-2" />
											<p>Failed to load preview.</p>
											<p className="text-xs mt-1">
												Try refreshing or selecting
												another page.
											</p>
										</div>
									}
								>
									<Page
										pageNumber={1}
										width={500}
										renderTextLayer={false}
										renderAnnotationLayer={false}
									/>
								</Document>
							)}
						</div>
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
						{file.autoFixedSizes && (
							<span className="flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200" title="Pages missing A4 size dimensions were automatically scaled to visually fit A4">
								<Check className="w-3 h-3" />
								Auto-Scaled to A4
							</span>
						)}
					</div>
				</div>
			</div>

			{file.issues && file.issues.length > 0 && (
				<button
					onClick={() => onEdit(file)}
					className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors flex items-center gap-1"
				>
					Fix Issues
				</button>
			)}

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

	const autoFixPdf = async (pdfBytes: Uint8Array): Promise<{ bytes: Uint8Array, issues: PageIssue[], autoFixedSizes: boolean }> => {
		try {
			const srcDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
			const initialIssues = getIssuesFromDoc(srcDoc);

			// Only auto-fix pages that have size issues
			const pagesToFix = initialIssues.filter(i => i.issueType === "size" || i.issueType === "both");

			if (pagesToFix.length > 0) {
				const [A4_WIDTH, A4_HEIGHT] = PageSizes.A4;
				const indicesToFix = new Set(pagesToFix.map(i => i.pageIndex));
				const pageCount = srcDoc.getPageCount();
				for (let i = 0; i < pageCount; i++) {
					if (indicesToFix.has(i)) {
						const page = srcDoc.getPage(i);
						const { width, height } = page.getSize();
						const rotation = page.getRotation();
						const effectiveWidth = rotation.angle % 180 === 0 ? width : height;
						const effectiveHeight = rotation.angle % 180 === 0 ? height : width;
						const isPortrait = effectiveHeight >= effectiveWidth;

						const targetW = isPortrait ? A4_WIDTH : A4_HEIGHT;
						const targetH = isPortrait ? A4_HEIGHT : A4_WIDTH;

						const scale = Math.min(targetW / width, targetH / height);
						const scaledWidth = width * scale;
						const scaledHeight = height * scale;
						const dx = (targetW - scaledWidth) / 2;
						const dy = (targetH - scaledHeight) / 2;

						page.setSize(targetW, targetH);
						page.translateContent(dx, dy);
						page.scaleContent(scale, scale);
					}
				}
				const newBytes = await srcDoc.save({ useObjectStreams: true, objectsPerTick: 100 });
				// Capture remaining issues (e.g. orientation) after resizing
				const remainingIssues = getIssuesFromDoc(srcDoc);
				return { bytes: newBytes, issues: remainingIssues, autoFixedSizes: true };
			}
			return { bytes: pdfBytes, issues: initialIssues, autoFixedSizes: false };
		} catch (error) {
			console.error("Error auto-fixing PDF:", error);
			// Fallback: return original bytes and issues if it fails
			const srcDocFallback = await PDFDocument.load(pdfBytes, { updateMetadata: false });
			return { bytes: pdfBytes, issues: getIssuesFromDoc(srcDocFallback), autoFixedSizes: false };
		}
	};

	const processCoverFile = async (file: File) => {
		if (file.type === "application/pdf") {
			const arrayBuffer = await file.arrayBuffer();
			const originalBytes = new Uint8Array(arrayBuffer);
			const { bytes: finalBytes, issues, autoFixedSizes } = await autoFixPdf(originalBytes);
			const id = crypto.randomUUID();

			bytesStoreRef.current.set(id, finalBytes);
			setCoverFile({
				id,
				name: file.name,
				file,
				issues: issues.length > 0 ? issues : undefined,
				autoFixedSizes,
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
				const { bytes: finalBytes, issues, autoFixedSizes } = await autoFixPdf(originalBytes);
				const id = crypto.randomUUID();

				bytesStoreRef.current.set(id, finalBytes);
				return {
					id,
					name: file.name,
					file,
					issues: issues.length > 0 ? issues : undefined,
					autoFixedSizes,
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
	};

	const copyPageNumbers = () => {
		const pageNumbers = tabInfo.map((info) => info.pageNumber).join("\n");
		navigator.clipboard.writeText(pageNumbers);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const removeIndividualFile = (id: string) => {
		bytesStoreRef.current.delete(id);
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
							This will be placed at the very beginning.
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
												{coverFile.autoFixedSizes && (
													<span className="flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200" title="Pages missing A4 size dimensions were automatically scaled to visually fit A4">
														<Check className="w-3 h-3" />
														Auto-Scaled to A4
													</span>
												)}
											</div>

											{coverFile.issues &&
												coverFile.issues.length > 0 && (
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
														Fix Issues
													</button>
												)}
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
									onClick={() => setCoverFile(null)}
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
							Drag to reorder.
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

			{editingFile && bytesStoreRef.current.get(editingFile.id) && (
				<PageEditorModal
					file={editingFile}
					fileBytes={bytesStoreRef.current.get(editingFile.id)!}
					onClose={() => setEditingFile(null)}
					onSave={handleSaveEdit}
				/>
			)}
		</div>
	);
}
