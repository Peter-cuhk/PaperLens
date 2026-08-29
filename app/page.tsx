"use client";

import {
  CheckOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  CommentOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  ExportOutlined,
  FilePdfOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  GithubOutlined,
  GlobalOutlined,
  HighlightOutlined,
  HomeOutlined,
  LeftOutlined,
  MessageOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
  SearchOutlined,
  SelectOutlined,
  SendOutlined,
  SettingOutlined,
  TranslationOutlined,
  UpOutlined,
  UploadOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import katex from "katex";
import { type ChangeEvent as ReactChangeEvent, type ClipboardEvent as ReactClipboardEvent, type FormEvent as ReactFormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isAbortError, runWithProviderRecovery } from "./ai-recovery";
import { ChatMarkdown } from "./chat-markdown";
import { findClosestPageToViewportCenter, shouldRenderPage } from "./continuous-scroll";
import { detectCaptionFigureRegions, refineFigureRegionsWithCanvas, type FigureRegion } from "./figure-regions";
import { buildFullTranslationQueue, mergeTranslationUsage } from "./full-translation";
import { findGitHubRepository } from "./github-repository";
import { eraseHighlightAtPoint, type EraserPoint } from "./highlight-eraser";
import { isCurrentDocumentGeneration, isImeCompositionEvent, normalizeCommittedPageInput } from "./interaction-guards";
import {
  buildPaperAliases,
  buildWholeDocumentChatContext,
  choosePaperDisplayName,
  getActivePaperMention,
  inferPaperTitle,
  isLowSignalPaperName,
  rankFolderPaperContexts,
  removeMentionQuery,
  repositoryAlias,
  searchMentionTargets,
  type MentionRange,
  type PaperPageText,
} from "./paper-mentions";
import { alignRenderedTextToSegments, mapPdfTextItemsToSegments, mergeAdjacentTextRects } from "./page-segment-geometry";
import { buildPageSegments, compatibleTranslationPages, isPageTranslationCompatible, type PageSegment, type PdfTextItem, type PdfViewport } from "./page-segmentation";
import { parsePaperTerms, type PaperTerm } from "./paper-terms";
import { buildDetectedPaperOutline, extractEmbeddedPaperOutline, selectMajorPaperOutline, type OutlineHeadingCandidate, type PaperOutlineItem } from "./paper-outline";
import { completeTranslationWithRepair, MAX_TRANSLATION_REPAIR_ATTEMPTS, TranslationRepairError } from "./translation-response";
import {
  DEFAULT_CHAT_HEIGHT,
  DEFAULT_PANEL_WIDTHS,
  MAX_LEFT_PANEL_WIDTH,
  MAX_RIGHT_PANEL_WIDTH,
  MIN_CHAT_HEIGHT,
  MIN_CENTER_PANEL_WIDTH,
  MIN_LEFT_PANEL_WIDTH,
  MIN_READER_CONTENT_HEIGHT,
  MIN_RIGHT_PANEL_WIDTH,
  PANEL_RESIZER_WIDTH,
  clampChatHeight,
  clampPanelWidths,
  parseReadingProgress,
  resizeChatHeight,
  resizePanelWidths,
  restoredReadingPage,
  writeReadingProgress,
  type PanelWidths,
  type ResizeSide,
} from "./reader-workspace";
import { mergeSelectionRects, normalizeSelectionRect, type SelectionRect } from "./selection-geometry";
import { createVisualPageSegment, isVisualPageSegments, shouldUseVisualPageTranslation, VISUAL_PAGE_SOURCE } from "./visual-page-translation";

type PdfTextContent = { items: PdfTextItem[]; styles?: Record<string, unknown>; lang?: string | null };
type PdfRenderTask = { promise: Promise<void>; cancel: () => void };
type PdfPage = {
  getViewport: (options: { scale: number }) => PdfViewport;
  getTextContent: () => Promise<PdfTextContent>;
  render: (options: { canvas: HTMLCanvasElement; viewport: PdfViewport; background?: string }) => PdfRenderTask;
};
type PdfOutlineNode = { title?: string; dest?: string | unknown[] | null; items?: PdfOutlineNode[] };
type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  getMetadata?: () => Promise<{ info?: Record<string, unknown> }>;
  getOutline?: () => Promise<PdfOutlineNode[] | null>;
  getDestination?: (id: string) => Promise<unknown[] | null>;
  getPageIndex?: (reference: { num: number; gen: number }) => Promise<number>;
  destroy: () => Promise<void>;
};
type RightTab = "translation" | "outline" | "terms" | "notes";
type MobileView = "paper" | "translation";
type AnnotationMode = "select" | "highlight" | "comment" | "erase";
type BridgeStatus = "checking" | "ready" | "offline";
type AIProviderId = "local-codex" | "chatgpt-web";
type AIUsage = { inputTokens: number; outputTokens: number; totalTokens: number; cachedTokens: number; reasoningTokens: number };
type CodexRateLimit = { id: string; name?: string | null; usedPercent?: number | null; remainingPercent?: number | null; windowDurationMins?: number | null; resetsAt?: number | null; reachedType?: string | null };
type ProviderInfo = {
  id: AIProviderId;
  label: string;
  configured: boolean;
  available: boolean;
  busy?: boolean;
  skillAvailable?: boolean;
  allowedModels?: string[];
  models?: { translation: string; chat: string };
  reasoningEffort?: string;
  pairingToken?: string;
  installation?: { installed: boolean; command?: string; version?: string };
  account?: { loggedIn: boolean; authMode?: string | null; email?: string | null; planType?: string | null; rateLimits?: CodexRateLimit[]; rateLimitReached?: boolean; limitedStatus?: boolean };
};
type ProviderMap = Partial<Record<AIProviderId, ProviderInfo>>;
type AISettings = { provider: AIProviderId; translationModel: string; chatModel: string; reasoningEffort: string };
type HighlightRect = { id: string; groupId: string; x: number; y: number; width: number; height: number; text: string };
type PendingSelection = {
  pageNumber: number;
  text: string;
  rects: SelectionRect[];
  x: number;
  y: number;
  segmentIds?: string[];
  primarySegmentId?: string;
};
type ChatMessage = { id: string; role: "user" | "assistant"; text: string; imageLabels?: string[]; paperLabels?: string[]; folderLabels?: string[]; repositoryUsed?: boolean; repositoryName?: string; providerLabel?: string; model?: string; usage?: AIUsage; latencyMs?: number; fallbackReason?: string };
type ChatImageAttachment = { id: string; label: string; source: "paper" | "clipboard"; dataUrl: string; pageNumber?: number };
type ChatPaperMention = { id: string; displayName: string; fileName: string; aliases: string[]; repositoryUrl?: string };
type ChatFolderMention = { id: string; name: string; paperIds: string[] };
type ChatContextKind = "paragraph" | "selection";
type SyncRect = { x: number; y: number; width: number; height: number };
type PaperComment = {
  id: string;
  pageNumber: number;
  segmentId?: string;
  selectedText: string;
  rects: SyncRect[];
  anchorX: number;
  anchorY: number;
  content: string;
  createdAt: number;
  updatedAt: number;
};
type CommentEditorState = {
  mode: "create" | "edit";
  commentId?: string;
  pageNumber: number;
  segmentId?: string;
  selectedText: string;
  rects: SyncRect[];
  anchorX: number;
  anchorY: number;
  content: string;
};
type TranslatedSegment = { id: string; translation: string; formulaExplanation: string };
type TranslationJob = "page" | "full";
type FullTranslationStatus = "idle" | "running" | "paused" | "failed" | "complete";
type OutlineStatus = "idle" | "loading" | "ready" | "failed";
type FullTranslationProgress = {
  status: FullTranslationStatus;
  completed: number;
  total: number;
  currentPage: number;
  failedPages: number[];
  failedReasons?: Record<number, string>;
  usage?: AIUsage;
  providerLabel?: string;
};
type AppView = "space" | "reader";
type SourceDocumentKind = "pdf" | "word" | "powerpoint";
type LibraryPaper = {
  id: string;
  fileName: string;
  sourceFileName?: string;
  sourceKind?: SourceDocumentKind;
  displayName: string;
  aliases?: string[];
  repositoryUrl?: string;
  importedAt: number;
  lastOpenedAt: number;
  lastModified: number;
  lastPage: number;
  pageCount: number;
  size: number;
  thumbnail: string;
  thumbnailPage?: number;
  folderId?: string;
};
type LibraryFolder = { id: string; name: string; createdAt: number; updatedAt: number };
type StoredPaper = LibraryPaper & {
  file: Blob;
  chatMessages?: ChatMessage[];
  chatMessagesUpdatedAt?: number;
  highlights?: Record<number, HighlightRect[]>;
  highlightsUpdatedAt?: number;
  translations?: Record<number, TranslatedSegment[]>;
  translationUpdatedAt?: number;
  terms?: Record<number, PaperTerm[]>;
  termsUpdatedAt?: number;
  notes?: Record<number, string>;
  notesUpdatedAt?: number;
  comments?: PaperComment[];
  commentsUpdatedAt?: number;
};
type LoadPdfOptions = { paperId?: string; skipPersist?: boolean; initialPage?: number; sourceFileName?: string; sourceKind?: SourceDocumentKind; folderId?: string; generation?: number };
type PageSize = { width: number; height: number };

// Keep the AI bridge loopback-only. The dev server proxies this same-origin path to the
// local bridge so an iPad can use PaperLens without exposing port 43123.
const CODEX_BRIDGE = "/api/codex";
const DOCUMENT_ACCEPT = [
  "application/pdf",
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
].join(",");
const LIBRARY_DB = "paperlens-local-library";
const LIBRARY_STORE = "papers";
const LIBRARY_FOLDER_STORE = "folders";
const AI_SETTINGS_KEY = "paperlens-ai-settings";
const CODEX_TUTORIAL_URL = "https://learn.chatgpt.com/docs/quickstart";
const READING_PROGRESS_KEY = "paperlens-reading-progress";
const READER_LAYOUT_KEY = "paperlens-reader-layout";
const MAX_PDF_CANVAS_EDGE = 4096;
const MAX_PDF_CANVAS_PIXELS = 16_000_000;
const DEFAULT_AI_SETTINGS: AISettings = {
  provider: "local-codex",
  translationModel: "gpt-5.6-terra",
  chatModel: "gpt-5.6-terra",
  reasoningEffort: "low",
};

function sourceDocumentKind(fileName: string, mimeType = ""): SourceDocumentKind | null {
  const extension = fileName.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  if (extension === ".pdf" || mimeType === "application/pdf") return "pdf";
  if ([".doc", ".docx"].includes(extension) || mimeType.includes("wordprocessingml") || mimeType === "application/msword") return "word";
  if ([".ppt", ".pptx"].includes(extension) || mimeType.includes("presentationml") || mimeType === "application/vnd.ms-powerpoint") return "powerpoint";
  return null;
}

function sourceKindLabel(kind: SourceDocumentKind) {
  if (kind === "word") return "Word";
  if (kind === "powerpoint") return "PowerPoint";
  return "PDF";
}

async function convertDocumentToPdf(file: File) {
  let response: Response;
  try {
    response = await fetch(`${CODEX_BRIDGE}/convert-document`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-paperlens-file-name": encodeURIComponent(file.name),
      },
      body: file,
    });
  } catch {
    throw new Error("本机文档转换服务未启动，请用 npm run dev 启动 PaperLens");
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error || "Word/PPT 转 PDF 失败");
  }
  const pdf = await response.blob();
  const convertedName = `${file.name.replace(/\.(?:docx?|pptx?)$/i, "")}.pdf`;
  return new File([pdf], convertedName, { type: "application/pdf", lastModified: file.lastModified });
}

function getPdfOutputScale(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  const deviceScale = Math.max(1, window.devicePixelRatio || 1);
  const edgeScale = Math.min(MAX_PDF_CANVAS_EDGE / width, MAX_PDF_CANVAS_EDGE / height);
  const areaScale = Math.sqrt(MAX_PDF_CANVAS_PIXELS / (width * height));
  return Math.max(1, Math.min(deviceScale, 2.5, edgeScale, areaScale));
}

function openLibraryDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(LIBRARY_DB, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LIBRARY_STORE)) {
        database.createObjectStore(LIBRARY_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(LIBRARY_FOLDER_STORE)) {
        database.createObjectStore(LIBRARY_FOLDER_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地资料库"));
  });
}

async function listStoredFolders() {
  const database = await openLibraryDatabase();
  return new Promise<LibraryFolder[]>((resolve, reject) => {
    const transaction = database.transaction(LIBRARY_FOLDER_STORE, "readonly");
    const request = transaction.objectStore(LIBRARY_FOLDER_STORE).getAll();
    request.onsuccess = () => resolve((request.result as LibraryFolder[]).sort((a, b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error || new Error("无法读取文件夹"));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("无法读取文件夹"));
    };
  });
}

async function putStoredFolder(folder: LibraryFolder) {
  const database = await openLibraryDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(LIBRARY_FOLDER_STORE, "readwrite");
    transaction.objectStore(LIBRARY_FOLDER_STORE).put(folder);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("无法保存文件夹"));
    };
  });
}

async function deleteStoredFolder(folderId: string) {
  const database = await openLibraryDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([LIBRARY_FOLDER_STORE, LIBRARY_STORE], "readwrite");
    transaction.objectStore(LIBRARY_FOLDER_STORE).delete(folderId);
    const paperStore = transaction.objectStore(LIBRARY_STORE);
    const request = paperStore.getAll();
    request.onsuccess = () => {
      (request.result as StoredPaper[]).forEach((paper) => {
        if (paper.folderId === folderId) paperStore.put({ ...paper, folderId: undefined });
      });
    };
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("无法删除文件夹"));
    };
  });
}

async function listStoredPapers() {
  const database = await openLibraryDatabase();
  return new Promise<StoredPaper[]>((resolve, reject) => {
    const transaction = database.transaction(LIBRARY_STORE, "readonly");
    const request = transaction.objectStore(LIBRARY_STORE).getAll();
    request.onsuccess = () => resolve((request.result as StoredPaper[]).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt));
    request.onerror = () => reject(request.error || new Error("无法读取本地资料库"));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("无法读取本地资料库"));
    };
  });
}

async function getStoredPaper(id: string) {
  const database = await openLibraryDatabase();
  return new Promise<StoredPaper | undefined>((resolve, reject) => {
    const transaction = database.transaction(LIBRARY_STORE, "readonly");
    const request = transaction.objectStore(LIBRARY_STORE).get(id);
    request.onsuccess = () => resolve(request.result as StoredPaper | undefined);
    request.onerror = () => reject(request.error || new Error("无法打开这份资料"));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("无法打开这份资料"));
    };
  });
}

async function putStoredPaper(paper: StoredPaper) {
  const database = await openLibraryDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(LIBRARY_STORE, "readwrite");
    transaction.objectStore(LIBRARY_STORE).put(paper);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("无法保存资料"));
    };
  });
}

async function updateStoredPaper(id: string, patch: Partial<Omit<StoredPaper, "id" | "file">>) {
  const database = await openLibraryDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(LIBRARY_STORE, "readwrite");
    const store = transaction.objectStore(LIBRARY_STORE);
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as StoredPaper | undefined;
      if (current) store.put({ ...current, ...patch });
    };
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("无法更新资料数据"));
    };
  });
}

async function deleteStoredPaper(id: string) {
  const database = await openLibraryDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(LIBRARY_STORE, "readwrite");
    transaction.objectStore(LIBRARY_STORE).delete(id);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("无法删除资料"));
    };
  });
}

async function createPdfThumbnail(pdf: PdfDocument, pageNumber = 1) {
  const page = await pdf.getPage(Math.min(pdf.numPages, Math.max(1, pageNumber)));
  const baseViewport = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(1, 360 / baseViewport.width) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  await page.render({ canvas, viewport, background: "#ffffff" }).promise;
  return canvas.toDataURL("image/jpeg", .84);
}

async function renderPdfPageForVision(page: PdfPage, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, 1800 / Math.max(baseViewport.width, baseViewport.height));
  const viewport = page.getViewport({ scale: Math.max(1, scale) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const renderTask = page.render({ canvas, viewport, background: "#ffffff" });
  const abort = () => renderTask.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await renderTask.promise;
  } catch (error) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return canvas.toDataURL("image/jpeg", .9);
}

async function inspectPdfIdentity(pdf: PdfDocument, fileName: string, existing?: StoredPaper) {
  let metadataTitle = "";
  try {
    const metadata = await pdf.getMetadata?.();
    metadataTitle = typeof metadata?.info?.Title === "string" ? metadata.info.Title : "";
  } catch (error) {
    console.error("PDF metadata read failed", error);
  }

  let firstPageItems: PdfTextItem[] = [];
  let repositoryUrl = existing?.repositoryUrl || "";
  for (let candidatePage = 1; candidatePage <= Math.min(pdf.numPages, 4); candidatePage += 1) {
    try {
      const page = await pdf.getPage(candidatePage);
      const content = await page.getTextContent();
      if (candidatePage === 1) firstPageItems = content.items;
      if (!repositoryUrl) repositoryUrl = findGitHubRepository(content.items.map((item) => item.str || "").join(" "));
    } catch (error) {
      console.error(`PDF identity scan failed on page ${candidatePage}`, error);
    }
  }

  const inferredTitle = inferPaperTitle(firstPageItems, fileName, metadataTitle);
  const displayName = choosePaperDisplayName(inferredTitle, fileName, existing?.displayName);
  const aliases = buildPaperAliases([
    displayName,
    inferredTitle,
    fileName,
    ...(existing?.aliases || []),
    repositoryAlias(repositoryUrl),
  ]);
  return { displayName, aliases, repositoryUrl };
}

function formatLibraryDate(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("无法读取图片"));
    reader.onerror = () => reject(reader.error || new Error("无法读取图片"));
    reader.readAsDataURL(file);
  });
}

async function normalizePastedImage(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("剪贴板中没有可用图片");
  if (file.size > 10 * 1024 * 1024) throw new Error("单张图片不能超过 10 MB");
  const original = await readFileAsDataUrl(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("无法解析粘贴的图片"));
    element.src = original;
  });
  const maxEdge = 1800;
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法处理这张图片");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

const SCIENTIFIC_TOKEN_SOURCE = String.raw`(\[\[SOURCE_FORMULA\]\])|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|\$([^$\n]+?)\$`;

function ScientificText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const scientificToken = new RegExp(SCIENTIFIC_TOKEN_SOURCE, "g");
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = scientificToken.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    if (match[1]) {
      parts.push(<span className="formula-source-fallback" key={`source-${match.index}`}>公式以左侧原文为准</span>);
    } else {
      const latex = match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
      const displayMode = match[2] !== undefined || match[3] !== undefined;
      let html = "";
      try {
        html = katex.renderToString(latex, {
          displayMode,
          throwOnError: true,
          strict: "ignore",
          output: "htmlAndMathml",
        });
      } catch {
        html = "";
      }
      if (html) {
        parts.push(<span className={displayMode ? "translated-math display" : "translated-math"} key={`math-${match.index}`} dangerouslySetInnerHTML={{ __html: html }} />);
      } else {
        parts.push(<span className="formula-source-fallback" key={`invalid-${match.index}`}>公式渲染失败，请看左侧原文</span>);
      }
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function paddedSyncRect(rect: SyncRect): SyncRect {
  const paddingX = .0025;
  const paddingY = .0015;
  const x = Math.max(0, rect.x - paddingX);
  const y = Math.max(0, rect.y - paddingY);
  return {
    x,
    y,
    width: Math.min(1 - x, rect.width + paddingX * 2),
    height: Math.min(1 - y, rect.height + paddingY * 2),
  };
}

function SegmentOverlay({ segment, label, tone }: { segment: PageSegment; label: string; tone: "preview" | "context" }) {
  const rects = mergeAdjacentTextRects(segment.rects).map(paddedSyncRect);
  return (
    <>
      {rects.map((rect, index) => (
        <span
          key={`${segment.id}-${index}`}
          className={`sync-segment-box ${tone} ${rect.y < .03 ? "label-below" : ""}`}
          style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
        >
          {index === 0 && <i>{label}</i>}
        </span>
      ))}
    </>
  );
}

function segmentBounds(segment: PageSegment): SyncRect | null {
  if (!segment.rects.length) return null;
  const left = Math.min(...segment.rects.map((rect) => rect.x));
  const top = Math.min(...segment.rects.map((rect) => rect.y));
  const right = Math.max(...segment.rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...segment.rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function isCommentableSegment(segment: PageSegment) {
  const text = segment.text.replace(/\s+/g, " ").trim();
  if (text.length >= 24) return true;
  return segment.kind === "heading" && text.length >= 4 && /[A-Za-z\u4e00-\u9fff]{3}/.test(text);
}

function repositoryName(url: string) {
  return url.replace(/^https?:\/\/(?:www\.)?github\.com\//i, "").replace(/\/$/, "");
}

async function invokeAI(payload: Record<string, unknown>, settings: AISettings, signal?: AbortSignal) {
  const response = await fetch(`${CODEX_BRIDGE}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, ...settings }),
    signal,
  });
  const result = await response.json() as {
    answer?: string;
    error?: string;
    code?: string;
    repositoryUsed?: boolean;
    repositoryDecision?: string;
    provider?: AIProviderId;
    model?: string;
    usage?: AIUsage;
    latencyMs?: number;
    fallbackReason?: string;
  };
  if (!response.ok || !result.answer) throw new Error(result.error || "AI 服务调用失败");
  return {
    answer: result.answer,
    repositoryUsed: result.repositoryUsed,
    repositoryDecision: result.repositoryDecision,
    provider: result.provider || settings.provider,
    model: result.model,
    usage: result.usage,
    latencyMs: result.latencyMs,
    fallbackReason: result.fallbackReason,
  };
}

function providerDisplayName(provider: AIProviderId) {
  if (provider === "chatgpt-web") return "ChatGPT 网页 Chat";
  return "本机 Codex";
}

function usageSummary(usage?: AIUsage) {
  if (!usage) return "";
  return `${usage.totalTokens.toLocaleString("zh-CN")} tokens（输入 ${usage.inputTokens.toLocaleString("zh-CN")} / 输出 ${usage.outputTokens.toLocaleString("zh-CN")}）`;
}

function AISettingsModal({
  settings,
  providers,
  bridgeStatus,
  skillAvailable,
  testStatus,
  extensionStoreUrl,
  onSettingsChange,
  onClose,
  onRefresh,
  onTest,
  onCodexLogin,
  onCodexLogout,
  onOpenExtensionSetup,
}: {
  settings: AISettings;
  providers: ProviderMap;
  bridgeStatus: BridgeStatus;
  skillAvailable: boolean;
  testStatus: string;
  extensionStoreUrl: string;
  onSettingsChange: (settings: AISettings) => void;
  onClose: () => void;
  onRefresh: () => void;
  onTest: () => void;
  onCodexLogin: () => void;
  onCodexLogout: () => void;
  onOpenExtensionSetup: () => void;
}) {
  const selected = providers[settings.provider];
  const status = bridgeStatus === "checking" ? "checking" : bridgeStatus === "offline" || !selected?.available ? "offline" : "ready";
  const codex = providers["local-codex"];
  const codexInstalled = Boolean(codex?.installation?.installed);
  const codexLoggedIn = Boolean(codex?.account?.loggedIn);
  const codexRates = codex?.account?.rateLimits || [];
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal ai-settings-modal" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="关闭"><CloseOutlined /></button>
        <h2 id="ai-settings-title">本地 AI 接入</h2>
        <p>PaperLens 本地版只连接本机 Codex，或你浏览器里可见的 ChatGPT Chat；不接收 API Key，也没有余额、充值或支付入口。</p>
        <div className="provider-options" role="radiogroup" aria-label="AI Provider">
          {(["local-codex", "chatgpt-web"] as AIProviderId[]).map((providerId) => {
            const info = providers[providerId];
            const active = settings.provider === providerId;
            return (
              <button key={providerId} type="button" role="radio" aria-checked={active} className={`provider-option ${active ? "active" : ""}`} onClick={() => onSettingsChange({
                ...settings,
                provider: providerId,
                ...(providerId === "chatgpt-web" ? { translationModel: "chatgpt-web", chatModel: "chatgpt-web" } : {}),
              })}>
                <span><RobotOutlined /></span>
                <div><strong>{providerId === "local-codex" ? "本机 Codex" : "ChatGPT 网页 Chat"}</strong><small>{info?.available ? "可用" : providerId === "chatgpt-web" ? "扩展或网页账号未连接" : !info?.installation?.installed ? "Codex CLI 未安装" : !info?.account?.loggedIn ? "Codex 已安装，账号未登录" : "当前额度窗口不可用"}</small></div>
                <i>{active ? <CheckOutlined /> : null}</i>
              </button>
            );
          })}
        </div>
        <div className={`codex-connection-card ${status}`}>
          <RobotOutlined />
          <div>
            <strong>{status === "ready" ? `${selected?.label || "AI 服务"} 已就绪` : status === "checking" ? "正在检测…" : settings.provider === "chatgpt-web" ? "ChatGPT 网页 Chat 尚未连接" : !codexInstalled ? "Codex CLI 尚未安装" : !codexLoggedIn ? "Codex 账号尚未连接" : "Codex 当前额度窗口不可用"}</strong>
            <span>{status === "ready" ? settings.provider === "local-codex" ? `${codex?.account?.email || "ChatGPT 账号"}${codex?.account?.planType ? ` · ${codex.account.planType}` : ""} · Paper Reader Skill ${skillAvailable ? "已安装" : "未检测到"}` : "问答、翻译和术语都通过你当前可见的 ChatGPT Chat 页面完成" : settings.provider === "chatgpt-web" ? "优先安装 Chrome Web Store 版本；GitHub 版本可用本地扩展安装向导" : !codexInstalled ? "在仓库目录运行 npm run setup，可安装依赖并检查 Codex" : "点击下方按钮，用 ChatGPT 账号连接本机 Codex"}</span>
            {settings.provider === "local-codex" && codexRates.length > 0 ? <span className="codex-rate-limits">{codexRates.map((rate) => `${rate.name || rate.id}：剩余 ${rate.remainingPercent ?? "未知"}%${rate.resetsAt ? `，${new Date(rate.resetsAt * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 重置` : ""}`).join(" · ")}</span> : null}
            <span className="connection-inline-actions">
              {settings.provider === "local-codex" && codexInstalled && !codexLoggedIn ? <button className="plain-button" onClick={onCodexLogin}>连接 ChatGPT 账号</button> : null}
              {settings.provider === "local-codex" && codexLoggedIn ? <button className="plain-button" onClick={onCodexLogout}>退出 Codex 账号</button> : null}
              {settings.provider === "chatgpt-web" && extensionStoreUrl ? <a className="plain-button" href={extensionStoreUrl} target="_blank" rel="noreferrer">从 Chrome 商店安装</a> : null}
              {settings.provider === "chatgpt-web" ? <button className="plain-button" onClick={onOpenExtensionSetup}>打开 GitHub 版安装向导</button> : null}
            </span>
          </div>
        </div>
        {testStatus && <div className="provider-test-status" role="status">{testStatus}</div>}
        <div className="modal-actions"><a className="plain-button tutorial-link" href={CODEX_TUTORIAL_URL} target="_blank" rel="noreferrer" aria-label="在新标签页打开 OpenAI Codex 使用教程">Codex 使用教程 <ExportOutlined /></a><button className="plain-button" onClick={onClose}>关闭</button><button className="plain-button" onClick={onRefresh}>刷新状态</button><button className="primary-button" onClick={onTest}>测试当前服务</button></div>
        <small>AI 任务执行异常时会在当前接入内自动重试，修复仍失败才会显示最终错误；ChatGPT 网页模式的问答、翻译和术语不会暗中切换到其他服务。Chrome 官方不允许 macOS/Windows 从 GitHub 静默安装本地 CRX；商店版是首选，GitHub unpacked 版需要在开发者模式中确认一次。扩展只操作可见页面，不读取 Cookie、密码或浏览器存储。</small>
      </section>
    </div>
  );
}

function PdfPageView({
  pdf,
  pageNumber,
  displayWidth,
  pageSize,
  renderContent,
  isActive,
  segments,
  highlights,
  comments,
  commentEditor,
  figures,
  activeSegmentId,
  contextSegmentId,
  contextSegmentIds,
  contextKind,
  selectionContextRects,
  pendingSelection,
  annotationMode,
  hoveredFigureId,
  onRegisterFrame,
  onPageSize,
  onPageParsed,
  onStatus,
  onPaperSelection,
  onSelectionStart,
  onSourceHover,
  onSourceLeave,
  onSourceClick,
  onEraseHighlights,
  onFigureHover,
  onAddFigure,
  onAskSelection,
  onHighlightSelection,
  onStartComment,
  onEditComment,
  onCommentEditorChange,
  onSaveComment,
  onCancelComment,
  onDeleteComment,
}: {
  pdf: PdfDocument;
  pageNumber: number;
  displayWidth: number;
  pageSize: PageSize;
  renderContent: boolean;
  isActive: boolean;
  segments: PageSegment[];
  highlights: HighlightRect[];
  comments: PaperComment[];
  commentEditor: CommentEditorState | null;
  figures: FigureRegion[];
  activeSegmentId: string;
  contextSegmentId: string;
  contextSegmentIds: string[];
  contextKind: ChatContextKind | null;
  selectionContextRects: SyncRect[];
  pendingSelection: PendingSelection | null;
  annotationMode: AnnotationMode;
  hoveredFigureId: string;
  onRegisterFrame: (pageNumber: number, frame: HTMLElement | null) => void;
  onPageSize: (pageNumber: number, size: PageSize) => void;
  onPageParsed: (pageNumber: number, result: { segments: PageSegment[]; figures: FigureRegion[]; text: string }) => void;
  onStatus: (pageNumber: number, message: string) => void;
  onPaperSelection: (pageNumber: number, frame: HTMLElement) => void;
  onSelectionStart: () => void;
  onSourceHover: (pageNumber: number, event: ReactMouseEvent<HTMLDivElement>) => void;
  onSourceLeave: () => void;
  onSourceClick: (pageNumber: number, event: ReactMouseEvent<HTMLDivElement>) => void;
  onEraseHighlights: (pageNumber: number, samples: EraserPoint[], radiusX: number, radiusY: number, eraseId: string) => void;
  onFigureHover: (figureId: string) => void;
  onAddFigure: (pageNumber: number, figure: FigureRegion) => void;
  onAskSelection: (selection: PendingSelection) => void;
  onHighlightSelection: (selection: PendingSelection) => void;
  onStartComment: (selection: PendingSelection) => void;
  onEditComment: (comment: PaperComment) => void;
  onCommentEditorChange: (content: string) => void;
  onSaveComment: () => void;
  onCancelComment: () => void;
  onDeleteComment: (commentId: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerHostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLElement>(null);
  const pageRef = useRef<PdfPage | null>(null);
  const contentRef = useRef<PdfTextContent | null>(null);
  const renderSequenceRef = useRef(0);
  const parsedRef = useRef(false);
  const registerFrame = useCallback((frame: HTMLElement | null) => {
    frameRef.current = frame;
    onRegisterFrame(pageNumber, frame);
  }, [onRegisterFrame, pageNumber]);

  useEffect(() => {
    parsedRef.current = false;
    pageRef.current = null;
    contentRef.current = null;
  }, [pdf, pageNumber]);

  useEffect(() => {
    if (!renderContent) return;
    const sequence = ++renderSequenceRef.current;
    let cancelled = false;
    let renderTask: PdfRenderTask | null = null;
    let textLayerBuilder: {
      cancel: () => void;
      div: HTMLDivElement;
      render: (options: { viewport: never; images: never }) => Promise<void>;
    } | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const render = async () => {
      const page = pageRef.current || await pdf.getPage(pageNumber);
      pageRef.current = page;
      if (cancelled || sequence !== renderSequenceRef.current) return;

      const baseViewport = page.getViewport({ scale: 1 });
      const displayViewport = page.getViewport({ scale: 1.45 });
      onPageSize(pageNumber, { width: displayViewport.width, height: displayViewport.height });
      const logicalScale = displayWidth / baseViewport.width;
      const logicalViewport = page.getViewport({ scale: logicalScale });
      const outputScale = getPdfOutputScale(logicalViewport.width, logicalViewport.height);
      const renderViewport = page.getViewport({ scale: logicalScale * outputScale });
      const canvas = canvasRef.current;
      const textLayerHost = textLayerHostRef.current;
      const frame = frameRef.current;
      if (!canvas || !textLayerHost || !frame || cancelled) return;

      canvas.width = Math.max(1, Math.round(renderViewport.width));
      canvas.height = Math.max(1, Math.round(renderViewport.height));
      canvas.dataset.outputScale = outputScale.toFixed(3);

      renderTask = page.render({ canvas, viewport: renderViewport, background: "#ffffff" });
      await renderTask.promise;
      if (cancelled || sequence !== renderSequenceRef.current) return;
      onStatus(pageNumber, `第 ${pageNumber} 页已显示，正在解析文字…`);

      let content = contentRef.current;
      if (!content) {
        try {
          content = await page.getTextContent();
          contentRef.current = content;
        } catch (error) {
          console.error("PDF text extraction failed", error);
          onStatus(pageNumber, `第 ${pageNumber} 页已显示，但文字层无法提取`);
          return;
        }
      }
      if (cancelled || sequence !== renderSequenceRef.current) return;

      const { TextLayerBuilder } = await import("pdfjs-dist/web/pdf_viewer.mjs");
      textLayerHost.replaceChildren();
      textLayerBuilder = new TextLayerBuilder({
        pdfPage: page as never,
        onAppend: (layer: HTMLDivElement) => {
          layer.classList.add("pdf-text-layer");
          textLayerHost.replaceChildren(layer);
        },
      });
      await textLayerBuilder.render({ viewport: logicalViewport as never, images: undefined as never });
      if (cancelled || sequence !== renderSequenceRef.current) return;
      const textLayer = textLayerBuilder.div;
      // PDF.js replaces the explicit dimensions with a CSS `round()` formula.
      // Without its full viewer variable set that formula collapses the layer
      // width to zero, so the visible text spans cannot receive pointer events.
      textLayer.style.width = `${logicalViewport.width}px`;
      textLayer.style.height = `${logicalViewport.height}px`;
      const syncTextLayer = () => {
        const displayScale = frame.clientWidth / logicalViewport.width;
        textLayer.style.transform = `scale(${displayScale})`;
      };
      syncTextLayer();
      resizeObserver = new ResizeObserver(syncTextLayer);
      resizeObserver.observe(frame);

      const roughFigures = detectCaptionFigureRegions(content.items, baseViewport, pageNumber);
      const nextFigures = refineFigureRegionsWithCanvas(roughFigures, canvas);
      const nextSegments = buildPageSegments(content.items, baseViewport, pageNumber, nextFigures);
      const textSpans = Array.from(textLayer.querySelectorAll<HTMLElement>("span"))
        .filter((span) => !span.querySelector("span") && Boolean(span.textContent?.trim()));
      const itemOwners = mapPdfTextItemsToSegments(content.items, nextSegments, baseViewport.width, baseViewport.height);
      const segmentIds = alignRenderedTextToSegments(textSpans.map((span) => span.textContent || ""), itemOwners);
      textSpans.forEach((span, index) => {
        const segmentId = segmentIds[index];
        if (segmentId) span.dataset.segmentId = segmentId;
      });

      if (!parsedRef.current) {
        const text = nextSegments.map((segment) => segment.text).join("\n\n").trim().slice(0, 28_000);
        parsedRef.current = true;
        onPageParsed(pageNumber, { segments: nextSegments, figures: nextFigures, text });
        onStatus(pageNumber, nextFigures.length ? `第 ${pageNumber} 页已解析，检测到 ${nextFigures.length} 张可引用图` : `第 ${pageNumber} 页已解析，可选择文字提问`);
      }
    };

    void render().catch((error: unknown) => {
      if (cancelled || (error instanceof Error && error.name === "RenderingCancelledException")) return;
      console.error(`PDF page ${pageNumber} render failed`, error);
      onStatus(pageNumber, `第 ${pageNumber} 页渲染失败，请重试`);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayerBuilder?.cancel();
      resizeObserver?.disconnect();
    };
  }, [displayWidth, onPageParsed, onPageSize, onStatus, pageNumber, pdf, renderContent]);

  const activeSegment = segments.find((segment) => segment.id === activeSegmentId) || null;
  const contextSegment = segments.find((segment) => segment.id === contextSegmentId) || null;
  const pageHeight = displayWidth * pageSize.height / pageSize.width;
  const editorLeft = commentEditor
    ? Math.min(Math.max(8, displayWidth - 288), Math.max(8, commentEditor.anchorX * displayWidth - 246))
    : 8;
  const editorTop = commentEditor
    ? Math.min(Math.max(8, pageHeight - 218), Math.max(8, commentEditor.anchorY * pageHeight + 10))
    : 8;
  const erasingPointerRef = useRef<number | null>(null);
  const eraserLastPointRef = useRef<{ x: number; y: number; pixelX: number; pixelY: number } | null>(null);
  const eraserStrokeIdRef = useRef(0);
  const activeEraserIdRef = useRef("");

  const eraserPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
      pixelX: event.clientX - bounds.left,
      pixelY: event.clientY - bounds.top,
    };
  };

  const eraseToPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const next = eraserPoint(event);
    const previous = eraserLastPointRef.current || next;
    const distance = Math.hypot(next.pixelX - previous.pixelX, next.pixelY - previous.pixelY);
    const steps = Math.max(1, Math.ceil(distance / 5));
    const samples = Array.from({ length: steps }, (_, index) => {
      const progress = (index + 1) / steps;
      return {
        x: previous.x + (next.x - previous.x) * progress,
        y: previous.y + (next.y - previous.y) * progress,
      };
    });
    eraserLastPointRef.current = next;
    onEraseHighlights(pageNumber, samples, 7 / displayWidth, 7 / pageHeight, activeEraserIdRef.current);
  };

  const startErasing = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (annotationMode !== "erase") return;
    event.preventDefault();
    erasingPointerRef.current = event.pointerId;
    eraserLastPointRef.current = null;
    activeEraserIdRef.current = `${Date.now()}-${++eraserStrokeIdRef.current}`;
    event.currentTarget.setPointerCapture(event.pointerId);
    eraseToPoint(event);
  };

  const moveEraser = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (annotationMode !== "erase" || erasingPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    eraseToPoint(event);
  };

  const stopErasing = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (erasingPointerRef.current !== event.pointerId) return;
    erasingPointerRef.current = null;
    eraserLastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <article
      ref={registerFrame}
      className={`paper-frame pdf-page ${isActive ? "active" : ""}`}
      data-page-number={pageNumber}
      aria-label={`资料第 ${pageNumber} 页`}
      style={{ width: displayWidth, aspectRatio: `${pageSize.width}/${pageSize.height}` }}
      onPointerUp={(event) => onPaperSelection(pageNumber, event.currentTarget)}
    >
      {renderContent ? (
        <>
          <canvas ref={canvasRef} className="pdf-canvas" />
          <div className="sync-highlight-layer" aria-hidden="true">
            {isActive && contextKind === "selection" && selectionContextRects.map((rect, index) => (
              <span key={`${rect.x}-${rect.y}-${index}`} className={`sync-selection-line context ${index === 0 && rect.y < .03 ? "label-below" : ""}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}>
                {index === 0 && <i>选区上下文</i>}
              </span>
            ))}
            {contextSegment && contextKind !== "selection" && activeSegment?.id !== contextSegment.id && <SegmentOverlay segment={contextSegment} label="整段上下文" tone="context" />}
            {activeSegment && !(contextKind === "selection" && contextSegmentIds.includes(activeSegment.id)) && <SegmentOverlay segment={activeSegment} label={activeSegment.id === contextSegment?.id ? contextKind === "selection" ? "选区上下文" : "整段上下文" : "对应译文"} tone={activeSegment.id === contextSegment?.id ? "context" : "preview"} />}
          </div>
          <div
            className="highlight-layer"
            aria-label={`第 ${pageNumber} 页资料标亮`}
            onPointerDown={startErasing}
            onPointerMove={moveEraser}
            onPointerUp={stopErasing}
            onPointerCancel={stopErasing}
          >
            {highlights.map((highlight) => (
              <span
                key={highlight.id}
                title={annotationMode === "erase" ? "按住拖动，局部擦除标亮" : highlight.text}
                className="highlight-mark"
                data-highlight-id={highlight.id}
                style={{ left: `${highlight.x * 100}%`, top: `${highlight.y * 100}%`, width: `${highlight.width * 100}%`, height: `${highlight.height * 100}%` }}
              />
            ))}
          </div>
          <div className="comment-layer" aria-label={`第 ${pageNumber} 页批注`}>
            {comments.map((comment) => (
              <div className="comment-anchor-group" key={comment.id}>
                {comment.rects.map((rect, index) => (
                  <span
                    className="comment-anchor-mark"
                    key={`${comment.id}-${index}`}
                    style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
                  />
                ))}
                <button
                  type="button"
                  className={`comment-pin ${commentEditor?.commentId === comment.id ? "active" : ""}`}
                  style={{ left: `${comment.anchorX * 100}%`, top: `${comment.anchorY * 100}%` }}
                  title={comment.content}
                  aria-label={`查看批注：${comment.content}`}
                  onClick={(event) => { event.stopPropagation(); onEditComment(comment); }}
                >
                  <CommentOutlined />
                </button>
              </div>
            ))}
          </div>
          <div
            ref={textLayerHostRef}
            className="pdf-text-layer-host"
            onMouseDown={annotationMode === "erase" ? undefined : onSelectionStart}
            onMouseMove={(event) => onSourceHover(pageNumber, event)}
            onMouseLeave={onSourceLeave}
            onClick={(event) => onSourceClick(pageNumber, event)}
          />
          {annotationMode === "comment" && (
            <div className="comment-target-layer" aria-label={`第 ${pageNumber} 页可评论段落`}>
              {segments.filter(isCommentableSegment).map((segment) => {
                const bounds = segmentBounds(segment);
                if (!bounds) return null;
                const existingComment = comments.find((comment) => comment.segmentId === segment.id);
                return (
                  <button
                    key={segment.id}
                    type="button"
                    className={`comment-target ${existingComment ? "has-comment" : ""}`}
                    style={{ left: `${bounds.x * 100}%`, top: `${bounds.y * 100}%`, width: `${bounds.width * 100}%`, height: `${bounds.height * 100}%` }}
                    aria-label={existingComment ? `编辑这一段的评论：${existingComment.content}` : `评论这一段：${segment.text.slice(0, 80)}`}
                    title={existingComment ? "点击编辑这一段的评论" : "点击评论这一段"}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (existingComment) {
                        onEditComment(existingComment);
                        return;
                      }
                      const rects = mergeAdjacentTextRects(segment.rects);
                      onStartComment({
                        pageNumber,
                        text: segment.text.slice(0, 6_000),
                        rects: rects.map((rect) => ({ ...rect, text: segment.text })),
                        x: 0,
                        y: 0,
                        segmentIds: [segment.id],
                        primarySegmentId: segment.id,
                      });
                    }}
                  >
                    <span>{existingComment ? "编辑评论" : "点击评论"}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="figure-region-layer" aria-label={`第 ${pageNumber} 页资料图片区域`}>
            {figures.map((figure) => (
              <button
                key={figure.id}
                type="button"
                className={`figure-region-target ${figure.rect.y < .035 ? "label-inside" : "label-above"} ${hoveredFigureId === figure.id ? "active" : ""}`}
                style={{ left: `${figure.rect.x * 100}%`, top: `${figure.rect.y * 100}%`, width: `${figure.rect.width * 100}%`, height: `${figure.rect.height * 100}%` }}
                aria-label={`将 ${figure.label} 加入 AI Chat`}
                title={`${figure.label}：点击截取整图并加入 AI Chat`}
                onMouseEnter={() => onFigureHover(figure.id)}
                onMouseLeave={() => onFigureHover("")}
                onClick={(event) => { event.stopPropagation(); onAddFigure(pageNumber, figure); }}
              >
                <span><b><PictureOutlined /> {figure.label}</b><em>加入 AI Chat</em></span>
              </button>
            ))}
          </div>
          {pendingSelection?.pageNumber === pageNumber && (
            <div
              className="selection-bubble"
              style={{ left: pendingSelection.x, top: pendingSelection.y }}
              onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onPointerUp={(event) => event.stopPropagation()}
            >
              <button onClick={() => onAskSelection(pendingSelection)}><MessageOutlined /> 问 AI</button>
              <button onClick={() => onHighlightSelection(pendingSelection)}><HighlightOutlined /> 标亮</button>
              <button onClick={() => onStartComment(pendingSelection)}><CommentOutlined /> 批注</button>
            </div>
          )}
          {commentEditor?.pageNumber === pageNumber && (
            <section
              className="comment-editor"
              style={{ left: editorLeft, top: editorTop }}
              aria-label={commentEditor.mode === "create" ? "评论这一段" : "编辑评论"}
              onMouseDown={(event) => event.stopPropagation()}
              onMouseUp={(event) => event.stopPropagation()}
            >
              <header>
                <span><CommentOutlined /> {commentEditor.mode === "create" ? "评论这一段" : "编辑评论"}</span>
                <button type="button" title="关闭" onClick={onCancelComment}><CloseOutlined /></button>
              </header>
              <blockquote title={commentEditor.selectedText}>{commentEditor.selectedText}</blockquote>
              <textarea
                autoFocus
                maxLength={4_000}
                value={commentEditor.content}
                placeholder="写下你对这段内容的理解、问题或想法…"
                onChange={(event) => onCommentEditorChange(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") onSaveComment();
                  if (event.key === "Escape") onCancelComment();
                }}
              />
              <footer>
                {commentEditor.mode === "edit" && commentEditor.commentId
                  ? <button type="button" className="comment-delete" onClick={() => onDeleteComment(commentEditor.commentId!)}><DeleteOutlined /> 删除</button>
                  : <span />}
                <div>
                  <button type="button" onClick={onCancelComment}>取消</button>
                  <button type="button" className="comment-save" disabled={!commentEditor.content.trim()} onClick={onSaveComment}>保存</button>
                </div>
              </footer>
            </section>
          )}
        </>
      ) : <div className="pdf-page-placeholder"><span>第 {pageNumber} 页</span></div>}
    </article>
  );
}

export default function Home() {
  const isClient = useSyncExternalStore(() => () => undefined, () => true, () => false);
  const workspaceShellRef = useRef<HTMLElement>(null);
  const documentPanelRef = useRef<HTMLElement>(null);
  const pdfStageRef = useRef<HTMLDivElement>(null);
  const pageFrameRefs = useRef(new Map<number, HTMLElement>());
  const pageNumberRef = useRef(1);
  const pageInputFocusedRef = useRef(false);
  const skipPageInputBlurCommitRef = useRef(false);
  const pdfRef = useRef<PdfDocument | null>(null);
  const currentPaperIdRef = useRef("");
  const documentGenerationRef = useRef(0);
  const scrollSyncFrameRef = useRef<number | null>(null);
  const pendingInitialPageRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderNameInputRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const referencedPaperCacheRef = useRef(new Map<string, Promise<PaperPageText[]>>());
  const currentPaperPageIndexRef = useRef<{ generation: number; pages: Promise<PaperPageText[]> } | null>(null);
  const identityHydrationRef = useRef(new Set<string>());
  const selectionMadeRef = useRef(false);
  const translationAbortRef = useRef<AbortController | null>(null);
  const termsAbortRef = useRef<AbortController | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const noteSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const highlightSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const chatSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const paperWriteBarrierRef = useRef(new Map<string, Promise<void>>());
  const highlightsRef = useRef<Record<number, HighlightRect[]>>({});
  const progressThumbnailTokenRef = useRef(0);
  const outlineLoadTokenRef = useRef(0);
  const resizeDragRef = useRef<{ side: ResizeSide; startX: number; startWidths: PanelWidths } | null>(null);
  const chatResizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [appView, setAppView] = useState<AppView>("space");
  const [libraryPapers, setLibraryPapers] = useState<LibraryPaper[]>([]);
  const [libraryFolders, setLibraryFolders] = useState<LibraryFolder[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [activeFolderId, setActiveFolderId] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [openingPaperId, setOpeningPaperId] = useState("");
  const [currentPaperId, setCurrentPaperId] = useState("");
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [fileName, setFileName] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pageSize, setPageSize] = useState<PageSize>({ width: 900, height: 1165 });
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const [zoom, setZoom] = useState(1);
  const [pageTexts, setPageTexts] = useState<Record<number, string>>({});
  const [pageSegments, setPageSegments] = useState<Record<number, PageSegment[]>>({});
  const [translations, setTranslations] = useState<Record<number, TranslatedSegment[]>>({});
  const [paperTerms, setPaperTerms] = useState<Record<number, PaperTerm[]>>({});
  const [paperOutline, setPaperOutline] = useState<PaperOutlineItem[]>([]);
  const [outlineStatus, setOutlineStatus] = useState<OutlineStatus>("idle");
  const [outlineProgress, setOutlineProgress] = useState({ completed: 0, total: 0 });
  const [outlineError, setOutlineError] = useState("");
  const [extractingTermsPage, setExtractingTermsPage] = useState(0);
  const [termsError, setTermsError] = useState("");
  const [highlights, setHighlights] = useState<Record<number, HighlightRect[]>>({});
  const [comments, setComments] = useState<PaperComment[]>([]);
  const [commentEditor, setCommentEditor] = useState<CommentEditorState | null>(null);
  const [translationJob, setTranslationJob] = useState<TranslationJob | null>(null);
  const [translatingPage, setTranslatingPage] = useState(0);
  const [fullTranslation, setFullTranslation] = useState<FullTranslationProgress>({ status: "idle", completed: 0, total: 0, currentPage: 0, failedPages: [] });
  const [message, setMessage] = useState("PDF、Word 和 PPT 均在本机处理");
  const [dragging, setDragging] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("translation");
  const [mobileView, setMobileView] = useState<MobileView>("paper");
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>("select");
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [selectedText, setSelectedText] = useState("");
  const [chatContextKind, setChatContextKind] = useState<ChatContextKind | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatImages, setChatImages] = useState<ChatImageAttachment[]>([]);
  const [chatPaperMentions, setChatPaperMentions] = useState<ChatPaperMention[]>([]);
  const [chatFolderMentions, setChatFolderMentions] = useState<ChatFolderMention[]>([]);
  const [mentionRange, setMentionRange] = useState<MentionRange | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [isChatting, setIsChatting] = useState(false);
  const [chatStatus, setChatStatus] = useState("");
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("checking");
  const [providers, setProviders] = useState<ProviderMap>({});
  const [aiSettings, setAISettings] = useState<AISettings>(DEFAULT_AI_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [providerTestStatus, setProviderTestStatus] = useState("");
  const [extensionStoreUrl, setExtensionStoreUrl] = useState("");
  const [lastTranslationUsage, setLastTranslationUsage] = useState<AIUsage | undefined>();
  const [lastTranslationProvider, setLastTranslationProvider] = useState("");
  const [lastTranslationPage, setLastTranslationPage] = useState(0);
  const [skillAvailable, setSkillAvailable] = useState(false);
  const [detectedRepositoryUrl, setDetectedRepositoryUrl] = useState("");
  const [stageAvailableWidth, setStageAvailableWidth] = useState(900);
  const [hoveredSegmentId, setHoveredSegmentId] = useState("");
  const [contextSegmentId, setContextSegmentId] = useState("");
  const [contextSegmentIds, setContextSegmentIds] = useState<string[]>([]);
  const [selectionContextRects, setSelectionContextRects] = useState<SyncRect[]>([]);
  const [pageFigures, setPageFigures] = useState<Record<number, FigureRegion[]>>({});
  const [hoveredFigureId, setHoveredFigureId] = useState("");
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(DEFAULT_PANEL_WIDTHS);
  const [resizingSide, setResizingSide] = useState<ResizeSide | null>(null);
  const [chatHeight, setChatHeight] = useState(DEFAULT_CHAT_HEIGHT);
  const [resizingChat, setResizingChat] = useState(false);
  const [layoutLoaded, setLayoutLoaded] = useState(false);

  const isTranslating = translationJob !== null;
  const currentText = pageTexts[pageNumber] || "";
  const currentSegments = useMemo(() => pageSegments[pageNumber] || [], [pageNumber, pageSegments]);
  const currentTranslatedSegments = useMemo(() => translations[pageNumber] || [], [pageNumber, translations]);
  const currentTranslation = currentTranslatedSegments.map((segment) => segment.translation).join("\n\n");
  const activeSegmentId = hoveredSegmentId || contextSegmentId;
  const repositoryFromReadPages = useMemo(() => findGitHubRepository(Object.values(pageTexts).join("\n")), [pageTexts]);
  const repositoryUrl = detectedRepositoryUrl || repositoryFromReadPages;
  const selectedProvider = providers[aiSettings.provider];
  const selectedProviderAvailable = bridgeStatus === "ready" && Boolean(selectedProvider?.available);
  const extensionPairingToken = providers["chatgpt-web"]?.pairingToken || "";
  const aiTaskProviderAvailable = selectedProviderAvailable;
  const effectiveAISettings = aiSettings;
  const selectedProviderLabel = providerDisplayName(aiSettings.provider);
  const effectiveProviderLabel = providerDisplayName(effectiveAISettings.provider);
  const selectedStatus: BridgeStatus = bridgeStatus === "checking" ? "checking" : selectedProviderAvailable ? "ready" : "offline";
  const folderMentionRecords = useMemo(() => libraryFolders.map((folder) => ({
    ...folder,
    paperIds: libraryPapers.filter((paper) => paper.folderId === folder.id).map((paper) => paper.id),
  })), [libraryFolders, libraryPapers]);
  const mentionSuggestions = useMemo(() => mentionRange ? searchMentionTargets(libraryPapers, folderMentionRecords, mentionRange.query, {
    currentPaperId,
    selectedPaperIds: chatPaperMentions.map((paper) => paper.id),
    selectedFolderIds: chatFolderMentions.map((folder) => folder.id),
    limit: 8,
  }) : [], [chatFolderMentions, chatPaperMentions, currentPaperId, folderMentionRecords, libraryPapers, mentionRange]);
  const activeFolder = libraryFolders.find((folder) => folder.id === activeFolderId);
  const visibleLibraryPapers = activeFolderId ? libraryPapers.filter((paper) => paper.folderId === activeFolderId) : libraryPapers;
  const fullTranslationLabel = translationJob === "full"
    ? "停止全文翻译"
    : fullTranslation.status === "complete"
      ? "全文已翻译"
      : fullTranslation.status === "paused"
        ? "继续全文翻译"
        : fullTranslation.status === "failed"
          ? "重试未完成页"
          : fullTranslation.completed > 0
            ? "继续全文翻译"
            : "翻译全文";
  const fullTranslationStatusText = fullTranslation.status === "running"
    ? `正在翻译第 ${fullTranslation.currentPage} 页`
    : fullTranslation.status === "complete"
      ? "全文译文已准备好"
      : fullTranslation.status === "paused"
        ? "已暂停，可从未完成页继续"
        : fullTranslation.status === "failed"
          ? `${fullTranslation.failedPages.length || 1} 页待重试`
          : fullTranslation.completed > 0
            ? "已保存，可继续翻译剩余页面"
            : "一次准备全部页面，之后翻页无需等待";

  useEffect(() => {
    if (!pdf || translationJob === "full") return;
    const completed = compatibleTranslationPages(translations, pageSegments).length;
    setFullTranslation((previous) => {
      const status = completed >= pdf.numPages
        ? "complete"
        : previous.status === "complete" ? "idle" : previous.status;
      if (previous.completed === completed && previous.total === pdf.numPages && previous.status === status) return previous;
      return { ...previous, status, completed, total: pdf.numPages };
    });
  }, [pageSegments, pdf, translationJob, translations]);

  const displayPageWidth = Math.max(240, Math.min(pageSize.width, stageAvailableWidth) * zoom);

  const checkCodexBridge = useCallback(async () => {
    setBridgeStatus("checking");
    try {
      const response = await fetch(`${CODEX_BRIDGE}/health`, { cache: "no-store" });
      if (!response.ok) throw new Error("Bridge unavailable");
      const health = await response.json() as { providers?: ProviderMap; defaultProvider?: AIProviderId; extensionStoreUrl?: string };
      const nextProviders = health.providers || {};
      setProviders(nextProviders);
      setExtensionStoreUrl(health.extensionStoreUrl || "");
      setSkillAvailable(Boolean(nextProviders["local-codex"]?.skillAvailable));
      let storedProvider: AIProviderId | undefined;
      try {
        const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || "null") as Partial<AISettings> | null;
        if (stored?.provider === "local-codex" || stored?.provider === "chatgpt-web") {
          storedProvider = stored.provider;
        }
      } catch {
        // The settings loader below removes malformed state.
      }
      const selectedProvider = storedProvider || DEFAULT_AI_SETTINGS.provider;
      if (!nextProviders[selectedProvider]?.available && health.defaultProvider && nextProviders[health.defaultProvider]?.available) {
        const provider = health.defaultProvider;
        const models = nextProviders[provider]?.models;
        setAISettings((previous) => ({
          ...previous,
          provider,
          translationModel: models?.translation || previous.translationModel,
          chatModel: models?.chat || previous.chatModel,
        }));
      }
      setBridgeStatus("ready");
      return true;
    } catch {
      setProviders({});
      setExtensionStoreUrl("");
      setSkillAvailable(false);
      setBridgeStatus("offline");
      return false;
    }
  }, []);

  useEffect(() => { void checkCodexBridge(); }, [checkCodexBridge]);

  useEffect(() => {
    const token = extensionPairingToken;
    if (!token) return;
    const postToken = () => window.postMessage({ type: "paperlens:extension-pair", token }, window.location.origin);
    const handleExtensionReady = (event: MessageEvent) => {
      if (event.source === window && event.origin === window.location.origin && event.data?.type === "paperlens:extension-ready") postToken();
    };
    window.addEventListener("message", handleExtensionReady);
    postToken();
    const refreshTimer = window.setTimeout(() => { void checkCodexBridge(); }, 1_500);
    return () => {
      window.removeEventListener("message", handleExtensionReady);
      window.clearTimeout(refreshTimer);
    };
  }, [checkCodexBridge, extensionPairingToken]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || "null") as Partial<AISettings> | null;
      if (stored && (stored.provider === "local-codex" || stored.provider === "chatgpt-web")) {
        setAISettings({
          provider: stored.provider,
          translationModel: stored.translationModel || DEFAULT_AI_SETTINGS.translationModel,
          chatModel: stored.chatModel || DEFAULT_AI_SETTINGS.chatModel,
          reasoningEffort: ["none", "low", "medium", "high"].includes(stored.reasoningEffort || "") ? stored.reasoningEffort! : DEFAULT_AI_SETTINGS.reasoningEffort,
        });
      }
    } catch {
      localStorage.removeItem(AI_SETTINGS_KEY);
    } finally {
      setSettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (settingsLoaded) localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings));
  }, [aiSettings, settingsLoaded]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(READER_LAYOUT_KEY) || "null") as (Partial<PanelWidths> & { chatHeight?: number }) | null;
      const requestedWidths = {
        left: stored?.left || DEFAULT_PANEL_WIDTHS.left,
        right: stored?.right || DEFAULT_PANEL_WIDTHS.right,
      };
      setPanelWidths(window.innerWidth <= 820 ? requestedWidths : clampPanelWidths(requestedWidths, window.innerWidth));
      setChatHeight(clampChatHeight(stored?.chatHeight || DEFAULT_CHAT_HEIGHT, window.innerHeight));
    } catch {
      localStorage.removeItem(READER_LAYOUT_KEY);
      setPanelWidths(clampPanelWidths(DEFAULT_PANEL_WIDTHS, window.innerWidth));
      setChatHeight(clampChatHeight(DEFAULT_CHAT_HEIGHT, window.innerHeight));
    } finally {
      setLayoutLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!layoutLoaded) return;
    localStorage.setItem(READER_LAYOUT_KEY, JSON.stringify({ ...panelWidths, chatHeight }));
  }, [chatHeight, layoutLoaded, panelWidths]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 820) {
        const width = workspaceShellRef.current?.clientWidth || window.innerWidth;
        setPanelWidths((previous) => clampPanelWidths(previous, width));
      }
      const height = documentPanelRef.current?.clientHeight || window.innerHeight;
      setChatHeight((previous) => clampChatHeight(previous, height));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!resizingSide) return;
    document.body.classList.add("panel-resizing");
    const handlePointerMove = (event: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      const width = workspaceShellRef.current?.clientWidth || window.innerWidth;
      setPanelWidths(resizePanelWidths(drag.side, drag.startWidths, event.clientX - drag.startX, width));
    };
    const finishResize = () => {
      resizeDragRef.current = null;
      setResizingSide(null);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    return () => {
      document.body.classList.remove("panel-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, [resizingSide]);

  useEffect(() => {
    if (!resizingChat) return;
    document.body.classList.add("chat-resizing");
    const handlePointerMove = (event: PointerEvent) => {
      const drag = chatResizeDragRef.current;
      if (!drag) return;
      const height = documentPanelRef.current?.clientHeight || window.innerHeight;
      setChatHeight(resizeChatHeight(drag.startHeight, event.clientY - drag.startY, height));
    };
    const finishResize = () => {
      chatResizeDragRef.current = null;
      setResizingChat(false);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    return () => {
      document.body.classList.remove("chat-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, [resizingChat]);

  useEffect(() => () => {
    documentGenerationRef.current += 1;
    translationAbortRef.current?.abort();
    termsAbortRef.current?.abort();
    chatAbortRef.current?.abort();
  }, []);

  const testSelectedProvider = useCallback(async () => {
    setProviderTestStatus("正在测试连接…");
    try {
      const response = await fetch(`${CODEX_BRIDGE}/test-provider`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: aiSettings.provider }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "连接测试失败");
      setProviderTestStatus(`${providerDisplayName(aiSettings.provider)} 连接测试通过`);
      await checkCodexBridge();
    } catch (error) {
      setProviderTestStatus(error instanceof Error ? error.message : "连接测试失败");
    }
  }, [aiSettings.provider, checkCodexBridge]);

  const connectCodexAccount = useCallback(async () => {
    const loginWindow = window.open("about:blank", "_blank");
    setProviderTestStatus("正在创建 Codex 登录会话…");
    try {
      const response = await fetch(`${CODEX_BRIDGE}/codex/login`, { method: "POST" });
      const result = await response.json() as { authUrl?: string; error?: string };
      if (!response.ok || !result.authUrl) throw new Error(result.error || "无法启动 Codex 登录");
      if (loginWindow) loginWindow.location.href = result.authUrl;
      else window.open(result.authUrl, "_blank", "noopener,noreferrer");
      setProviderTestStatus("请在新页面完成 ChatGPT 登录；PaperLens 正在等待账号连接…");
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        const healthResponse = await fetch(`${CODEX_BRIDGE}/health`, { cache: "no-store" });
        const health = await healthResponse.json() as { providers?: ProviderMap };
        if (health.providers?.["local-codex"]?.account?.loggedIn) {
          await checkCodexBridge();
          setProviderTestStatus("本机 Codex 已连接 ChatGPT 账号");
          return;
        }
      }
      throw new Error("等待登录超时；完成网页登录后可点击“刷新状态”继续");
    } catch (error) {
      loginWindow?.close();
      setProviderTestStatus(error instanceof Error ? error.message : "Codex 登录失败");
    }
  }, [checkCodexBridge]);

  const logoutCodexAccount = useCallback(async () => {
    setProviderTestStatus("正在退出 Codex 账号…");
    try {
      const response = await fetch(`${CODEX_BRIDGE}/codex/logout`, { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "退出失败");
      await checkCodexBridge();
      setProviderTestStatus("Codex 账号已退出");
    } catch (error) {
      setProviderTestStatus(error instanceof Error ? error.message : "退出失败");
    }
  }, [checkCodexBridge]);

  const openChatGPTWebSetup = useCallback(async () => {
    setProviderTestStatus("正在打开 Chrome 扩展页和本地扩展目录…");
    try {
      const response = await fetch(`${CODEX_BRIDGE}/setup/chatgpt-web`, { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "无法打开安装向导");
      setProviderTestStatus("已打开安装向导：在 Chrome 开启开发者模式并选择 browser-extension 文件夹");
    } catch (error) {
      setProviderTestStatus(error instanceof Error ? error.message : "无法打开安装向导");
    }
  }, []);

  const refreshLibrary = useCallback(async () => {
    try {
      const [papers, folders] = await Promise.all([listStoredPapers(), listStoredFolders()]);
      const localProgress = parseReadingProgress(localStorage.getItem(READING_PROGRESS_KEY));
      const visiblePapers = papers.map((paper) => ({
        id: paper.id,
        fileName: paper.fileName,
        sourceFileName: paper.sourceFileName,
        sourceKind: paper.sourceKind,
        displayName: paper.displayName,
        aliases: paper.aliases || [],
        repositoryUrl: paper.repositoryUrl || "",
        importedAt: paper.importedAt,
        lastOpenedAt: paper.lastOpenedAt,
        lastModified: paper.lastModified,
        lastPage: restoredReadingPage(paper.lastPage, paper.pageCount, localProgress[paper.id]),
        pageCount: paper.pageCount,
        size: paper.size,
        thumbnail: paper.thumbnail,
        thumbnailPage: paper.thumbnailPage || 1,
        folderId: paper.folderId,
      }));
      setLibraryPapers(visiblePapers);
      setLibraryFolders(folders);

      const staleThumbnails = visiblePapers.filter((paper) => paper.thumbnailPage !== paper.lastPage);
      if (staleThumbnails.length) {
        void (async () => {
          const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          for (const paper of staleThumbnails) {
            const stored = papers.find((candidate) => candidate.id === paper.id);
            if (!stored) continue;
            const data = new Uint8Array(await stored.file.arrayBuffer());
            const thumbnailPdf = await pdfjs.getDocument({ data }).promise as unknown as PdfDocument;
            try {
              const thumbnail = await createPdfThumbnail(thumbnailPdf, paper.lastPage);
              await updateStoredPaper(paper.id, { lastPage: paper.lastPage, thumbnail, thumbnailPage: paper.lastPage });
              setLibraryPapers((previous) => previous.map((candidate) => candidate.id === paper.id
                ? { ...candidate, thumbnail, thumbnailPage: paper.lastPage }
                : candidate));
            } finally {
              await thumbnailPdf.destroy?.();
            }
          }
        })().catch((error) => console.error("Last-read thumbnail refresh failed", error));
      }
    } catch (error) {
      console.error("Paper library read failed", error);
      setMessage("无法读取本地资料库，请刷新后重试");
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isClient) return;
    void refreshLibrary();
  }, [isClient, refreshLibrary]);

  useEffect(() => {
    if (creatingFolder) requestAnimationFrame(() => folderNameInputRef.current?.focus());
  }, [creatingFolder]);

  useEffect(() => {
    if (!isClient || libraryLoading) return;
    const candidates = libraryPapers.filter((paper) => {
      const needsIdentity = !paper.aliases?.length || isLowSignalPaperName(paper.displayName);
      return needsIdentity && !identityHydrationRef.current.has(paper.id);
    });
    if (!candidates.length) return;
    candidates.forEach((paper) => identityHydrationRef.current.add(paper.id));
    void (async () => {
      let changed = false;
      for (const paper of candidates) {
        try {
          const stored = await getStoredPaper(paper.id);
          if (!stored) continue;
          const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          const data = new Uint8Array(await stored.file.arrayBuffer());
          const storedPdf = await pdfjs.getDocument({ data }).promise as unknown as PdfDocument;
          try {
            const identity = await inspectPdfIdentity(storedPdf, stored.sourceFileName || stored.fileName, stored);
            await updateStoredPaper(stored.id, identity);
            changed = true;
          } finally {
            await storedPdf.destroy?.();
          }
        } catch (error) {
          console.error(`Paper identity migration failed for ${paper.fileName}`, error);
        }
      }
      if (changed) await refreshLibrary();
    })();
  }, [isClient, libraryLoading, libraryPapers, refreshLibrary]);

  useEffect(() => {
    const stage = pdfStageRef.current;
    if (!stage) return;
    const syncWidth = () => setStageAvailableWidth(Math.max(280, stage.clientWidth - 28));
    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [appView, isClient]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    const discoverRepository = async () => {
      // Repository links are commonly printed after the abstract. Scan the
      // opening pages independently of the user's restored reading position.
      for (let candidatePage = 1; candidatePage <= Math.min(pdf.numPages, 4); candidatePage += 1) {
        const page = await pdf.getPage(candidatePage);
        const content = await page.getTextContent();
        if (cancelled) return;
        const text = content.items.map((item) => item.str || "").join(" ");
        const repository = findGitHubRepository(text);
        if (repository) {
          setDetectedRepositoryUrl(repository);
          return;
        }
      }
    };
    void discoverRepository().catch((error: unknown) => {
      if (!cancelled) console.error("GitHub repository discovery failed", error);
    });
    return () => { cancelled = true; };
  }, [pdf]);

  useEffect(() => {
    pageNumberRef.current = pageNumber;
    const knownSize = pageSizes[pageNumber];
    if (knownSize) {
      setPageSize((previous) => previous.width === knownSize.width && previous.height === knownSize.height ? previous : knownSize);
    }
  }, [pageNumber, pageSizes]);

  useEffect(() => {
    if (!pageInputFocusedRef.current) setPageInput(String(pageNumber));
  }, [pageNumber]);

  useEffect(() => {
    if (!currentPaperId || !pdf || appView !== "reader") return;
    const savedAt = Date.now();
    localStorage.setItem(
      READING_PROGRESS_KEY,
      writeReadingProgress(localStorage.getItem(READING_PROGRESS_KEY), currentPaperId, pageNumber, savedAt),
    );
    setLibraryPapers((previous) => previous.map((paper) => paper.id === currentPaperId
      ? { ...paper, lastPage: pageNumber, lastOpenedAt: savedAt }
      : paper));

    const token = ++progressThumbnailTokenRef.current;
    const saveTimer = window.setTimeout(() => {
      void createPdfThumbnail(pdf, pageNumber).then((thumbnail) => {
        if (progressThumbnailTokenRef.current !== token) return;
        return updateStoredPaper(currentPaperId, {
          lastOpenedAt: savedAt,
          lastPage: pageNumber,
          thumbnail,
          thumbnailPage: pageNumber,
        });
      }).catch((error) => console.error("Reading progress update failed", error));
    }, 450);
    return () => window.clearTimeout(saveTimer);
  }, [appView, currentPaperId, pageNumber, pdf]);

  const registerPageFrame = useCallback((targetPage: number, frame: HTMLElement | null) => {
    if (frame) pageFrameRefs.current.set(targetPage, frame);
    else pageFrameRefs.current.delete(targetPage);
  }, []);

  const handlePageSize = useCallback((targetPage: number, size: PageSize) => {
    setPageSizes((previous) => {
      const existing = previous[targetPage];
      if (existing?.width === size.width && existing.height === size.height) return previous;
      return { ...previous, [targetPage]: size };
    });
    if (pageNumberRef.current === targetPage) {
      setPageSize((previous) => previous.width === size.width && previous.height === size.height ? previous : size);
    }
  }, []);

  const handlePageParsed = useCallback((targetPage: number, result: { segments: PageSegment[]; figures: FigureRegion[]; text: string }) => {
    setPageSegments((previous) => ({ ...previous, [targetPage]: result.segments }));
    setPageFigures((previous) => ({ ...previous, [targetPage]: result.figures }));
    setPageTexts((previous) => ({ ...previous, [targetPage]: result.text }));
  }, []);

  const handlePageStatus = useCallback((targetPage: number, nextMessage: string) => {
    if (pageNumberRef.current === targetPage) setMessage(nextMessage);
  }, []);

  const loadPaperOutline = useCallback(async () => {
    if (!pdf) return;
    const loadToken = ++outlineLoadTokenRef.current;
    setOutlineStatus("loading");
    setOutlineProgress({ completed: 0, total: pdf.numPages });
    setOutlineError("");
    try {
      const embeddedOutline = await extractEmbeddedPaperOutline(pdf);
      if (loadToken !== outlineLoadTokenRef.current) return;
      if (embeddedOutline.length >= 2) {
        setPaperOutline(selectMajorPaperOutline(embeddedOutline));
        setOutlineProgress({ completed: pdf.numPages, total: pdf.numPages });
        setOutlineStatus("ready");
        return;
      }

      const candidates: OutlineHeadingCandidate[] = [];
      const batchSize = 4;
      for (let offset = 1; offset <= pdf.numPages; offset += batchSize) {
        const pageNumbers = Array.from({ length: Math.min(batchSize, pdf.numPages - offset + 1) }, (_, index) => offset + index);
        const batch = await Promise.all(pageNumbers.map(async (targetPage) => {
          const page = await pdf.getPage(targetPage);
          const [content, viewport] = await Promise.all([page.getTextContent(), Promise.resolve(page.getViewport({ scale: 1 }))]);
          return buildPageSegments(content.items, viewport, targetPage)
            .filter((segment) => segment.kind === "heading")
            .map((segment) => ({ title: segment.text, pageNumber: targetPage }));
        }));
        if (loadToken !== outlineLoadTokenRef.current) return;
        candidates.push(...batch.flat());
        setOutlineProgress({ completed: Math.min(pdf.numPages, offset + pageNumbers.length - 1), total: pdf.numPages });
      }

      const detectedOutline = buildDetectedPaperOutline(candidates);
      setPaperOutline(selectMajorPaperOutline(detectedOutline.length ? detectedOutline : embeddedOutline));
      setOutlineStatus("ready");
    } catch (error) {
      if (loadToken !== outlineLoadTokenRef.current) return;
      console.error("Paper outline extraction failed", error);
      setPaperOutline([]);
      setOutlineError(error instanceof Error ? error.message : "无法读取全文目录");
      setOutlineStatus("failed");
    }
  }, [pdf]);

  useEffect(() => {
    if (rightTab === "outline" && pdf && outlineStatus === "idle") void loadPaperOutline();
  }, [loadPaperOutline, outlineStatus, pdf, rightTab]);

  useEffect(() => {
    if (!pdf || appView !== "reader" || pendingInitialPageRef.current === null) return;
    const targetPage = pendingInitialPageRef.current;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const stage = pdfStageRef.current;
      const frame = pageFrameRefs.current.get(targetPage);
      if (!stage || !frame || pendingInitialPageRef.current !== targetPage) return;
      stage.scrollTop = Math.max(0, frame.offsetTop);
      pendingInitialPageRef.current = null;
    }));
  }, [appView, displayPageWidth, pdf]);

  const loadFile = useCallback(async (file?: File, options: LoadPdfOptions = {}) => {
    if (!file) return false;
    const importedFile = file;
    const inputKind = sourceDocumentKind(file.name, file.type);
    const importedKind = options.sourceKind || inputKind;
    if (!inputKind || !importedKind) {
      setMessage("请选择 PDF、Word（DOC/DOCX）或 PowerPoint（PPT/PPTX）文件");
      return false;
    }
    const loadGeneration = options.generation ?? ++documentGenerationRef.current;
    const loadIsCurrent = () => isCurrentDocumentGeneration(loadGeneration, documentGenerationRef.current);
    if (!loadIsCurrent()) return false;
    outlineLoadTokenRef.current += 1;
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    setIsChatting(false);
    setChatStatus("");
    translationAbortRef.current?.abort();
    translationAbortRef.current = null;
    termsAbortRef.current?.abort();
    termsAbortRef.current = null;
    setTranslationJob(null);
    setTranslatingPage(0);
    setExtractingTermsPage(0);
    setTermsError("");
    let readableFile = file;
    let nextPdf: PdfDocument | null = null;
    try {
      if (inputKind !== "pdf") {
        setMessage(`正在本机将 ${sourceKindLabel(inputKind)} 转换为 PDF…`);
        readableFile = await convertDocumentToPdf(file);
        if (!loadIsCurrent()) return false;
      }
      setMessage(inputKind === "pdf" ? "正在打开 PDF…" : "转换完成，正在打开…");
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      if (!loadIsCurrent()) return false;
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const fileBuffer = await readableFile.arrayBuffer();
      if (!loadIsCurrent()) return false;
      const data = new Uint8Array(fileBuffer.slice(0));
      nextPdf = await pdfjs.getDocument({ data }).promise as unknown as PdfDocument;
      if (!loadIsCurrent()) {
        await nextPdf.destroy?.().catch(() => undefined);
        return false;
      }
      const sourceFileName = options.sourceFileName || importedFile.name;
      const paperId = options.paperId || `${sourceFileName}:${importedFile.size}:${importedFile.lastModified}`;
      let initialPage = Math.min(nextPdf.numPages, Math.max(1, options.initialPage || 1));
      let existingStored: StoredPaper | undefined;
      try {
        existingStored = await getStoredPaper(paperId);
      } catch (error) {
        console.error("Existing paper read failed", error);
      }
      if (!loadIsCurrent()) {
        await nextPdf.destroy?.().catch(() => undefined);
        return false;
      }
      if (options.initialPage === undefined && existingStored) {
        const localProgress = parseReadingProgress(localStorage.getItem(READING_PROGRESS_KEY));
        initialPage = restoredReadingPage(existingStored.lastPage, nextPdf.numPages, localProgress[paperId]);
      }
      const identity = await inspectPdfIdentity(nextPdf, sourceFileName, existingStored);
      if (!loadIsCurrent()) {
        await nextPdf.destroy?.().catch(() => undefined);
        return false;
      }
      const previousPdf = pdfRef.current;
      pdfRef.current = nextPdf;
      currentPaperIdRef.current = paperId;
      setPdf(nextPdf);
      setDetectedRepositoryUrl(identity.repositoryUrl);
      setCurrentPaperId(paperId);
      setFileName(identity.displayName);
      pageNumberRef.current = initialPage;
      setPageNumber(initialPage);
      setPageInput(String(initialPage));
      setPageSizes({});
      setPageTexts({});
      setPageSegments({});
      const restoredTranslations = existingStored?.translations || {};
      const restoredHighlights = existingStored?.highlights || {};
      const completedTranslations = compatibleTranslationPages(restoredTranslations).length;
      setTranslations(restoredTranslations);
      setPaperTerms(existingStored?.terms || {});
      setPaperOutline([]);
      setOutlineStatus("idle");
      setOutlineProgress({ completed: 0, total: nextPdf.numPages });
      setOutlineError("");
      setNotes(existingStored?.notes || {});
      setFullTranslation({
        status: completedTranslations >= nextPdf.numPages ? "complete" : "idle",
        completed: completedTranslations,
        total: nextPdf.numPages,
        currentPage: 0,
        failedPages: [],
      });
      highlightsRef.current = restoredHighlights;
      setHighlights(restoredHighlights);
      setComments(existingStored?.comments || []);
      setCommentEditor(null);
      setChatMessages(existingStored?.chatMessages || []);
      setChatImages([]);
      setChatPaperMentions([]);
      setChatFolderMentions([]);
      setMentionRange(null);
      setSelectedText("");
      setChatContextKind(null);
      setPendingSelection(null);
      setHoveredSegmentId("");
      setContextSegmentId("");
      setContextSegmentIds([]);
      setSelectionContextRects([]);
      setPageFigures({});
      setHoveredFigureId("");
      pageFrameRefs.current.clear();
      pendingInitialPageRef.current = initialPage;
      setRightTab("translation");
      setAppView("reader");
      setMessage(inputKind === "pdf"
        ? `已导入，共 ${nextPdf.numPages} 页`
        : `${sourceKindLabel(importedKind)} 已转为 PDF，共 ${nextPdf.numPages} 页`);
      if (previousPdf && previousPdf !== nextPdf) {
        void previousPdf.destroy?.().catch((error) => console.error("Previous PDF cleanup failed", error));
      }
      if (!options.skipPersist) {
        const initialPaperWrite = (async () => {
          let thumbnail = "";
          try {
            thumbnail = await createPdfThumbnail(nextPdf, initialPage);
          } catch (error) {
            console.error("PDF thumbnail render failed", error);
          }
          const timestamp = Date.now();
          await putStoredPaper({
            id: paperId,
            fileName: readableFile.name,
            sourceFileName,
            sourceKind: importedKind,
            displayName: identity.displayName,
            aliases: identity.aliases,
            repositoryUrl: identity.repositoryUrl,
            importedAt: existingStored?.importedAt || timestamp,
            lastOpenedAt: timestamp,
            lastModified: importedFile.lastModified,
            lastPage: initialPage,
            pageCount: nextPdf.numPages,
            size: importedFile.size,
            thumbnail,
            thumbnailPage: initialPage,
            folderId: existingStored?.folderId || options.folderId,
            file: new Blob([fileBuffer], { type: "application/pdf" }),
            chatMessages: existingStored?.chatMessages || [],
            chatMessagesUpdatedAt: existingStored?.chatMessagesUpdatedAt,
            highlights: restoredHighlights,
            highlightsUpdatedAt: existingStored?.highlightsUpdatedAt,
            translations: restoredTranslations,
            translationUpdatedAt: existingStored?.translationUpdatedAt,
            terms: existingStored?.terms || {},
            termsUpdatedAt: existingStored?.termsUpdatedAt,
            notes: existingStored?.notes || {},
            notesUpdatedAt: existingStored?.notesUpdatedAt,
            comments: existingStored?.comments || [],
            commentsUpdatedAt: existingStored?.commentsUpdatedAt,
          });
        })();
        paperWriteBarrierRef.current.set(paperId, initialPaperWrite);
        try {
          await initialPaperWrite;
        } finally {
          if (paperWriteBarrierRef.current.get(paperId) === initialPaperWrite) paperWriteBarrierRef.current.delete(paperId);
        }
        if (loadIsCurrent()) await refreshLibrary();
      } else if (existingStored) {
        await updateStoredPaper(paperId, {
          displayName: identity.displayName,
          aliases: identity.aliases,
          repositoryUrl: identity.repositoryUrl,
        });
        if (loadIsCurrent()) await refreshLibrary();
      }
      return loadIsCurrent();
    } catch (error) {
      if (!loadIsCurrent() || (error instanceof DOMException && error.name === "AbortError")) {
        if (nextPdf && pdfRef.current !== nextPdf) await nextPdf.destroy?.().catch(() => undefined);
        return false;
      }
      if (inputKind !== "pdf") {
        setMessage(error instanceof Error ? error.message : "Word/PPT 转 PDF 失败");
      } else {
        setMessage("PDF 打开失败；加密或扫描版资料可能需要 OCR");
      }
      return false;
    }
  }, [refreshLibrary]);

  const openLibraryPaper = useCallback(async (paper: LibraryPaper) => {
    const openGeneration = ++documentGenerationRef.current;
    const pendingHighlightWrites = highlightSaveQueueRef.current;
    const pendingChatWrites = chatSaveQueueRef.current;
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    translationAbortRef.current?.abort();
    termsAbortRef.current?.abort();
    setIsChatting(false);
    setChatStatus("");
    setOpeningPaperId(paper.id);
    try {
      await pendingHighlightWrites.catch(() => undefined);
      await pendingChatWrites.catch(() => undefined);
      if (!isCurrentDocumentGeneration(openGeneration, documentGenerationRef.current)) return;
      const stored = await getStoredPaper(paper.id);
      if (!isCurrentDocumentGeneration(openGeneration, documentGenerationRef.current)) return;
      if (!stored) throw new Error("资料文件不存在");
      const file = new File([stored.file], stored.fileName, { type: "application/pdf", lastModified: stored.lastModified });
      const localProgress = parseReadingProgress(localStorage.getItem(READING_PROGRESS_KEY));
      const initialPage = restoredReadingPage(stored.lastPage, stored.pageCount, localProgress[stored.id]);
      const loaded = await loadFile(file, {
        paperId: stored.id,
        skipPersist: true,
        initialPage,
        sourceFileName: stored.sourceFileName || stored.fileName,
        sourceKind: stored.sourceKind || "pdf",
        generation: openGeneration,
      });
      if (!loaded || !isCurrentDocumentGeneration(openGeneration, documentGenerationRef.current)) return;
      await updateStoredPaper(stored.id, { lastOpenedAt: Date.now(), lastPage: initialPage });
      if (isCurrentDocumentGeneration(openGeneration, documentGenerationRef.current)) await refreshLibrary();
    } catch (error) {
      if (!isCurrentDocumentGeneration(openGeneration, documentGenerationRef.current)) return;
      console.error("Paper open failed", error);
      setMessage("这份资料无法打开，请重新导入");
    } finally {
      if (isCurrentDocumentGeneration(openGeneration, documentGenerationRef.current)) setOpeningPaperId("");
    }
  }, [loadFile, refreshLibrary]);

  const removeLibraryPaper = useCallback(async (paper: LibraryPaper) => {
    if (!window.confirm(`删除《${paper.displayName}》？\n\n文档、译文和所有批注都会从这台设备删除。`)) return;
    try {
      await deleteStoredPaper(paper.id);
      const localProgress = parseReadingProgress(localStorage.getItem(READING_PROGRESS_KEY));
      delete localProgress[paper.id];
      localStorage.setItem(READING_PROGRESS_KEY, JSON.stringify(localProgress));
      if (currentPaperId === paper.id) {
        documentGenerationRef.current += 1;
        chatAbortRef.current?.abort();
        chatAbortRef.current = null;
        setIsChatting(false);
        setChatStatus("");
        if (pdf) {
          try {
            await pdf.destroy?.();
          } catch (error) {
            console.error("PDF cleanup after delete failed", error);
          }
        }
        pdfRef.current = null;
        currentPaperIdRef.current = "";
        setPdf(null);
        setCurrentPaperId("");
        setFileName("");
        highlightsRef.current = {};
        setHighlights({});
        setTranslations({});
        setPaperTerms({});
        setComments([]);
        setCommentEditor(null);
        setChatMessages([]);
      }
      await refreshLibrary();
      setMessage(`已删除《${paper.displayName}》及其全部批注`);
    } catch (error) {
      console.error("Paper delete failed", error);
      setMessage("资料删除失败，请重试");
    }
  }, [currentPaperId, pdf, refreshLibrary]);

  const createLibraryFolder = useCallback(async (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = folderNameDraft.replace(/\s+/g, " ").trim().slice(0, 48);
    if (!name) {
      setMessage("请输入文件夹名称");
      folderNameInputRef.current?.focus();
      return;
    }
    if (libraryFolders.some((folder) => folder.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)) {
      setMessage(`已经有名为“${name}”的文件夹`);
      folderNameInputRef.current?.focus();
      return;
    }
    const timestamp = Date.now();
    const folder: LibraryFolder = {
      id: `folder-${timestamp}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`,
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await putStoredFolder(folder);
      setLibraryFolders((previous) => [folder, ...previous]);
      setFolderNameDraft("");
      setCreatingFolder(false);
      setMessage(`已创建文件夹“${name}”`);
    } catch (error) {
      console.error("Folder creation failed", error);
      setMessage("文件夹创建失败，请重试");
    }
  }, [folderNameDraft, libraryFolders]);

  const movePaperToFolder = useCallback(async (paper: LibraryPaper, folderId: string) => {
    const nextFolderId = folderId || undefined;
    const previousFolderId = paper.folderId;
    setLibraryPapers((previous) => previous.map((candidate) => candidate.id === paper.id ? { ...candidate, folderId: nextFolderId } : candidate));
    try {
      await updateStoredPaper(paper.id, { folderId: nextFolderId });
      const folderName = libraryFolders.find((folder) => folder.id === nextFolderId)?.name;
      setMessage(folderName ? `已将《${paper.displayName}》移到“${folderName}”` : `已将《${paper.displayName}》移出文件夹`);
    } catch (error) {
      console.error("Paper folder update failed", error);
      setLibraryPapers((previous) => previous.map((candidate) => candidate.id === paper.id ? { ...candidate, folderId: previousFolderId } : candidate));
      setMessage("资料移动失败，请重试");
    }
  }, [libraryFolders]);

  const removeLibraryFolder = useCallback(async (folder: LibraryFolder) => {
    if (!window.confirm(`删除文件夹“${folder.name}”？\n\n里面的资料不会被删除，会回到“全部资料”。`)) return;
    try {
      await deleteStoredFolder(folder.id);
      if (activeFolderId === folder.id) setActiveFolderId("");
      setChatFolderMentions((previous) => previous.filter((candidate) => candidate.id !== folder.id));
      await refreshLibrary();
      setMessage(`已删除文件夹“${folder.name}”，资料仍保留在空间中`);
    } catch (error) {
      console.error("Folder deletion failed", error);
      setMessage("文件夹删除失败，请重试");
    }
  }, [activeFolderId, refreshLibrary]);

  const goToWorkspace = useCallback(() => {
    if (currentPaperId) {
      const savedAt = Date.now();
      localStorage.setItem(
        READING_PROGRESS_KEY,
        writeReadingProgress(localStorage.getItem(READING_PROGRESS_KEY), currentPaperId, pageNumber, savedAt),
      );
      setLibraryPapers((previous) => previous.map((paper) => paper.id === currentPaperId
        ? { ...paper, lastPage: pageNumber, lastOpenedAt: savedAt }
        : paper));
      void (pdf ? createPdfThumbnail(pdf, pageNumber) : Promise.resolve("")).then((thumbnail) => updateStoredPaper(currentPaperId, {
        lastOpenedAt: savedAt,
        lastPage: pageNumber,
        ...(thumbnail ? { thumbnail, thumbnailPage: pageNumber } : {}),
      })).then(refreshLibrary).catch((error) => console.error("Paper progress update failed", error));
    }
    documentGenerationRef.current += 1;
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    translationAbortRef.current?.abort();
    termsAbortRef.current?.abort();
    setIsChatting(false);
    setChatStatus("");
    setOpeningPaperId("");
    setPendingSelection(null);
    setCommentEditor(null);
    setChatOpen(false);
    setAppView("space");
  }, [currentPaperId, pageNumber, pdf, refreshLibrary]);

  const persistHighlights = useCallback((paperId: string, nextHighlights: Record<number, HighlightRect[]>) => {
    if (!paperId) return;
    const paperWriteBarrier = paperWriteBarrierRef.current.get(paperId) || Promise.resolve();
    highlightSaveQueueRef.current = highlightSaveQueueRef.current
      .catch(() => undefined)
      .then(() => paperWriteBarrier)
      .then(() => updateStoredPaper(paperId, { highlights: nextHighlights, highlightsUpdatedAt: Date.now() }))
      .catch((error) => {
        console.error("Highlight persistence failed", error);
        if (currentPaperIdRef.current === paperId) setMessage("标亮已更新，但暂时无法保存到本机资料库");
      });
  }, []);

  const persistChatMessages = useCallback((paperId: string, nextMessages: ChatMessage[]) => {
    if (!paperId) return;
    const paperWriteBarrier = paperWriteBarrierRef.current.get(paperId) || Promise.resolve();
    chatSaveQueueRef.current = chatSaveQueueRef.current
      .catch(() => undefined)
      .then(() => paperWriteBarrier)
      .then(() => updateStoredPaper(paperId, { chatMessages: nextMessages, chatMessagesUpdatedAt: Date.now() }))
      .catch((error) => {
        console.error("AI Chat persistence failed", error);
        if (currentPaperIdRef.current === paperId) setMessage("对话仍在当前页面，但暂时无法保存到本机资料库");
      });
  }, []);

  const commitChatMessages = useCallback((update: (previous: ChatMessage[]) => ChatMessage[]) => {
    setChatMessages((previous) => {
      const next = update(previous);
      persistChatMessages(currentPaperIdRef.current, next);
      return next;
    });
  }, [persistChatMessages]);

  const commitHighlights = useCallback((nextHighlights: Record<number, HighlightRect[]>) => {
    highlightsRef.current = nextHighlights;
    setHighlights(nextHighlights);
    persistHighlights(currentPaperIdRef.current, nextHighlights);
  }, [persistHighlights]);

  const addHighlight = useCallback((selection: PendingSelection) => {
    const groupId = `${selection.pageNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next = selection.rects.map((rect, index) => ({ ...rect, id: `${groupId}-${index}`, groupId, text: selection.text }));
    const currentHighlights = highlightsRef.current;
    commitHighlights({
      ...currentHighlights,
      [selection.pageNumber]: [...(currentHighlights[selection.pageNumber] || []), ...next],
    });
    setPendingSelection(null);
    window.getSelection()?.removeAllRanges();
    setMessage(`已标亮 ${selection.text.length} 个字符`);
  }, [commitHighlights]);

  const startComment = useCallback((selection: PendingSelection) => {
    if (!selection.rects.length) return;
    const top = Math.min(...selection.rects.map((rect) => rect.y));
    const right = Math.max(...selection.rects.map((rect) => rect.x + rect.width));
    setCommentEditor({
      mode: "create",
      pageNumber: selection.pageNumber,
      segmentId: selection.primarySegmentId,
      selectedText: selection.text,
      rects: selection.rects.map(({ x, y, width, height }) => ({ x, y, width, height })),
      anchorX: Math.min(.96, Math.max(.03, right + .012)),
      anchorY: Math.min(.96, Math.max(.025, top)),
      content: "",
    });
    setPendingSelection(null);
    setMessage("请输入批注内容");
    window.getSelection()?.removeAllRanges();
  }, []);

  const editComment = useCallback((comment: PaperComment) => {
    pageNumberRef.current = comment.pageNumber;
    setPageNumber(comment.pageNumber);
    setCommentEditor({
      mode: "edit",
      commentId: comment.id,
      pageNumber: comment.pageNumber,
      segmentId: comment.segmentId,
      selectedText: comment.selectedText,
      rects: comment.rects,
      anchorX: comment.anchorX,
      anchorY: comment.anchorY,
      content: comment.content,
    });
  }, []);

  const persistComments = useCallback(async (nextComments: PaperComment[]) => {
    if (!currentPaperId) return;
    try {
      await updateStoredPaper(currentPaperId, { comments: nextComments, commentsUpdatedAt: Date.now() });
    } catch (error) {
      console.error("Comment persistence failed", error);
      setMessage("批注已更新，但暂时无法保存到本机资料库");
    }
  }, [currentPaperId]);

  const updatePageNote = useCallback((value: string) => {
    if (!currentPaperId) return;
    const nextNotes = { ...notes };
    if (value) nextNotes[pageNumber] = value;
    else delete nextNotes[pageNumber];
    setNotes(nextNotes);
    noteSaveQueueRef.current = noteSaveQueueRef.current
      .catch(() => undefined)
      .then(() => updateStoredPaper(currentPaperId, { notes: nextNotes, notesUpdatedAt: Date.now() }))
      .catch((error) => {
        console.error("Note persistence failed", error);
        setMessage("笔记已更新，但暂时无法保存到本机资料库");
      });
  }, [currentPaperId, notes, pageNumber]);

  const saveComment = useCallback(() => {
    if (!commentEditor || !commentEditor.content.trim()) return;
    const timestamp = Date.now();
    const content = commentEditor.content.trim();
    const nextComments = commentEditor.mode === "edit" && commentEditor.commentId
      ? comments.map((comment) => comment.id === commentEditor.commentId ? { ...comment, content, updatedAt: timestamp } : comment)
      : [...comments, {
          id: `${commentEditor.pageNumber}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
          pageNumber: commentEditor.pageNumber,
          segmentId: commentEditor.segmentId,
          selectedText: commentEditor.selectedText,
          rects: commentEditor.rects,
          anchorX: commentEditor.anchorX,
          anchorY: commentEditor.anchorY,
          content,
          createdAt: timestamp,
          updatedAt: timestamp,
        }];
    setComments(nextComments);
    setCommentEditor(null);
    setMessage(commentEditor.mode === "edit" ? "批注已更新并保存" : "批注已保存到这份资料");
    void persistComments(nextComments);
  }, [commentEditor, comments, persistComments]);

  const deleteComment = useCallback((commentId: string) => {
    const nextComments = comments.filter((comment) => comment.id !== commentId);
    setComments(nextComments);
    setCommentEditor(null);
    setMessage("批注已删除");
    void persistComments(nextComments);
  }, [comments, persistComments]);

  const commitSelectionContext = useCallback((selection: PendingSelection) => {
    const segmentIds = selection.segmentIds || [];
    const primarySegmentId = selection.primarySegmentId || segmentIds[0] || "";
    setSelectedText(selection.text);
    setChatContextKind("selection");
    setContextSegmentId(primarySegmentId);
    setContextSegmentIds(segmentIds.length ? segmentIds : primarySegmentId ? [primarySegmentId] : []);
    setSelectionContextRects(selection.rects.map(({ x, y, width, height }) => ({ x, y, width, height })));
    setPendingSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const askAboutSelection = useCallback((selection: PendingSelection) => {
    commitSelectionContext(selection);
    setChatOpen(true);
    setMessage("选中文字已作为 AI Chat 上下文");
    requestAnimationFrame(() => chatInputRef.current?.focus());
  }, [commitSelectionContext]);

  const handlePaperSelection = useCallback((sourcePage: number, frame: HTMLElement) => {
    if (annotationMode === "erase") return;
    const selection = window.getSelection();
    const layer = frame.querySelector<HTMLElement>(".pdf-text-layer");
    if (!selection || selection.isCollapsed || !selection.rangeCount || !layer) return;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (!anchor || !focus || !layer.contains(anchor) || !layer.contains(focus)) return;
    const text = selection.toString().replace(/\s+/g, " ").trim().slice(0, 6_000);
    if (!text) return;
    const frameBounds = frame.getBoundingClientRect();
    const range = selection.getRangeAt(0);
    const rangeRects = Array.from(range.getClientRects()).filter((rect) => rect.width > 1 && rect.height > 1);
    if (!rangeRects.length) return;
    const rects = mergeSelectionRects(rangeRects
      .map((rect) => normalizeSelectionRect(rect, frameBounds, text))
      .filter((rect): rect is SelectionRect => Boolean(rect)));
    if (!rects.length) return;

    const anchorElement = anchor.nodeType === Node.ELEMENT_NODE ? anchor as HTMLElement : anchor.parentElement;
    const focusElement = focus.nodeType === Node.ELEMENT_NODE ? focus as HTMLElement : focus.parentElement;
    const anchorSegmentId = anchorElement?.closest<HTMLElement>("[data-segment-id]")?.dataset.segmentId || "";
    const focusSegmentId = focusElement?.closest<HTMLElement>("[data-segment-id]")?.dataset.segmentId || "";
    const selectedSegmentIds = Array.from(layer.querySelectorAll<HTMLElement>("[data-segment-id]"))
      .filter((element) => range.intersectsNode(element))
      .map((element) => element.dataset.segmentId || "")
      .filter((segmentId, index, values) => segmentId && values.indexOf(segmentId) === index);
    const primarySegmentId = anchorSegmentId || focusSegmentId || selectedSegmentIds[0] || "";
    const firstRect = rangeRects[0];
    const lastRect = rangeRects.at(-1)!;
    const bubbleWidth = 218;
    const bubbleHeight = 39;
    const anchorX = (lastRect.left + lastRect.right) / 2 - frameBounds.left;
    const maxBubbleX = Math.max(8, frameBounds.width - bubbleWidth - 8);
    const bubbleAbove = firstRect.top - frameBounds.top - bubbleHeight - 7;
    const bubbleBelow = lastRect.bottom - frameBounds.top + 7;
    const nextSelection: PendingSelection = {
      pageNumber: sourcePage,
      text,
      rects,
      x: Math.min(maxBubbleX, Math.max(8, anchorX - bubbleWidth / 2)),
      y: bubbleAbove >= 8 ? bubbleAbove : Math.min(frameBounds.height - bubbleHeight - 8, bubbleBelow),
      segmentIds: selectedSegmentIds,
      primarySegmentId,
    };
    selectionMadeRef.current = true;
    pageNumberRef.current = sourcePage;
    setPageNumber(sourcePage);
    setHoveredSegmentId("");
    if (annotationMode === "highlight") {
      addHighlight(nextSelection);
      return;
    }
    if (annotationMode === "comment") {
      startComment(nextSelection);
      return;
    }
    setPendingSelection(nextSelection);
  }, [addHighlight, annotationMode, startComment]);

  const eraseHighlights = useCallback((sourcePage: number, samples: EraserPoint[], radiusX: number, radiusY: number, eraseId: string) => {
    const currentHighlights = highlightsRef.current;
    const currentPageHighlights = currentHighlights[sourcePage] || [];
    const nextPageHighlights = samples.reduce(
      (items, point, index) => eraseHighlightAtPoint(items, point, radiusX, radiusY, `${eraseId}-${index}`),
      currentPageHighlights,
    );
    if (nextPageHighlights === currentPageHighlights) return;
    commitHighlights({ ...currentHighlights, [sourcePage]: nextPageHighlights });
    setMessage("橡皮擦已局部擦除标亮");
  }, [commitHighlights]);

  const getTranslationSource = async (
    sourcePage: number,
    signal: AbortSignal,
    generation = documentGenerationRef.current,
    reportStatus: (status: string) => void = setMessage,
  ) => {
    const assertCurrentDocument = () => {
      if (signal.aborted || !isCurrentDocumentGeneration(generation, documentGenerationRef.current)) {
        throw new DOMException("Aborted", "AbortError");
      }
    };
    assertCurrentDocument();
    const knownText = pageTexts[sourcePage];
    const knownSegments = pageSegments[sourcePage];
    if (knownText && knownSegments?.length && !isVisualPageSegments(knownSegments) && !shouldUseVisualPageTranslation(knownSegments)) {
      return { text: knownText, segments: knownSegments, visualOnly: false, images: [] as ChatImageAttachment[] };
    }
    const sourcePdf = pdfRef.current;
    if (!sourcePdf) throw new Error("请先导入资料");
    const page = await sourcePdf.getPage(sourcePage);
    assertCurrentDocument();
    const viewport = page.getViewport({ scale: 1 });
    let content: PdfTextContent;
    try {
      content = await page.getTextContent();
    } catch (error) {
      console.error(`PDF page ${sourcePage} text extraction failed; using visual fallback`, error);
      content = { items: [] };
    }
    assertCurrentDocument();
    const figures = detectCaptionFigureRegions(content.items, viewport, sourcePage);
    const segments = buildPageSegments(content.items, viewport, sourcePage, figures);
    const text = segments.map((segment) => segment.text).join("\n\n").trim().slice(0, 28_000);
    if (!text || !segments.length) {
      reportStatus(`第 ${sourcePage} 页没有文字层，正在生成整页图片…`);
      const dataUrl = await renderPdfPageForVision(page, signal);
      assertCurrentDocument();
      const visualSegments = [createVisualPageSegment(sourcePage)] as PageSegment[];
      setPageSegments((previous) => ({ ...previous, [sourcePage]: visualSegments }));
      return {
        text: VISUAL_PAGE_SOURCE,
        segments: visualSegments,
        visualOnly: true,
        images: [{
          id: `visual-page-${sourcePage}`,
          label: `资料第 ${sourcePage} 页整页图片`,
          source: "paper" as const,
          dataUrl,
          pageNumber: sourcePage,
        }],
      };
    }
    if (shouldUseVisualPageTranslation(segments)) {
      reportStatus(`第 ${sourcePage} 页包含复杂表格，正在生成整页视觉输入…`);
      const dataUrl = await renderPdfPageForVision(page, signal);
      assertCurrentDocument();
      const visualSegments = [createVisualPageSegment(sourcePage)] as PageSegment[];
      setPageSegments((previous) => ({ ...previous, [sourcePage]: visualSegments }));
      return {
        text: VISUAL_PAGE_SOURCE,
        segments: visualSegments,
        visualOnly: true,
        images: [{
          id: `visual-page-${sourcePage}`,
          label: `资料第 ${sourcePage} 页整页图片（复杂版式）`,
          source: "paper" as const,
          dataUrl,
          pageNumber: sourcePage,
        }],
      };
    }
    assertCurrentDocument();
    setPageTexts((previous) => ({ ...previous, [sourcePage]: text }));
    setPageSegments((previous) => ({ ...previous, [sourcePage]: segments }));
    return { text, segments, visualOnly: false, images: [] as ChatImageAttachment[] };
  };

  const persistTranslations = async (nextTranslations: Record<number, TranslatedSegment[]>) => {
    if (!currentPaperId) return;
    try {
      await updateStoredPaper(currentPaperId, { translations: nextTranslations, translationUpdatedAt: Date.now() });
    } catch (error) {
      console.error("Translation persistence failed", error);
      setMessage("译文已生成，但暂时无法保存到本机资料库");
    }
  };

  const translatePageSource = async (sourcePage: number, source: Awaited<ReturnType<typeof getTranslationSource>>, signal: AbortSignal) => {
    try {
      const completion = await completeTranslationWithRepair(
        source.segments,
        (pendingSegments, repairAttempt, previousFailure) => invokeAI({
          mode: "translate",
          pageNumber: sourcePage,
          pageText: source.text,
          visualPage: source.visualOnly,
          repairAttempt,
          repairError: previousFailure,
          segments: pendingSegments.map(({ id, text: segmentText, kind }) => ({ id, text: segmentText, kind })),
          images: source.images.map(({ label, source: imageSource, pageNumber: imagePageNumber, dataUrl }) => ({ label, source: imageSource, pageNumber: imagePageNumber, dataUrl })),
          paperTitle: fileName,
        }, effectiveAISettings, signal),
        (pendingSegments, repairAttempt) => {
          setMessage(`第 ${sourcePage} 页执行异常，${effectiveProviderLabel} 正在自动重试（${repairAttempt}/${MAX_TRANSLATION_REPAIR_ATTEMPTS}）…`);
        },
      );
      const result = completion.results.at(-1)!;
      const accumulatedUsage = completion.results.reduce<AIUsage | undefined>((usage, nextResult) => mergeTranslationUsage(usage, nextResult.usage), undefined);
      return { result: { ...result, usage: accumulatedUsage }, translated: completion.translated, visualOnly: source.visualOnly };
    } catch (error) {
      if (!(error instanceof TranslationRepairError)) throw error;
      const missingPreview = error.missingIds.slice(0, 4).join("、");
      const details = error.parseError || `缺少 ${error.missingIds.length} 个段落${missingPreview ? `：${missingPreview}${error.missingIds.length > 4 ? "…" : ""}` : ""}`;
      throw new Error(`第 ${sourcePage} 页经 ${effectiveProviderLabel} 自动修复 ${MAX_TRANSLATION_REPAIR_ATTEMPTS} 次后仍失败（${details}）`);
    }
  };

  const stopTranslation = () => {
    translationAbortRef.current?.abort();
    setMessage(translationJob === "full" ? "正在停止全文翻译…" : "正在停止当前页翻译…");
  };

  const translateCurrent = async () => {
    if (isTranslating) {
      stopTranslation();
      return;
    }
    if (!aiTaskProviderAvailable) {
      setShowConnect(true);
      return;
    }
    const sourcePage = pageNumber;
    const controller = new AbortController();
    translationAbortRef.current = controller;
    setTranslationJob("page");
    setTranslatingPage(sourcePage);
    setRightTab("translation");
    setMobileView("translation");
    setMessage(`${providerDisplayName(effectiveAISettings.provider)} 正在翻译第 ${sourcePage} 页…`);
    try {
      const source = await getTranslationSource(sourcePage, controller.signal);
      if (source.visualOnly) setMessage(`${selectedProviderLabel} 正在识别并翻译第 ${sourcePage} 页图片…`);
      const { result, translated } = await translatePageSource(sourcePage, source, controller.signal);
      const nextTranslations = { ...translations, [sourcePage]: translated };
      setTranslations(nextTranslations);
      await persistTranslations(nextTranslations);
      setLastTranslationUsage(result.usage);
      setLastTranslationProvider(providerDisplayName(result.provider));
      setLastTranslationPage(sourcePage);
      const completed = compatibleTranslationPages(nextTranslations, pageSegments).length;
      setFullTranslation((previous) => {
        const failedPages = previous.failedPages.filter((failedPage) => failedPage !== sourcePage);
        const failedReasons = Object.fromEntries(Object.entries(previous.failedReasons || {}).filter(([failedPage]) => Number(failedPage) !== sourcePage));
        const status = completed >= (pdf?.numPages || 0)
          ? "complete"
          : failedPages.length
            ? "failed"
            : previous.status === "paused" ? "paused" : "idle";
        return { ...previous, status, completed, total: pdf?.numPages || previous.total, failedPages, failedReasons };
      });
      setMessage(`第 ${sourcePage} 页${source.visualOnly ? "图片识别与" : ""}翻译完成 · ${providerDisplayName(result.provider)}${result.usage ? ` · ${usageSummary(result.usage)}` : ""}`);
    } catch (error) {
      if (isAbortError(error)) {
        setMessage("已停止当前页翻译");
        return;
      }
      setMessage(error instanceof Error ? error.message : "翻译暂时不可用");
      const bridgeReady = await checkCodexBridge();
      if (!bridgeReady) setShowConnect(true);
    } finally {
      if (translationAbortRef.current === controller) translationAbortRef.current = null;
      setTranslationJob(null);
      setTranslatingPage(0);
    }
  };

  const translateFullPaper = async () => {
    if (translationJob === "full") {
      stopTranslation();
      return;
    }
    if (isTranslating) {
      setMessage("请先停止当前页翻译");
      return;
    }
    if (!pdf) {
      setMessage("请先导入资料");
      return;
    }
    if (!aiTaskProviderAvailable) {
      setShowConnect(true);
      return;
    }

    let nextTranslations = { ...translations };
    const translatedPages = compatibleTranslationPages(nextTranslations, pageSegments);
    const queue = buildFullTranslationQueue(pdf.numPages, pageNumber, translatedPages);
    if (!queue.length) {
      setFullTranslation((previous) => ({ ...previous, status: "complete", completed: pdf.numPages, total: pdf.numPages, currentPage: 0, failedPages: [] }));
      setMessage("全文已经翻译完成");
      return;
    }

    const controller = new AbortController();
    translationAbortRef.current = controller;
    setTranslationJob("full");
    setRightTab("translation");
    setMobileView("translation");
    let completed = translatedPages.length;
    let failedPages: number[] = [];
    let failedReasons: Record<number, string> = {};
    let consecutiveFailures = 0;
    let accumulatedUsage = fullTranslation.status === "paused" || fullTranslation.status === "failed" ? fullTranslation.usage : undefined;
    let lastProviderLabel = fullTranslation.providerLabel || effectiveProviderLabel;
    setFullTranslation({ status: "running", completed, total: pdf.numPages, currentPage: queue[0], failedPages: [], failedReasons: {}, usage: accumulatedUsage, providerLabel: lastProviderLabel });

    try {
      for (const sourcePage of queue) {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        setTranslatingPage(sourcePage);
        setFullTranslation((previous) => ({ ...previous, status: "running", currentPage: sourcePage, failedPages, failedReasons }));
        setMessage(`正在翻译全文 · 第 ${sourcePage} 页 · 已完成 ${completed}/${pdf.numPages}`);
        try {
          const source = await getTranslationSource(sourcePage, controller.signal);
          if (source.visualOnly) setMessage(`正在识别并翻译第 ${sourcePage} 页图片 · 已完成 ${completed}/${pdf.numPages}`);
          const { result, translated } = await translatePageSource(sourcePage, source, controller.signal);
          nextTranslations = { ...nextTranslations, [sourcePage]: translated };
          completed = compatibleTranslationPages(nextTranslations, pageSegments).length;
          consecutiveFailures = 0;
          accumulatedUsage = mergeTranslationUsage(accumulatedUsage, result.usage);
          lastProviderLabel = providerDisplayName(result.provider);
          setTranslations(nextTranslations);
          setLastTranslationUsage(result.usage);
          setLastTranslationProvider(lastProviderLabel);
          setLastTranslationPage(sourcePage);
          setFullTranslation({ status: "running", completed, total: pdf.numPages, currentPage: sourcePage, failedPages, failedReasons, usage: accumulatedUsage, providerLabel: lastProviderLabel });
          await persistTranslations(nextTranslations);
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) throw error;
          failedPages = [...failedPages, sourcePage];
          failedReasons = { ...failedReasons, [sourcePage]: error instanceof Error ? error.message : "翻译暂时不可用" };
          consecutiveFailures += 1;
          setFullTranslation((previous) => ({ ...previous, status: "running", currentPage: sourcePage, failedPages, failedReasons }));
          if (consecutiveFailures >= 2) break;
        }
      }

      const completedPages = compatibleTranslationPages(nextTranslations, pageSegments);
      const remaining = buildFullTranslationQueue(pdf.numPages, pageNumber, completedPages);
      if (remaining.length || failedPages.length) {
        setFullTranslation({ status: "failed", completed, total: pdf.numPages, currentPage: 0, failedPages, failedReasons, usage: accumulatedUsage, providerLabel: lastProviderLabel });
        setMessage(`全文翻译已完成 ${completed}/${pdf.numPages} 页${failedPages.length ? ` · ${failedPages.length} 页待重试` : ""}`);
      } else {
        setFullTranslation({ status: "complete", completed: pdf.numPages, total: pdf.numPages, currentPage: 0, failedPages: [], usage: accumulatedUsage, providerLabel: lastProviderLabel });
        setMessage(`全文翻译完成 · ${lastProviderLabel}${accumulatedUsage ? ` · ${usageSummary(accumulatedUsage)}` : ""}`);
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        setFullTranslation((previous) => ({ ...previous, status: "paused", completed, total: pdf.numPages, currentPage: 0, failedPages, failedReasons, usage: accumulatedUsage, providerLabel: lastProviderLabel }));
        setMessage(`已暂停全文翻译 · 完成 ${completed}/${pdf.numPages} 页`);
      } else {
        setFullTranslation((previous) => ({ ...previous, status: "failed", completed, total: pdf.numPages, currentPage: 0, failedPages, failedReasons, usage: accumulatedUsage, providerLabel: lastProviderLabel }));
        setMessage(error instanceof Error ? error.message : "全文翻译暂时不可用");
      }
    } finally {
      if (translationAbortRef.current === controller) translationAbortRef.current = null;
      setTranslationJob(null);
      setTranslatingPage(0);
    }
  };

  const extractTermsForPage = useCallback(async (sourcePage: number, sourceText: string, force = false) => {
    if (!sourceText.trim() || (!force && (paperTerms[sourcePage] || []).length)) return;
    if (!aiTaskProviderAvailable) {
      setTermsError("AI 服务尚未连接，连接后即可按当前页整理术语。");
      return;
    }
    termsAbortRef.current?.abort();
    const controller = new AbortController();
    termsAbortRef.current = controller;
    setExtractingTermsPage(sourcePage);
    setTermsError("");
    try {
      const recovery = await runWithProviderRecovery({
        settings: effectiveAISettings,
        run: async (settings, repairError) => {
          const result = await invokeAI({
            mode: "terms",
            pageText: sourceText.slice(0, 28_000),
            paperTitle: fileName,
            repairError,
          }, settings, controller.signal);
          return { result, extracted: parsePaperTerms(result.answer) };
        },
        onRepair: () => setTermsError(`${effectiveProviderLabel} 正在诊断并重试术语整理任务…`),
      });
      const { extracted } = recovery.value;
      const nextTerms = { ...paperTerms, [sourcePage]: extracted };
      setPaperTerms(nextTerms);
      if (currentPaperId) {
        try {
          await updateStoredPaper(currentPaperId, { terms: nextTerms, termsUpdatedAt: Date.now() });
        } catch (error) {
          console.error("Paper terms persistence failed", error);
        }
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      setTermsError(error instanceof Error ? error.message : "术语整理暂时不可用");
    } finally {
      if (termsAbortRef.current === controller) {
        termsAbortRef.current = null;
        setExtractingTermsPage(0);
      }
    }
  }, [aiTaskProviderAvailable, currentPaperId, effectiveAISettings, effectiveProviderLabel, fileName, paperTerms]);

  useEffect(() => {
    termsAbortRef.current?.abort();
    termsAbortRef.current = null;
    setExtractingTermsPage(0);
    setTermsError("");
  }, [pageNumber]);

  useEffect(() => {
    if (rightTab !== "terms" || !currentText || (paperTerms[pageNumber] || []).length) return;
    void extractTermsForPage(pageNumber, currentText);
  }, [currentText, extractTermsForPage, pageNumber, paperTerms, rightTab]);

  const addFigureToChat = useCallback(async (sourcePage: number, figure: FigureRegion) => {
    if (!pdf) return;
    const attachmentId = `${currentPaperId || fileName}:p${sourcePage}:${figure.id}`;
    if (chatImages.some((image) => image.id === attachmentId)) {
      setChatOpen(true);
      setMessage(`${figure.label} 已在 AI Chat 上下文中`);
      return;
    }
    if (chatImages.length >= 4) {
      setMessage("AI Chat 最多同时引用 4 张图片，请先移除一张");
      setChatOpen(true);
      return;
    }
    setMessage(`正在截取 ${figure.label}…`);
    try {
      const page = await pdf.getPage(sourcePage);
      const viewport = page.getViewport({ scale: 2.2 });
      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = Math.max(1, Math.round(viewport.width));
      sourceCanvas.height = Math.max(1, Math.round(viewport.height));
      await page.render({ canvas: sourceCanvas, viewport, background: "#ffffff" }).promise;
      const sourceX = Math.max(0, Math.floor(figure.rect.x * sourceCanvas.width));
      const sourceY = Math.max(0, Math.floor(figure.rect.y * sourceCanvas.height));
      const sourceWidth = Math.max(1, Math.min(sourceCanvas.width - sourceX, Math.ceil(figure.rect.width * sourceCanvas.width)));
      const sourceHeight = Math.max(1, Math.min(sourceCanvas.height - sourceY, Math.ceil(figure.rect.height * sourceCanvas.height)));
      const maxWidth = 1600;
      const cropScale = Math.min(1, maxWidth / sourceWidth);
      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = Math.max(1, Math.round(sourceWidth * cropScale));
      cropCanvas.height = Math.max(1, Math.round(sourceHeight * cropScale));
      const cropContext = cropCanvas.getContext("2d");
      if (!cropContext) throw new Error("浏览器无法截取资料图片");
      cropContext.fillStyle = "#ffffff";
      cropContext.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
      cropContext.drawImage(sourceCanvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, cropCanvas.width, cropCanvas.height);
      const dataUrl = cropCanvas.toDataURL("image/png");
      const label = `${figure.label} · 第 ${sourcePage} 页`;
      setChatImages((previous) => [...previous, { id: attachmentId, label, source: "paper", pageNumber: sourcePage, dataUrl }]);
      setChatOpen(true);
      setHoveredFigureId(figure.id);
      setMessage(`${figure.label} 已加入 AI Chat 图片上下文`);
      requestAnimationFrame(() => chatInputRef.current?.focus());
    } catch (error) {
      console.error("Figure capture failed", error);
      setMessage(error instanceof Error ? error.message : "资料图片截取失败");
    }
  }, [chatImages, currentPaperId, fileName, pdf]);

  const handleChatPaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const imageItem = Array.from(event.clipboardData.items).find((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (!imageItem) return;
    event.preventDefault();
    if (chatImages.length >= 4) {
      setMessage("AI Chat 最多同时引用 4 张图片，请先移除一张");
      return;
    }
    const file = imageItem.getAsFile();
    if (!file) {
      setMessage("无法读取剪贴板图片");
      return;
    }
    void normalizePastedImage(file).then((dataUrl) => {
      const sequence = chatImages.filter((image) => image.source === "clipboard").length + 1;
      setChatImages((previous) => [...previous, {
        id: `clipboard-${Date.now()}`,
        label: `粘贴图片 ${sequence}`,
        source: "clipboard",
        dataUrl,
      }]);
      setChatOpen(true);
      setMessage("粘贴图片已加入 AI Chat 上下文");
    }).catch((error) => {
      setMessage(error instanceof Error ? error.message : "无法处理粘贴图片");
    });
  }, [chatImages]);

  const selectMentionTarget = useCallback((target: (typeof mentionSuggestions)[number]) => {
    if (!mentionRange) return;
    if (chatPaperMentions.length + chatFolderMentions.length >= 3) {
      setMessage("AI Chat 最多同时引用 3 个资料或文件夹，请先移除一项");
      setMentionRange(null);
      return;
    }
    if (target.kind === "folder") {
      const folder = target.record;
      setChatFolderMentions((previous) => previous.some((candidate) => candidate.id === folder.id) ? previous : [...previous, {
        id: folder.id,
        name: folder.name,
        paperIds: folder.paperIds,
      }]);
      setMessage(`已引用文件夹“${folder.name}”中的 ${folder.paperIds.length} 份资料`);
    } else {
      const paper = target.record;
      setChatPaperMentions((previous) => previous.some((candidate) => candidate.id === paper.id) ? previous : [...previous, {
        id: paper.id,
        displayName: paper.displayName,
        fileName: paper.sourceFileName || paper.fileName,
        aliases: paper.aliases || [],
        repositoryUrl: paper.repositoryUrl,
      }]);
      setMessage(`已引用《${paper.displayName}》`);
    }
    setChatInput((previous) => removeMentionQuery(previous, mentionRange));
    setMentionRange(null);
    setMentionIndex(0);
    requestAnimationFrame(() => chatInputRef.current?.focus());
  }, [chatFolderMentions.length, chatPaperMentions.length, mentionRange]);

  const handleChatInputChange = useCallback((event: ReactChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setChatInput(value);
    setMentionRange(getActivePaperMention(value, event.target.selectionStart ?? value.length));
    setMentionIndex(0);
  }, []);

  const loadReferencedPaperPages = useCallback((paperId: string) => {
    const cached = referencedPaperCacheRef.current.get(paperId);
    if (cached) return cached;
    const pending = (async () => {
      const stored = await getStoredPaper(paperId);
      if (!stored) throw new Error("引用的资料已不在我的空间中");
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const data = new Uint8Array(await stored.file.arrayBuffer());
      const referencedPdf = await pdfjs.getDocument({ data }).promise as unknown as PdfDocument;
      try {
        const pages: PaperPageText[] = [];
        const pageNumbers = Array.from({ length: referencedPdf.numPages }, (_, index) => index + 1);
        for (let offset = 0; offset < pageNumbers.length; offset += 4) {
          const batch = await Promise.all(pageNumbers.slice(offset, offset + 4).map(async (targetPage) => {
            const page = await referencedPdf.getPage(targetPage);
            const content = await page.getTextContent();
            return { pageNumber: targetPage, text: content.items.map((item) => item.str || "").join(" ").replace(/\s+/g, " ").trim() };
          }));
          pages.push(...batch);
        }
        return pages;
      } finally {
        await referencedPdf.destroy?.();
      }
    })();
    referencedPaperCacheRef.current.set(paperId, pending);
    pending.catch(() => referencedPaperCacheRef.current.delete(paperId));
    return pending;
  }, []);

  const loadCurrentPaperPages = useCallback((generation: number) => {
    const cached = currentPaperPageIndexRef.current;
    if (cached?.generation === generation) return cached.pages;
    const sourcePdf = pdfRef.current;
    if (!sourcePdf) return Promise.reject(new Error("当前资料尚未打开"));
    const pending = (async () => {
      const pages: PaperPageText[] = [];
      const pageNumbers = Array.from({ length: sourcePdf.numPages }, (_, index) => index + 1);
      for (let offset = 0; offset < pageNumbers.length; offset += 4) {
        if (!isCurrentDocumentGeneration(generation, documentGenerationRef.current)) throw new DOMException("Aborted", "AbortError");
        const batch = await Promise.all(pageNumbers.slice(offset, offset + 4).map(async (targetPage) => {
          try {
            const page = await sourcePdf.getPage(targetPage);
            const content = await page.getTextContent();
            return { pageNumber: targetPage, text: content.items.map((item) => item.str || "").join(" ").replace(/\s+/g, " ").trim() };
          } catch (error) {
            console.error(`PDF page ${targetPage} chat indexing failed`, error);
            return { pageNumber: targetPage, text: "" };
          }
        }));
        pages.push(...batch);
      }
      if (!isCurrentDocumentGeneration(generation, documentGenerationRef.current)) throw new DOMException("Aborted", "AbortError");
      return pages;
    })();
    currentPaperPageIndexRef.current = { generation, pages: pending };
    pending.catch(() => {
      if (currentPaperPageIndexRef.current?.generation === generation) currentPaperPageIndexRef.current = null;
    });
    return pending;
  }, []);

  const sendChat = async (preset?: string) => {
    if (isChatting) {
      chatAbortRef.current?.abort();
      return;
    }
    const typedQuestion = (preset || chatInput).trim();
    const question = typedQuestion || (chatImages.length ? "请解释这些图片展示的结构、信息流，以及它们与整篇资料方法的关系。" : "");
    if (!question || isChatting) return;
    if (!aiTaskProviderAvailable) {
      setShowConnect(true);
      return;
    }
    const requestGeneration = documentGenerationRef.current;
    const requestPage = pageNumberRef.current;
    const controller = new AbortController();
    chatAbortRef.current = controller;
    const requestIsCurrent = () => (
      chatAbortRef.current === controller
      && !controller.signal.aborted
      && isCurrentDocumentGeneration(requestGeneration, documentGenerationRef.current)
    );
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      text: question,
      imageLabels: chatImages.map((image) => image.label),
      paperLabels: chatPaperMentions.map((paper) => paper.displayName),
      folderLabels: chatFolderMentions.map((folder) => folder.name),
    };
    const history = chatMessages.map(({ role, text }) => ({ role, text }));
    commitChatMessages((previous) => [...previous, userMessage]);
    setChatInput("");
    setChatOpen(true);
    setIsChatting(true);
    setChatStatus(`正在检索整篇 PDF（${pdfRef.current?.numPages || 0} 页）…`);
    try {
      const [chatPageSource, currentPaperPages] = await Promise.all([
        getTranslationSource(requestPage, controller.signal, requestGeneration, setChatStatus),
        loadCurrentPaperPages(requestGeneration),
      ]);
      if (!requestIsCurrent()) return;
      const wholeDocumentContext = buildWholeDocumentChatContext(
        question,
        currentPaperPages,
        requestPage,
        chatPageSource.text,
        pdfRef.current?.numPages || currentPaperPages.length,
      );
      setChatStatus(`已载入全文 ${wholeDocumentContext.indexedPages}/${wholeDocumentContext.totalPages} 个可提取文字页，正在回答…`);
      if (chatPageSource.images.length) {
        commitChatMessages((previous) => previous.map((message) => message.id === userMessage.id
          ? { ...message, imageLabels: [...(message.imageLabels || []), ...chatPageSource.images.map((image) => image.label)] }
          : message));
      }
      const explicitReferencedPapers = await Promise.all(chatPaperMentions.map(async (paper) => {
        const stored = await getStoredPaper(paper.id);
        if (!requestIsCurrent()) throw new DOMException("Aborted", "AbortError");
        if (!stored) throw new Error(`《${paper.displayName}》已不在我的空间中`);
        const pages = (await loadReferencedPaperPages(paper.id)).filter((page) => page.text.trim());
        if (!requestIsCurrent()) throw new DOMException("Aborted", "AbortError");
        return {
          id: paper.id,
          title: stored.displayName || paper.displayName,
          displayName: stored.displayName || paper.displayName,
          fileName: stored.sourceFileName || stored.fileName,
          aliases: buildPaperAliases([...(stored.aliases || []), ...(paper.aliases || [])]),
          repositoryUrl: stored.repositoryUrl || paper.repositoryUrl || "",
          lastOpenedAt: stored.lastOpenedAt,
          folderNames: [] as string[],
          contextScope: "full" as const,
          pages,
        };
      }));
      if (!requestIsCurrent()) return;
      const explicitPaperIds = new Set(explicitReferencedPapers.map((paper) => paper.id));
      const folderMembership = new Map<string, string[]>();
      chatFolderMentions.forEach((folder) => folder.paperIds.forEach((paperId) => {
        if (explicitPaperIds.has(paperId)) return;
        folderMembership.set(paperId, [...new Set([...(folderMembership.get(paperId) || []), folder.name])]);
      }));
      const folderPaperCandidates = [];
      for (const [paperId, folderNames] of folderMembership) {
        const stored = await getStoredPaper(paperId);
        if (!requestIsCurrent()) return;
        if (!stored) continue;
        const pages = await loadReferencedPaperPages(stored.id);
        if (!requestIsCurrent()) return;
        folderPaperCandidates.push({
          id: stored.id,
          title: stored.displayName,
          displayName: stored.displayName,
          fileName: stored.sourceFileName || stored.fileName,
          aliases: stored.aliases || [],
          repositoryUrl: stored.repositoryUrl || "",
          lastOpenedAt: stored.lastOpenedAt,
          folderNames,
          contextScope: "retrieved" as const,
          pages,
        });
      }
      const rankedFolderPapers = rankFolderPaperContexts(
        question,
        folderPaperCandidates,
        Math.max(0, 5 - explicitReferencedPapers.length),
        2,
      );
      const referencedPapers = [...explicitReferencedPapers, ...rankedFolderPapers];
      const repositoryCandidates = buildPaperAliases([repositoryUrl, ...referencedPapers.map((paper) => paper.repositoryUrl)]);
      const activeRepositoryUrl = repositoryCandidates.find((candidate) => candidate.startsWith("http")) || "";
      const recovery = await runWithProviderRecovery({
        settings: effectiveAISettings,
        run: (settings, repairError) => invokeAI({
          mode: activeRepositoryUrl ? "auto" : "chat",
          question,
          pageText: wholeDocumentContext.text,
          selectedText,
          paperTitle: fileName,
          repositoryUrl: activeRepositoryUrl,
          referencedPapers,
          referencedFolders: chatFolderMentions.map((folder) => ({ id: folder.id, name: folder.name, paperCount: folder.paperIds.length })),
          history,
          repairError,
          images: [...chatPageSource.images, ...chatImages].map(({ label, source, pageNumber: imagePageNumber, dataUrl }) => ({ label, source, pageNumber: imagePageNumber, dataUrl })),
        }, settings, controller.signal),
        onRepair: () => setChatStatus(`AI 任务执行异常，${effectiveProviderLabel} 正在诊断并重试…`),
      });
      const result = recovery.value;
      if (!requestIsCurrent()) return;
      commitChatMessages((previous) => [...previous, {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        text: result.answer,
        repositoryUsed: result.repositoryUsed,
        repositoryName: activeRepositoryUrl ? repositoryName(activeRepositoryUrl) : undefined,
        providerLabel: providerDisplayName(result.provider),
        model: result.model,
        usage: result.usage,
        latencyMs: result.latencyMs,
        fallbackReason: result.fallbackReason,
      }]);
    } catch (error) {
      if (requestIsCurrent() && !isAbortError(error)) {
        commitChatMessages((previous) => [...previous, { id: `assistant-error-${Date.now()}`, role: "assistant", text: `暂时没有得到可靠回答：${error instanceof Error ? error.message : "AI 服务调用失败"}` }]);
      }
    } finally {
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null;
        setIsChatting(false);
        setChatStatus("");
        if (isCurrentDocumentGeneration(requestGeneration, documentGenerationRef.current)) {
          requestAnimationFrame(() => chatInputRef.current?.focus());
        }
      }
    }
  };

  const handleChatInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeCompositionEvent(event.nativeEvent)) return;
    if (mentionRange) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((previous) => mentionSuggestions.length ? (previous + direction + mentionSuggestions.length) % mentionSuggestions.length : 0);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && mentionSuggestions.length) {
        event.preventDefault();
        selectMentionTarget(mentionSuggestions[Math.min(mentionIndex, mentionSuggestions.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionRange(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendChat();
    }
  };

  const changeZoom = useCallback((nextZoom: number) => {
    const stage = pdfStageRef.current;
    const centerX = stage ? (stage.scrollLeft + stage.clientWidth / 2) / Math.max(stage.scrollWidth, 1) : .5;
    const centerY = stage ? (stage.scrollTop + stage.clientHeight / 2) / Math.max(stage.scrollHeight, 1) : 0;
    const bounded = Math.round(Math.min(2.5, Math.max(.6, nextZoom)) * 10) / 10;
    setZoom(bounded);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const nextStage = pdfStageRef.current;
      if (!nextStage) return;
      nextStage.scrollLeft = Math.max(0, centerX * nextStage.scrollWidth - nextStage.clientWidth / 2);
      nextStage.scrollTop = Math.max(0, centerY * nextStage.scrollHeight - nextStage.clientHeight / 2);
    }));
  }, []);

  const activateSegment = useCallback((segmentId: string, origin: "source" | "translation", sourcePage = pageNumberRef.current) => {
    if (!segmentId) return;
    setHoveredSegmentId(segmentId);
    if (origin === "source") {
      if (pageNumberRef.current !== sourcePage) {
        pageNumberRef.current = sourcePage;
        setPageNumber(sourcePage);
      }
      setRightTab("translation");
      if (!(translations[sourcePage] || []).some((segment) => segment.id === segmentId)) return;
      requestAnimationFrame(() => {
        const container = document.querySelector<HTMLElement>(".translation-content");
        const target = document.querySelector<HTMLElement>(`[data-translation-segment="${segmentId}"]`);
        if (!container || !target) return;
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        container.scrollTo({ top: container.scrollTop + targetRect.top - containerRect.top - container.clientHeight / 2 + targetRect.height / 2, behavior: "smooth" });
      });
      return;
    }

    const segment = (pageSegments[sourcePage] || []).find((candidate) => candidate.id === segmentId);
    const stage = pdfStageRef.current;
    const frame = pageFrameRefs.current.get(sourcePage);
    if (!segment || !stage || !frame || !segment.rects.length) return;
    const left = Math.min(...segment.rects.map((rect) => rect.x));
    const right = Math.max(...segment.rects.map((rect) => rect.x + rect.width));
    const top = Math.min(...segment.rects.map((rect) => rect.y));
    const bottom = Math.max(...segment.rects.map((rect) => rect.y + rect.height));
    stage.scrollTo({
      left: Math.max(0, frame.offsetLeft + ((left + right) / 2) * frame.offsetWidth - stage.clientWidth / 2),
      top: Math.max(0, frame.offsetTop + ((top + bottom) / 2) * frame.offsetHeight - stage.clientHeight / 2),
      behavior: "smooth",
    });
  }, [pageSegments, translations]);

  const handleSourceHover = useCallback((sourcePage: number, event: ReactMouseEvent<HTMLDivElement>) => {
    if (annotationMode !== "select") return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-segment-id]");
    const segmentId = target?.dataset.segmentId || "";
    if (segmentId && segmentId !== activeSegmentId) activateSegment(segmentId, "source", sourcePage);
  }, [activateSegment, activeSegmentId, annotationMode]);

  const handleSourceClick = useCallback((sourcePage: number, event: ReactMouseEvent<HTMLDivElement>) => {
    if (annotationMode !== "select") return;
    if (selectionMadeRef.current) {
      selectionMadeRef.current = false;
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-segment-id]");
    const segmentId = target?.dataset.segmentId || "";
    const segment = (pageSegments[sourcePage] || []).find((candidate) => candidate.id === segmentId);
    if (!segment) return;
    pageNumberRef.current = sourcePage;
    setPageNumber(sourcePage);
    setContextSegmentId(segment.id);
    setContextSegmentIds([segment.id]);
    setSelectionContextRects([]);
    setChatContextKind("paragraph");
    setSelectedText(segment.text.slice(0, 6_000));
    setPendingSelection(null);
    activateSegment(segment.id, "source", sourcePage);
    setMessage("整段已作为 AI Chat 上下文");
  }, [activateSegment, annotationMode, pageSegments]);

  const clearChatContext = useCallback(() => {
    setSelectedText("");
    setChatContextKind(null);
    setContextSegmentId("");
    setContextSegmentIds([]);
    setSelectionContextRects([]);
    setPendingSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const changePage = useCallback((next: number) => {
    if (!pdf) return;
    const boundedPage = normalizeCommittedPageInput(String(next), pageNumberRef.current, pdf.numPages);
    const previousPage = pageNumberRef.current;
    pageNumberRef.current = boundedPage;
    setPageNumber(boundedPage);
    setPendingSelection(null);
    setSelectedText("");
    setChatContextKind(null);
    setHoveredSegmentId("");
    setContextSegmentId("");
    setContextSegmentIds([]);
    setSelectionContextRects([]);
    requestAnimationFrame(() => {
      const stage = pdfStageRef.current;
      const frame = pageFrameRefs.current.get(boundedPage);
      if (!stage || !frame) return;
      const stageRect = stage.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const targetTop = Math.max(0, stage.scrollTop + frameRect.top - stageRect.top - 16);
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const behavior: ScrollBehavior = !reduceMotion && Math.abs(boundedPage - previousPage) <= 2 ? "smooth" : "auto";
      stage.scrollTo({ top: targetTop, behavior });
    });
  }, [pdf]);

  const commitPageNumberInput = useCallback((raw: string) => {
    if (!pdf) return;
    const committedPage = normalizeCommittedPageInput(raw, pageNumberRef.current, pdf.numPages);
    setPageInput(String(committedPage));
    if (committedPage !== pageNumberRef.current) changePage(committedPage);
  }, [changePage, pdf]);

  const handleStageScroll = useCallback(() => {
    if (scrollSyncFrameRef.current !== null) return;
    scrollSyncFrameRef.current = requestAnimationFrame(() => {
      scrollSyncFrameRef.current = null;
      const stage = pdfStageRef.current;
      if (!stage || !pdf) return;
      const frames = Array.from(pageFrameRefs.current, ([targetPage, frame]) => ({ pageNumber: targetPage, offsetTop: frame.offsetTop, height: frame.offsetHeight }));
      const closestPage = findClosestPageToViewportCenter(stage.scrollTop, stage.clientHeight, frames, pageNumberRef.current);
      if (closestPage === pageNumberRef.current) return;
      pageNumberRef.current = closestPage;
      setPageNumber(closestPage);
      setPendingSelection(null);
      setSelectedText("");
      setChatContextKind(null);
      setHoveredSegmentId("");
      setContextSegmentId("");
      setContextSegmentIds([]);
      setSelectionContextRects([]);
    });
  }, [pdf]);

  const startPanelResize = useCallback((side: ResizeSide, event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 820) return;
    event.preventDefault();
    resizeDragRef.current = { side, startX: event.clientX, startWidths: panelWidths };
    setResizingSide(side);
  }, [panelWidths]);

  const resizePanelFromKeyboard = useCallback((side: ResizeSide, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const deltaX = event.key === "ArrowLeft" ? -16 : 16;
    const width = workspaceShellRef.current?.clientWidth || window.innerWidth;
    setPanelWidths((previous) => resizePanelWidths(side, previous, deltaX, width));
  }, []);

  const startChatResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const height = documentPanelRef.current?.clientHeight || window.innerHeight;
    const startHeight = clampChatHeight(chatHeight, height);
    chatResizeDragRef.current = { startY: event.clientY, startHeight };
    setChatOpen(true);
    setResizingChat(true);
  }, [chatHeight]);

  const resizeChatFromKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    if (!chatOpen) {
      if (event.key === "ArrowUp") setChatOpen(true);
      return;
    }
    const deltaY = event.key === "ArrowUp" ? -16 : 16;
    const height = documentPanelRef.current?.clientHeight || window.innerHeight;
    setChatHeight((previous) => resizeChatHeight(previous, deltaY, height));
  }, [chatOpen]);

  useEffect(() => () => {
    if (scrollSyncFrameRef.current !== null) cancelAnimationFrame(scrollSyncFrameRef.current);
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (event.key === "ArrowLeft") changePage(pageNumber - 1);
      if (event.key === "ArrowRight") changePage(pageNumber + 1);
      if (event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        void translateCurrent();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  if (!isClient) return <main className="workspace-shell hydration-shell" aria-label="正在加载阅读器" />;

  const settingsModal = showConnect ? (
    <AISettingsModal
      settings={aiSettings}
      providers={providers}
      bridgeStatus={bridgeStatus}
      skillAvailable={skillAvailable}
      testStatus={providerTestStatus}
      extensionStoreUrl={extensionStoreUrl}
      onSettingsChange={(settings) => { setAISettings(settings); setProviderTestStatus(""); }}
      onClose={() => setShowConnect(false)}
      onRefresh={() => { setProviderTestStatus(""); void checkCodexBridge(); }}
      onTest={() => void testSelectedProvider()}
      onCodexLogin={() => void connectCodexAccount()}
      onCodexLogout={() => void logoutCodexAccount()}
      onOpenExtensionSetup={() => void openChatGPTWebSetup()}
    />
  ) : null;

  if (appView === "space") {
    return (
      <main
        className={`library-shell ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void loadFile(event.dataTransfer.files?.[0], { folderId: activeFolderId || undefined });
        }}
      >
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept={DOCUMENT_ACCEPT}
          onChange={(event) => {
            void loadFile(event.target.files?.[0], { folderId: activeFolderId || undefined });
            event.currentTarget.value = "";
          }}
        />
        <header className="library-header">
          <div className="library-brand">
            <span className="brand-symbol"><TranslationOutlined /></span>
            <strong>PaperLens</strong>
          </div>
          <nav aria-label="主导航"><span className="active"><HomeOutlined /> 我的空间</span></nav>
          <div className="library-header-actions">
            <button className={`library-bridge ${selectedStatus}`} onClick={() => setShowConnect(true)}>
              <i />
              {selectedStatus === "ready" ? `${selectedProviderLabel} 已连接` : selectedStatus === "checking" ? "正在检测 AI 服务" : aiSettings.provider === "chatgpt-web" ? "ChatGPT 网页 Chat 未连接" : providers["local-codex"]?.installation?.installed ? "Codex 账号未连接或额度暂不可用" : "Codex CLI 未安装"}
            </button>
            <button className="library-import-button" onClick={() => fileInputRef.current?.click()}><PlusOutlined /> 导入文档</button>
          </div>
        </header>

        <section className="library-content">
          <div className="library-intro">
            <div>
              <span className="library-eyebrow">本地优先 · 学习资料工作台</span>
              <h1>我的空间</h1>
              <p>把论文、课程 PPT、讲义和阅读材料放在一起，边读、边译、边问、边记。</p>
            </div>
            <button onClick={() => fileInputRef.current?.click()}><UploadOutlined /> 导入学习资料</button>
          </div>

          <section className="library-folders" aria-labelledby="library-folders-title">
            <div className="section-heading">
              <div>
                <h2 id="library-folders-title">文件夹</h2>
                <span>按研究方向整理资料，也可以在 AI Chat 中 @ 整个文件夹</span>
              </div>
              <button className="create-folder-button" type="button" onClick={() => setCreatingFolder(true)}><PlusOutlined /> 新建文件夹</button>
            </div>
            <div className="folder-card-grid">
              <button className={`folder-card all-papers ${activeFolderId ? "" : "active"}`} type="button" onClick={() => setActiveFolderId("")}>
                <span><FolderOpenOutlined /></span>
                <strong>全部资料</strong>
                <small>{libraryPapers.length} 份</small>
              </button>
              {libraryFolders.map((folder) => {
                const paperCount = libraryPapers.filter((paper) => paper.folderId === folder.id).length;
                return (
                  <article className={`folder-card-shell ${activeFolderId === folder.id ? "active" : ""}`} key={folder.id}>
                    <button className="folder-card" type="button" onClick={() => setActiveFolderId(folder.id)}>
                      <span><FolderOutlined /></span>
                      <strong>{folder.name}</strong>
                      <small>{paperCount} 份资料</small>
                    </button>
                    <button className="folder-delete-button" type="button" title={`删除文件夹 ${folder.name}`} aria-label={`删除文件夹 ${folder.name}`} onClick={() => void removeLibraryFolder(folder)}><DeleteOutlined /></button>
                  </article>
                );
              })}
              {creatingFolder && (
                <form className="folder-create-card" onSubmit={createLibraryFolder}>
                  <FolderOutlined />
                  <input
                    ref={folderNameInputRef}
                    value={folderNameDraft}
                    maxLength={48}
                    placeholder="例如：具身智能"
                    aria-label="文件夹名称"
                    onChange={(event) => setFolderNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setCreatingFolder(false);
                        setFolderNameDraft("");
                      }
                    }}
                  />
                  <div><button type="button" onClick={() => { setCreatingFolder(false); setFolderNameDraft(""); }}>取消</button><button type="submit">创建</button></div>
                </form>
              )}
            </div>
          </section>

          <section className="recent-papers" aria-labelledby="recent-papers-title">
            <div className="section-heading">
              <div>
                <h2 id="recent-papers-title">{activeFolder?.name || "最近阅读"}</h2>
                <span>{activeFolder ? `${visibleLibraryPapers.length} 份资料 · 可在卡片上移动文件夹` : libraryPapers.length ? `${libraryPapers.length} 份资料保存在这台设备` : "导入过的资料会保存在这台设备"}</span>
              </div>
            </div>

            {libraryLoading ? (
              <div className="library-loading" aria-label="正在读取本地资料"><span /><span /><span /></div>
            ) : visibleLibraryPapers.length ? (
              <div className="paper-card-grid">
                {visibleLibraryPapers.map((paper) => (
                  <article className="paper-card-shell" key={paper.id}>
                    <button
                      className="paper-card"
                      onClick={() => void openLibraryPaper(paper)}
                      disabled={openingPaperId === paper.id}
                      aria-label={`打开 ${paper.displayName}`}
                    >
                      <span className="paper-preview">
                        {paper.thumbnail ? (
                          // Browser-generated PDF previews are data URLs and do not
                          // benefit from the server-side image pipeline.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={paper.thumbnail} alt="" />
                        ) : <FilePdfOutlined />}
                        <i>第 {paper.lastPage} 页 / {paper.pageCount} 页</i>
                      </span>
                      <span className="paper-card-body">
                        <strong>{paper.displayName}</strong>
                        <span className="paper-status"><i /> {openingPaperId === paper.id ? "正在打开" : "可继续阅读"}</span>
                        <small>{sourceKindLabel(paper.sourceKind || "pdf")} · {formatLibraryDate(paper.lastOpenedAt)} · {formatFileSize(paper.size)}</small>
                        <em>上次读到第 {paper.lastPage} 页</em>
                      </span>
                    </button>
                    <label className="paper-folder-picker" title="移动到文件夹">
                      <FolderOutlined />
                      <select value={paper.folderId || ""} aria-label={`移动 ${paper.displayName} 到文件夹`} onChange={(event) => void movePaperToFolder(paper, event.target.value)}>
                        <option value="">未归档</option>
                        {libraryFolders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
                      </select>
                    </label>
                    <button className="paper-delete-button" type="button" title={`删除 ${paper.displayName}`} aria-label={`删除 ${paper.displayName}`} onClick={() => void removeLibraryPaper(paper)}><DeleteOutlined /></button>
                  </article>
                ))}
                <button className="add-paper-card" onClick={() => fileInputRef.current?.click()}>
                  <span><PlusOutlined /></span>
                  <strong>导入另一份资料</strong>
                  <small>论文 · 课程 PPT · 讲义 · 阅读材料</small>
                </button>
              </div>
            ) : activeFolder ? (
              <div className="folder-empty">
                <FolderOutlined />
                <strong>“{activeFolder.name}”还是空的</strong>
                <p>回到全部资料，在论文卡片左上角选择这个文件夹；之后便可在 AI Chat 中直接 @{activeFolder.name}。</p>
                <div><button type="button" onClick={() => setActiveFolderId("")}>整理已有资料</button><button type="button" onClick={() => fileInputRef.current?.click()}>导入到此文件夹</button></div>
              </div>
            ) : (
              <button className="library-empty" onClick={() => fileInputRef.current?.click()}>
                <span><FilePdfOutlined /></span>
                <strong>还没有导入学习资料</strong>
                <p>选择论文、课程 PPT、讲义或其他 PDF/Word 文档，之后可以随时继续阅读。</p>
                <i><PlusOutlined /> 导入第一份资料</i>
              </button>
            )}
          </section>
        </section>

        <div className="library-drop-hint"><UploadOutlined /> 松开即可导入文档</div>

        {settingsModal}
      </main>
    );
  }

  return (
    <main
      ref={workspaceShellRef}
      className={`workspace-shell ${resizingSide ? `resizing-${resizingSide}` : ""}`}
      style={{ gridTemplateColumns: `${panelWidths.left}px ${PANEL_RESIZER_WIDTH}px minmax(${MIN_CENTER_PANEL_WIDTH}px, 1fr) ${PANEL_RESIZER_WIDTH}px ${panelWidths.right}px` }}
    >
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept={DOCUMENT_ACCEPT}
        onChange={(event) => {
          void loadFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />

      <aside className="thumbnail-sidebar">
        <div className="app-brand">
          <button className="brand-home-button" title="返回我的空间" aria-label="返回我的空间" onClick={goToWorkspace}>
            <span className="brand-symbol"><TranslationOutlined /></span>
            <strong>PaperLens</strong>
          </button>
          <button title="导入本地文档" aria-label="导入本地文档" onClick={() => fileInputRef.current?.click()}><UploadOutlined /></button>
        </div>
        <div className="thumbnail-list">
          {pdf ? Array.from({ length: Math.min(pdf.numPages, 30) }, (_, index) => {
            const page = index + 1;
            return <Thumbnail key={page} pdf={pdf} pageNumber={page} active={page === pageNumber} onSelect={() => changePage(page)} />;
          }) : (
            <button className="sidebar-empty" onClick={() => fileInputRef.current?.click()}>
              <FilePdfOutlined />
              <span>导入文档</span>
            </button>
          )}
        </div>
      </aside>

      <div
        className="panel-resizer panel-resizer-left"
        role="separator"
        tabIndex={0}
        aria-label="调整缩略图栏和资料阅读区宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_LEFT_PANEL_WIDTH}
        aria-valuemax={MAX_LEFT_PANEL_WIDTH}
        aria-valuenow={panelWidths.left}
        title="拖动调整缩略图栏宽度；双击恢复默认布局"
        onPointerDown={(event) => startPanelResize("left", event)}
        onKeyDown={(event) => resizePanelFromKeyboard("left", event)}
        onDoubleClick={() => setPanelWidths(clampPanelWidths(DEFAULT_PANEL_WIDTHS, workspaceShellRef.current?.clientWidth || window.innerWidth))}
      />

      <section ref={documentPanelRef} className={`document-panel ${mobileView === "paper" ? "mobile-active" : ""}`}>
        <header className="document-header">
          <div className="breadcrumb"><button className="breadcrumb-home" onClick={goToWorkspace}><HomeOutlined /> 我的空间</button> <span>/</span> <strong>{fileName || "未导入文档"}</strong> <DownOutlined /></div>
          <div className="document-actions">
            <button className={`bridge-pill ${selectedStatus}`} onClick={() => setShowConnect(true)} title="本地 AI 接入"><RobotOutlined /> {selectedStatus === "ready" ? selectedProviderLabel : selectedStatus === "checking" ? "检测 AI 服务" : aiSettings.provider === "local-codex" ? "Codex 未连接" : "ChatGPT 未连接"}</button>
            <button onClick={() => fileInputRef.current?.click()}><UploadOutlined /> 更换 PDF</button>
          </div>
        </header>
        <div className="pdf-toolbar">
          <div className="toolbar-group">
            <button title="搜索"><SearchOutlined /></button>
            <button title="上一页" disabled={!pdf || pageNumber <= 1} onClick={() => changePage(pageNumber - 1)}><UpOutlined /></button>
            <input
              aria-label="页码"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pageInput}
              disabled={!pdf}
              onFocus={() => { pageInputFocusedRef.current = true; }}
              onChange={(event) => setPageInput(event.target.value)}
              onBlur={(event) => {
                pageInputFocusedRef.current = false;
                if (skipPageInputBlurCommitRef.current) {
                  skipPageInputBlurCommitRef.current = false;
                  return;
                }
                commitPageNumberInput(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitPageNumberInput(event.currentTarget.value);
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  skipPageInputBlurCommitRef.current = true;
                  setPageInput(String(pageNumberRef.current));
                  event.currentTarget.blur();
                }
              }}
            />
            <span>{pdf?.numPages || 0}</span>
            <button title="下一页" disabled={!pdf || pageNumber >= (pdf?.numPages || 1)} onClick={() => changePage(pageNumber + 1)}><DownOutlined /></button>
          </div>
          <div className="toolbar-group zoom-readout">
            <button title="缩小" disabled={zoom <= .6} onClick={() => changeZoom(zoom - .1)}><ZoomOutOutlined /></button>
            <button className="zoom-reset" title="适合宽度（100%）" onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button>
            <button title="放大" disabled={zoom >= 2.5} onClick={() => changeZoom(zoom + .1)}><ZoomInOutlined /></button>
          </div>
          <div className="annotation-tools" aria-label="资料标注工具">
            <button className={annotationMode === "select" ? "active" : ""} title="选择文字" onClick={() => setAnnotationMode("select")}><SelectOutlined /></button>
            <button className={annotationMode === "highlight" ? "active" : ""} title="马克笔" onClick={() => setAnnotationMode("highlight")}><HighlightOutlined /></button>
            <button className={annotationMode === "comment" ? "active" : ""} title={`按段落评论${comments.length ? `（${comments.length}）` : ""}`} aria-label="按段落评论" onClick={() => setAnnotationMode("comment")}><CommentOutlined /></button>
            <button className={annotationMode === "erase" ? "active" : ""} title="橡皮擦：按住拖动，局部擦除标亮" aria-label="橡皮擦" aria-pressed={annotationMode === "erase"} onClick={() => setAnnotationMode("erase")}><span className="eraser-tool-icon" aria-hidden="true"><i /></span></button>
            <button className={chatOpen ? "active" : ""} title="AI Chat" onClick={() => setChatOpen((value) => !value)}><MessageOutlined /></button>
          </div>
        </div>
        <div
          ref={pdfStageRef}
          className={`pdf-stage ${dragging ? "dragging" : ""} mode-${annotationMode}`}
          onScroll={handleStageScroll}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); loadFile(event.dataTransfer.files?.[0]); }}
        >
          {pdf ? (
            <div className="pdf-document-flow" aria-label="连续资料页面">
              {Array.from({ length: pdf.numPages }, (_, index) => {
                const targetPage = index + 1;
                return (
                  <PdfPageView
                    key={targetPage}
                    pdf={pdf}
                    pageNumber={targetPage}
                    displayWidth={displayPageWidth}
                    pageSize={pageSizes[targetPage] || pageSize}
                    renderContent={shouldRenderPage(targetPage, pageNumber)}
                    isActive={targetPage === pageNumber}
                    segments={pageSegments[targetPage] || []}
                    highlights={highlights[targetPage] || []}
                    comments={comments.filter((comment) => comment.pageNumber === targetPage)}
                    commentEditor={commentEditor?.pageNumber === targetPage ? commentEditor : null}
                    figures={pageFigures[targetPage] || []}
                    activeSegmentId={activeSegmentId}
                    contextSegmentId={contextSegmentId}
                    contextSegmentIds={contextSegmentIds}
                    contextKind={chatContextKind}
                    selectionContextRects={selectionContextRects}
                    pendingSelection={pendingSelection}
                    annotationMode={annotationMode}
                    hoveredFigureId={hoveredFigureId}
                    onRegisterFrame={registerPageFrame}
                    onPageSize={handlePageSize}
                    onPageParsed={handlePageParsed}
                    onStatus={handlePageStatus}
                    onPaperSelection={handlePaperSelection}
                    onSelectionStart={() => {
                      selectionMadeRef.current = false;
                      setPendingSelection(null);
                    }}
                    onSourceHover={handleSourceHover}
                    onSourceLeave={() => setHoveredSegmentId("")}
                    onSourceClick={handleSourceClick}
                    onEraseHighlights={eraseHighlights}
                    onFigureHover={setHoveredFigureId}
                    onAddFigure={(sourcePage, figure) => { void addFigureToChat(sourcePage, figure); }}
                    onAskSelection={askAboutSelection}
                    onHighlightSelection={addHighlight}
                    onStartComment={startComment}
                    onEditComment={editComment}
                    onCommentEditorChange={(content) => setCommentEditor((previous) => previous ? { ...previous, content } : previous)}
                    onSaveComment={saveComment}
                    onCancelComment={() => setCommentEditor(null)}
                    onDeleteComment={deleteComment}
                  />
                );
              })}
            </div>
          ) : (
            <button className="upload-empty" onClick={() => fileInputRef.current?.click()}>
              <FilePdfOutlined />
              <strong>导入学习资料</strong>
              <span>点击选择，或把 PDF、Word、PPT 拖到这里</span>
              <small>PDF 本机解析；Word/PPT 本机转 PDF</small>
            </button>
          )}
        </div>

        <section
          className={`ai-chat-drawer ${chatOpen ? "open" : ""} ${resizingChat ? "resizing" : ""} ${chatImages.length ? "has-images" : ""} ${chatPaperMentions.length || chatFolderMentions.length ? "has-paper-context" : ""}`}
          aria-label="AI Chat"
          style={{ flexBasis: chatOpen ? chatHeight : 40 }}
        >
          <div
            className="chat-height-resizer"
            role="separator"
            tabIndex={0}
            aria-label="调整资料阅读区和 AI Chat 高度"
            aria-orientation="horizontal"
            aria-valuemin={40}
            aria-valuemax={Math.max(MIN_CHAT_HEIGHT, (documentPanelRef.current?.clientHeight || 900) - MIN_READER_CONTENT_HEIGHT)}
            aria-valuenow={chatOpen ? chatHeight : 40}
            title="上下拖动调整 AI Chat 高度；双击恢复默认高度"
            onPointerDown={startChatResize}
            onKeyDown={resizeChatFromKeyboard}
            onDoubleClick={() => { setChatOpen(true); setChatHeight(clampChatHeight(DEFAULT_CHAT_HEIGHT, documentPanelRef.current?.clientHeight || window.innerHeight)); }}
          />
          <div className="chat-drawer-header">
            <button className="chat-drawer-toggle" onClick={() => setChatOpen((value) => !value)} aria-expanded={chatOpen}>
              <span><RobotOutlined /> AI Chat</span>
              <span className={`bridge-status ${selectedStatus}`}><i /> {selectedStatus === "ready" ? selectedProviderLabel : "未连接"}</span>
              {selectedText && <span className="collapsed-context">已引用：{selectedText.slice(0, 46)}</span>}
              {!!chatPaperMentions.length && <span className="collapsed-papers"><FilePdfOutlined /> {chatPaperMentions.length} 份资料</span>}
              {!!chatFolderMentions.length && <span className="collapsed-folders"><FolderOutlined /> {chatFolderMentions.length} 个文件夹</span>}
              {!!chatImages.length && <span className="collapsed-images"><PictureOutlined /> {chatImages.length} 张图片</span>}
              <DownOutlined className="drawer-arrow" />
            </button>
            {repositoryUrl && <a className="collapsed-repo" href={repositoryUrl} target="_blank" rel="noreferrer" title={`在 GitHub 打开 ${repositoryName(repositoryUrl)}`} aria-label={`在 GitHub 打开仓库 ${repositoryName(repositoryUrl)}`}><i /><GithubOutlined /><span>GitHub</span><b>{repositoryName(repositoryUrl)}</b><ExportOutlined /></a>}
          </div>
          {chatOpen && (
            <div className="chat-drawer-body">
              <div className="chat-context-row">
                {selectedText ? <button className="context-chip" title={selectedText} onClick={clearChatContext}><span>{chatContextKind === "paragraph" ? "整段" : "选区"}</span>{selectedText.slice(0, 54)}<CloseCircleOutlined /></button> : <span className="context-hint">整篇资料已作为基础上下文；单击可重点引用整段，拖选则引用选中文字</span>}
                {repositoryUrl && <a className="repo-chip active connected" href={repositoryUrl} target="_blank" rel="noreferrer" title={`在 GitHub 打开 ${repositoryName(repositoryUrl)}`} aria-label={`在 GitHub 打开仓库 ${repositoryName(repositoryUrl)}`}><GithubOutlined /><strong>{repositoryName(repositoryUrl)}</strong><i>按问题动态核实</i><ExportOutlined /></a>}
              </div>
              <div className="chat-messages">
                {!chatMessages.length ? (
                  <div className="chat-empty">
                    <strong>针对整篇资料或选中内容提问</strong>
                    <span>默认引用全部可提取文字页并保留页码；代码实现问题会回退到本机 Codex 核实仓库。</span>
                    <div>
                      <button onClick={() => void sendChat("用直觉解释选中的这段内容")}>直觉解释</button>
                      <button onClick={() => void sendChat("这段内容在整份资料里起什么作用？")}>内容位置</button>
                      <button onClick={() => void sendChat("这里最容易误解的点是什么？")}>避免误解</button>
                    </div>
                  </div>
                ) : chatMessages.map((item) => <div key={item.id} className={`chat-message ${item.role}`}><span>{item.role === "assistant" ? <RobotOutlined /> : "你"}</span><div>{item.role === "assistant" ? <ChatMarkdown text={item.text} /> : <p>{item.text}</p>}{item.folderLabels?.length ? <small className="message-folders"><FolderOutlined /> {item.folderLabels.join("、")}</small> : null}{item.paperLabels?.length ? <small className="message-papers"><FilePdfOutlined /> {item.paperLabels.join("、")}</small> : null}{item.imageLabels?.length ? <small className="message-images"><PictureOutlined /> {item.imageLabels.join("、")}</small> : null}{item.role === "assistant" && item.repositoryUsed !== undefined ? <small className={`message-repository ${item.repositoryUsed ? "verified" : "skipped"}`}><GithubOutlined /> {item.repositoryUsed ? `已核实 ${item.repositoryName}` : "本次无需读取仓库"}</small> : null}{item.role === "assistant" && (item.providerLabel || item.usage) ? <small className="message-provider">{item.fallbackReason ? `${item.fallbackReason} · ` : ""}{item.providerLabel}{item.usage ? ` · ${usageSummary(item.usage)}` : ""}{item.latencyMs ? ` · ${(item.latencyMs / 1000).toFixed(1)}s` : ""}</small> : null}</div></div>)}
                {isChatting && <div className="chat-message assistant loading"><span><RobotOutlined /></span><p>{chatStatus || (chatFolderMentions.length ? `${selectedProviderLabel} 正在检索文件夹中的相关资料与证据页…` : repositoryUrl || chatPaperMentions.some((paper) => paper.repositoryUrl) ? `${selectedProviderLabel} 正在载入引用资料全文并判断是否需要核实仓库…` : chatPaperMentions.length ? `${selectedProviderLabel} 正在载入引用资料全文…` : `${selectedProviderLabel} 正在阅读全文上下文…`)}</p></div>}
              </div>
              <div className="chat-composer">
                {mentionRange && (
                  <div className="paper-mention-menu" role="listbox" aria-label="从我的空间引用资料或文件夹">
                    <header><FolderOpenOutlined /><strong>引用资料或文件夹</strong><span>最多 3 项</span></header>
                    {mentionSuggestions.length ? mentionSuggestions.map((suggestion, index) => {
                      const label = suggestion.kind === "folder" ? suggestion.record.name : suggestion.record.displayName;
                      const detail = suggestion.kind === "folder"
                        ? `${suggestion.record.paperIds.length} 份资料 · 将按问题检索整个文件夹`
                        : (() => {
                            const paper = suggestion.record;
                            const aliases = buildPaperAliases([...(paper.aliases || []), paper.sourceFileName || paper.fileName, repositoryAlias(paper.repositoryUrl || "")]).filter((alias) => alias !== paper.displayName).slice(0, 3);
                            return aliases.length ? `${paper.pageCount} 页 · 全文引用 · 也可通过 ${aliases.join(" · ")} 找到` : `${paper.pageCount} 页 · 全文引用`;
                          })();
                      return (
                        <button
                          key={`${suggestion.kind}-${suggestion.record.id}`}
                          type="button"
                          role="option"
                          aria-selected={index === mentionIndex}
                          className={index === mentionIndex ? "active" : ""}
                          onMouseEnter={() => setMentionIndex(index)}
                          onMouseDown={(event) => { event.preventDefault(); selectMentionTarget(suggestion); }}
                        >
                          {suggestion.kind === "folder" ? <FolderOutlined /> : <FilePdfOutlined />}
                          <span>
                            <strong>{label}</strong>
                            <small>{detail}</small>
                          </span>
                          <PlusOutlined />
                        </button>
                      );
                    }) : <div className="paper-mention-empty">{libraryPapers.length <= 1 && !folderMentionRecords.length ? "我的空间还没有其他资料或文件夹" : `没有找到“${mentionRange.query}”`}</div>}
                  </div>
                )}
                {!!chatFolderMentions.length && (
                  <div className="chat-folder-mentions" aria-label="已引用的空间文件夹">
                    {chatFolderMentions.map((folder) => (
                      <button key={folder.id} type="button" title={`移除文件夹“${folder.name}”`} onClick={() => setChatFolderMentions((previous) => previous.filter((candidate) => candidate.id !== folder.id))}>
                        <FolderOutlined /><span>{folder.name} · {folder.paperIds.length} 份</span><CloseOutlined />
                      </button>
                    ))}
                  </div>
                )}
                {!!chatPaperMentions.length && (
                  <div className="chat-paper-mentions" aria-label="已引用的空间资料">
                    {chatPaperMentions.map((paper) => (
                      <button key={paper.id} type="button" title={`移除《${paper.displayName}》`} onClick={() => setChatPaperMentions((previous) => previous.filter((candidate) => candidate.id !== paper.id))}>
                        <FilePdfOutlined /><span>{paper.displayName}</span><CloseOutlined />
                      </button>
                    ))}
                  </div>
                )}
                {!!chatImages.length && (
                  <div className="chat-attachments" aria-label="图片上下文">
                    {chatImages.map((image) => (
                      <figure key={image.id} className="chat-attachment">
                        {/* Local clipboard/PDF crops are data URLs and cannot use the server image pipeline. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={image.dataUrl} alt={image.label} />
                        <figcaption><PictureOutlined /> {image.label}</figcaption>
                        <button type="button" aria-label={`移除 ${image.label}`} onClick={() => setChatImages((previous) => previous.filter((candidate) => candidate.id !== image.id))}><CloseOutlined /></button>
                      </figure>
                    ))}
                  </div>
                )}
                <div className="chat-composer-row">
                  <textarea ref={chatInputRef} value={chatInput} onChange={handleChatInputChange} onPaste={handleChatPaste} onKeyDown={handleChatInputKeyDown} placeholder={chatImages.length ? "询问图片；输入 @ 还可引用其他资料或文件夹…" : repositoryUrl ? "问整篇资料或代码实现；输入 @ 引用其他资料或文件夹…" : "问整篇资料；输入 @ 引用其他资料或文件夹…"} />
                  <button disabled={!isChatting && !chatInput.trim() && !chatImages.length} onClick={() => void sendChat()} aria-label={isChatting ? "停止生成" : "发送问题"}>{isChatting ? <CloseOutlined /> : <SendOutlined />}</button>
                </div>
              </div>
            </div>
          )}
        </section>
      </section>

      <div
        className="panel-resizer panel-resizer-right"
        role="separator"
        tabIndex={0}
        aria-label="调整资料阅读区和翻译栏宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_RIGHT_PANEL_WIDTH}
        aria-valuemax={MAX_RIGHT_PANEL_WIDTH}
        aria-valuenow={panelWidths.right}
        title="拖动调整翻译栏宽度；双击恢复默认布局"
        onPointerDown={(event) => startPanelResize("right", event)}
        onKeyDown={(event) => resizePanelFromKeyboard("right", event)}
        onDoubleClick={() => setPanelWidths(clampPanelWidths(DEFAULT_PANEL_WIDTHS, workspaceShellRef.current?.clientWidth || window.innerWidth))}
      />

      <aside className={`translation-panel ${mobileView === "translation" ? "mobile-active" : ""}`}>
        <nav className="right-tabs">
          <button className={rightTab === "translation" ? "active" : ""} onClick={() => setRightTab("translation")}>翻译</button>
          <button className={rightTab === "outline" ? "active" : ""} onClick={() => setRightTab("outline")}>内容</button>
          <button className={rightTab === "terms" ? "active" : ""} onClick={() => setRightTab("terms")}>术语</button>
          <button className={rightTab === "notes" ? "active" : ""} onClick={() => setRightTab("notes")}>笔记</button>
        </nav>
        <div className="translation-toolbar">
          <div>
            <button title="上一页" disabled={!pdf || pageNumber <= 1} onClick={() => changePage(pageNumber - 1)}><LeftOutlined /></button>
            <button title="下一页" disabled={!pdf || pageNumber >= (pdf?.numPages || 1)} onClick={() => changePage(pageNumber + 1)}><RightOutlined /></button>
          </div>
          <div>
            <button title={isTranslating ? "停止翻译" : currentTranslation ? `重新翻译（${selectedProviderLabel}）` : `翻译当前页（${selectedProviderLabel}）`} disabled={!pdf} onClick={translateCurrent}>{isTranslating ? <CloseOutlined /> : currentTranslation ? <ReloadOutlined /> : <TranslationOutlined />}</button>
            <button className="translate-all-button" title={fullTranslationLabel} disabled={!pdf || fullTranslation.status === "complete"} onClick={() => void translateFullPaper()}>{translationJob === "full" ? <CloseOutlined /> : fullTranslation.status === "paused" || fullTranslation.status === "failed" ? <ReloadOutlined /> : <TranslationOutlined />}<span>{fullTranslationLabel}</span></button>
            <button title="复制译文" disabled={!currentTranslation} onClick={() => navigator.clipboard.writeText(currentTranslation)}><CopyOutlined /></button>
            <button title="AI 服务设置" onClick={() => setShowConnect(true)}><SettingOutlined /></button>
            <button title="简体中文"><GlobalOutlined /></button>
          </div>
        </div>

        {(fullTranslation.status !== "idle" || fullTranslation.completed > 0) && (
          <div className={`full-translation-progress ${fullTranslation.status}`}>
            <div><span>{fullTranslationStatusText}</span><strong>{fullTranslation.completed}/{fullTranslation.total || pdf?.numPages || 0}</strong></div>
            <progress value={fullTranslation.completed} max={Math.max(1, fullTranslation.total || pdf?.numPages || 1)} />
            {fullTranslation.failedReasons && Object.keys(fullTranslation.failedReasons).length > 0 && (
              <small className="translation-failure-reasons">{Object.entries(fullTranslation.failedReasons).map(([failedPage, reason]) => `第 ${failedPage} 页：${reason}`).join("；")}</small>
            )}
            {fullTranslation.usage && <small>{fullTranslation.providerLabel} · {usageSummary(fullTranslation.usage)}</small>}
          </div>
        )}

        <div className="translation-content">
          {rightTab === "translation" && (
            <TranslationView
              pageNumber={pageNumber}
              sourceSegments={currentSegments}
              translatedSegments={currentTranslatedSegments}
              loading={isTranslating && translatingPage === pageNumber && !currentTranslation}
              hasPdf={!!pdf}
              activeSegmentId={activeSegmentId}
              contextSegmentId={contextSegmentId}
              contextSegmentIds={contextSegmentIds}
              contextKind={chatContextKind}
              onActivate={(segmentId) => activateSegment(segmentId, "translation")}
              onDeactivate={() => setHoveredSegmentId("")}
              onTranslate={translateCurrent}
              onTranslateAll={() => void translateFullPaper()}
              fullTranslationLabel={fullTranslationLabel}
              onImport={() => fileInputRef.current?.click()}
              providerLabel={lastTranslationPage === pageNumber && lastTranslationProvider ? lastTranslationProvider : selectedProviderLabel}
              usage={lastTranslationPage === pageNumber ? lastTranslationUsage : undefined}
            />
          )}
          {rightTab === "outline" && (
            <OutlineView
              items={paperOutline}
              currentPage={pageNumber}
              status={outlineStatus}
              progress={outlineProgress}
              error={outlineError}
              onSelect={changePage}
              onRetry={() => void loadPaperOutline()}
            />
          )}
          {rightTab === "terms" && (
            <TermsView
              pageNumber={pageNumber}
              hasText={!!currentText}
              terms={paperTerms[pageNumber] || []}
              loading={extractingTermsPage === pageNumber}
              error={termsError}
              onRefresh={() => void extractTermsForPage(pageNumber, currentText, true)}
            />
          )}
          {rightTab === "notes" && <textarea className="notes-area" value={notes[pageNumber] || ""} onChange={(event) => updatePageNote(event.target.value)} placeholder="记录这一页的理解、疑问或实验启发…（自动保存）" />}
        </div>

        {rightTab === "translation" && !currentTranslation && (
          <div className="translation-footer">
            <span>{message}</span>
            <div>
              <button disabled={!pdf || translationJob === "full"} onClick={translateCurrent}>{translationJob === "page" ? <CloseOutlined /> : <TranslationOutlined />} {translationJob === "page" ? "停止翻译" : "翻译本页"}</button>
            </div>
          </div>
        )}
      </aside>

      <div className="mobile-switch" role="tablist" aria-label="移动端视图">
        <button className={mobileView === "paper" ? "active" : ""} onClick={() => setMobileView("paper")}><FilePdfOutlined /> 原文</button>
        <button className={mobileView === "translation" ? "active" : ""} onClick={() => setMobileView("translation")}><TranslationOutlined /> 翻译</button>
      </div>

      {settingsModal}

    </main>
  );
}

function Thumbnail({ pdf, pageNumber, active, onSelect }: { pdf: PdfDocument; pageNumber: number; active: boolean; onSelect: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let renderTask: PdfRenderTask | null = null;
    const draw = async () => {
      const page = await pdf.getPage(pageNumber);
      const logicalViewport = page.getViewport({ scale: .22 });
      const outputScale = getPdfOutputScale(logicalViewport.width, logicalViewport.height);
      const renderViewport = page.getViewport({ scale: .22 * outputScale });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      canvas.width = Math.max(1, Math.round(renderViewport.width));
      canvas.height = Math.max(1, Math.round(renderViewport.height));
      canvas.dataset.outputScale = outputScale.toFixed(3);
      renderTask = page.render({ canvas, viewport: renderViewport, background: "#ffffff" });
      await renderTask.promise;
    };
    void draw().catch((error: unknown) => {
      if (!cancelled && !(error instanceof Error && error.name === "RenderingCancelledException")) {
        console.error(`PDF thumbnail ${pageNumber} render failed`, error);
      }
    });
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [pageNumber, pdf]);

  return (
    <button className={`thumbnail-item ${active ? "active" : ""}`} onClick={onSelect} aria-label={`第 ${pageNumber} 页`}>
      <canvas ref={canvasRef} />
      <span className="thumbnail-label"><i>{active ? <CheckOutlined /> : null}</i>第 {pageNumber} 页</span>
    </button>
  );
}

function TranslationView({ pageNumber, sourceSegments, translatedSegments, loading, hasPdf, activeSegmentId, contextSegmentId, contextSegmentIds, contextKind, onActivate, onDeactivate, onTranslate, onTranslateAll, fullTranslationLabel, onImport, providerLabel, usage }: {
  pageNumber: number;
  sourceSegments: PageSegment[];
  translatedSegments: TranslatedSegment[];
  loading: boolean;
  hasPdf: boolean;
  activeSegmentId: string;
  contextSegmentId: string;
  contextSegmentIds: string[];
  contextKind: ChatContextKind | null;
  onActivate: (segmentId: string) => void;
  onDeactivate: () => void;
  onTranslate: () => void;
  onTranslateAll: () => void;
  fullTranslationLabel: string;
  onImport: () => void;
  providerLabel: string;
  usage?: AIUsage;
}) {
  if (!hasPdf) {
    return <div className="right-empty"><FilePdfOutlined /><strong>先导入一份学习资料</strong><span>右侧会显示当前页的完整中文翻译</span><button onClick={onImport}>导入文档</button></div>;
  }
  if (loading) {
    return <div className="translation-loading"><span /><span /><span /><span /><span /></div>;
  }
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translationCompatible = isPageTranslationCompatible(pageNumber, translatedSegments, sourceSegments);
  if (!translationCompatible) {
    const needsRefresh = translatedSegments.length > 0;
    return <div className="right-empty"><TranslationOutlined /><strong>{needsRefresh ? `第 ${pageNumber} 页译文需要更新` : `第 ${pageNumber} 页尚未翻译`}</strong><span>{needsRefresh ? "原文段落结构已更新，本页会自动重新加入全文翻译队列" : sourceSegments.length ? `由 ${providerLabel} 保留公式、引用和专业术语` : "若本页没有文字层，将自动读取整页图片"}</span><div className="right-empty-actions"><button onClick={onTranslate}>{needsRefresh ? "重新翻译本页" : "翻译本页"}</button><button className="secondary" onClick={onTranslateAll}>{fullTranslationLabel}</button></div></div>;
  }
  const compatibleTranslations = translatedSegments;
  const sourceReady = sourceSegments.length > 0;
  const synchronized = sourceReady && translatedSegments.every((segment) => sourceById.has(segment.id));
  const visualPage = isVisualPageSegments(sourceSegments) || compatibleTranslations.some((segment) => /-visual$/.test(segment.id));
  return (
    <article className="translated-article">
      <div className="article-kicker">第 {pageNumber} 页 · {providerLabel} 中文译文 · {visualPage ? "整页视觉识别" : synchronized ? "段落同步已开启" : sourceReady ? "译文已缓存" : "正在恢复段落同步"}{usage ? ` · ${usageSummary(usage)}` : ""}</div>
      {compatibleTranslations.map((segment) => {
        const source = sourceById.get(segment.id);
        const heading = source?.kind === "heading";
        const active = segment.id === activeSegmentId;
        const context = contextSegmentIds.includes(segment.id);
        return (
          <section
            key={segment.id}
            data-translation-segment={segment.id}
            className={`translated-segment ${active ? "active" : ""} ${context ? "context" : ""}`}
            tabIndex={0}
            onMouseEnter={() => onActivate(segment.id)}
            onMouseMove={() => {
              if (!active) onActivate(segment.id);
            }}
            onMouseLeave={onDeactivate}
            onFocus={() => onActivate(segment.id)}
            onBlur={onDeactivate}
            onClick={() => onActivate(segment.id)}
          >
            {(active || (context && segment.id === contextSegmentId)) && <span className="sync-translation-label">{context ? contextKind === "selection" ? "选区所属译文" : "整段上下文" : "对应原文"}</span>}
            {visualPage ? <ChatMarkdown text={segment.translation} /> : heading ? <h3><ScientificText text={segment.translation} /></h3> : <p><ScientificText text={segment.translation} /></p>}
            {segment.formulaExplanation && (
              <aside className="formula-explanation">
                <strong>公式解释</strong>
                <span><ScientificText text={segment.formulaExplanation} /></span>
              </aside>
            )}
          </section>
        );
      })}
    </article>
  );
}

function OutlineView({ items, currentPage, status, progress, error, onSelect, onRetry }: {
  items: PaperOutlineItem[];
  currentPage: number;
  status: OutlineStatus;
  progress: { completed: number; total: number };
  error: string;
  onSelect: (pageNumber: number) => void;
  onRetry: () => void;
}) {
  return (
    <div className="outline-view">
      <header>
        <div><h3>全文目录</h3><span>{items.length ? `${items.length} 个章节 · 点击标题跳转` : "按论文大标题生成"}</span></div>
      </header>
      {status === "loading" ? (
        <div className="outline-loading" role="status" aria-live="polite">
          <span>正在读取全文结构…</span>
          <progress value={progress.completed} max={Math.max(1, progress.total)} />
          <small>{progress.completed}/{progress.total} 页</small>
        </div>
      ) : status === "failed" ? (
        <div className="outline-empty"><p>{error || "全文目录读取失败"}</p><button type="button" onClick={onRetry}>重新读取</button></div>
      ) : items.length ? (
        <nav aria-label="论文全文目录">
          {items.map((item, index) => (
            <button
              type="button"
              key={item.id}
              className={item.pageNumber === currentPage ? "active" : ""}
              style={{ paddingLeft: `${8 + Math.min(item.level, 4) * 14}px` }}
              onClick={() => onSelect(item.pageNumber)}
              aria-label={`${item.title}，第 ${item.pageNumber} 页`}
            >
              <span className="outline-index">{String(index + 1).padStart(2, "0")}</span>
              <strong>{item.title}</strong>
              <span className="outline-page">{item.pageNumber}</span>
            </button>
          ))}
        </nav>
      ) : (
        <div className="outline-empty"><p>这份资料没有可识别的章节标题。</p><span>如果 PDF 含有文字层，PaperLens 会识别 Abstract、Introduction、Method 等大标题。</span></div>
      )}
    </div>
  );
}

function TermsView({ pageNumber, hasText, terms, loading, error, onRefresh }: {
  pageNumber: number;
  hasText: boolean;
  terms: PaperTerm[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  return (
    <div className="terms-view">
      <header>
        <div><h3>本页术语</h3><span>第 {pageNumber} 页 · 根据当前资料内容动态整理</span></div>
        <button type="button" disabled={!hasText || loading} onClick={onRefresh}><ReloadOutlined /> {terms.length ? "重新提取" : "提取术语"}</button>
      </header>
      {loading ? (
        <div className="terms-loading" aria-label={`正在整理第 ${pageNumber} 页术语`}><span /><span /><span /><span /></div>
      ) : error ? (
        <section className="terms-error"><p>{error}</p><button type="button" onClick={onRefresh}>重试</button></section>
      ) : terms.length ? terms.map((item) => (
        <div className="term-row" key={item.term}><strong>{item.term}</strong><span>{item.translation}</span></div>
      )) : <p>{hasText ? "正在准备本页术语…" : "导入资料后，这里会按当前页动态整理专业术语。"}</p>}
    </div>
  );
}
