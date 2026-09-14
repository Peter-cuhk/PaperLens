import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the PaperLens reader shell and metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>PaperLens · 学习资料阅读与理解工作台<\/title>/i);
  assert.match(html, /面向论文、课程 PPT、讲义和阅读材料的本地优先工作台/);
  assert.match(html, /class="workspace-shell hydration-shell"/);
  assert.match(html, /aria-label="正在加载阅读器"/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("keeps local learning-material reading, direct Codex calls, scrolling, zoom, and mobile controls wired", async () => {
  const [page, segmentation, translationResponse, aiRecovery, bridge, converter, devScript, usbGateway, layout, styles, pdfWorker] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page-segmentation.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/translation-response.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/ai-recovery.ts", import.meta.url), "utf8"),
    readFile(new URL("../bridge/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../bridge/document-converter.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/usb-gateway.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../public/pdf.worker.min.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(page, /const DOCUMENT_ACCEPT = \[/);
  assert.match(page, /"\.docx"/);
  assert.match(page, /"\.pptx"/);
  assert.match(page, /accept=\{DOCUMENT_ACCEPT\}/);
  assert.match(page, /convertDocumentToPdf/);
  assert.match(page, /\/convert-document/);
  assert.match(page, /sourceFileName\?: string/);
  assert.match(page, /sourceKind\?: SourceDocumentKind/);
  assert.match(page, /type AppView = "space" \| "reader"/);
  assert.match(page, /const LIBRARY_DB = "paperlens-local-library"/);
  assert.match(page, /本地优先 · 学习资料工作台/);
  assert.match(page, /论文、课程 PPT、讲义和阅读材料/);
  assert.match(page, /导入学习资料/);
  assert.match(page, /indexedDB\.open\(LIBRARY_DB, 2\)/);
  assert.match(page, /createObjectStore\(LIBRARY_STORE, \{ keyPath: "id" \}\)/);
  assert.match(page, /createObjectStore\(LIBRARY_FOLDER_STORE, \{ keyPath: "id" \}\)/);
  assert.match(page, /putStoredFolder/);
  assert.match(page, /movePaperToFolder/);
  assert.match(page, /searchMentionTargets/);
  assert.match(page, /rankFolderPaperContexts/);
  assert.match(page, /putStoredPaper/);
  assert.match(page, /getStoredPaper/);
  assert.match(page, /createPdfThumbnail/);
  assert.match(page, /我的空间/);
  assert.match(page, /返回我的空间/);
  assert.match(page, /上次读到第 \{paper\.lastPage\} 页/);
  assert.match(page, /pdfjs\.getDocument\(\{ data \}\)/);
  assert.match(page, /pdfjs-dist\/legacy\/build\/pdf\.mjs/);
  assert.doesNotMatch(page, /import\("pdfjs-dist"\)/);
  assert.match(page, /page\.render\(\{ canvas, viewport, background: "#ffffff" \}\)/);
  assert.match(page, /function getPdfOutputScale\(width: number, height: number\)/);
  assert.match(page, /window\.devicePixelRatio/);
  assert.match(page, /const logicalScale = displayWidth \/ baseViewport\.width/);
  assert.match(page, /viewport: renderViewport/);
  assert.match(page, /canvas\.dataset\.outputScale/);
  assert.match(page, /\[displayWidth,[^\]]*pageNumber,[^\]]*pdf/);
  assert.match(page, /await renderTask\.promise[\s\S]*await page\.getTextContent\(\)/);
  assert.match(page, /import\("pdfjs-dist\/web\/pdf_viewer\.mjs"\)/);
  assert.match(page, /new TextLayerBuilder\([\s\S]{0,500}await textLayerBuilder\.render\([\s\S]{0,500}textLayer\.style\.width = `\$\{logicalViewport\.width\}px`/);
  assert.match(page, /renderTask\?\.cancel\(\)/);
  assert.match(page, /pdf\.numPages/);
  assert.match(page, /getTextContent\(\)/);
  assert.match(page, /CODEX_BRIDGE/);
  assert.match(page, /const CODEX_BRIDGE = "\/api\/codex"/);
  assert.match(page, /const CODEX_TUTORIAL_URL = "https:\/\/learn\.chatgpt\.com\/docs\/quickstart"/);
  assert.match(page, /Codex 使用教程/);
  assert.match(page, /href=\{CODEX_TUTORIAL_URL\} target="_blank" rel="noreferrer"/);
  assert.match(page, /mode: "translate"/);
  assert.match(page, /mode: "terms"/);
  assert.match(page, /parsePaperTerms/);
  assert.match(page, /termsUpdatedAt/);
  assert.match(page, /notes\?: Record<number, string>/);
  assert.match(page, /notesUpdatedAt/);
  assert.match(page, /setNotes\(existingStored\?\.notes \|\| \{\}\)/);
  assert.match(page, /noteSaveQueueRef\.current = noteSaveQueueRef\.current/);
  assert.match(page, /updateStoredPaper\(currentPaperId, \{ notes: nextNotes, notesUpdatedAt: Date\.now\(\) \}\)/);
  assert.match(page, /value=\{notes\[pageNumber\] \|\| ""\}/);
  assert.match(page, /自动保存/);
  assert.doesNotMatch(page, /embodied agent/);
  assert.match(page, /buildFullTranslationQueue/);
  assert.match(page, /translateFullPaper/);
  assert.match(page, /MAX_TRANSLATION_REPAIR_ATTEMPTS/);
  assert.match(page, /completeTranslationWithRepair/);
  assert.match(page, /Codex 正在诊断并修复/);
  assert.match(page, /修复仍失败才会显示最终错误/);
  assert.match(page, /runWithCodexRecovery/);
  assert.match(aiRecovery, /provider: "local-codex"/);
  assert.match(bridge, /这是第 \$\{repairAttempt\} 次 Codex 自动修复请求/);
  assert.match(bridge, /不要只复述错误/);
  assert.match(page, /renderPdfPageForVision/);
  assert.match(page, /shouldUseVisualPageTranslation/);
  assert.match(page, /visualPage \? <ChatMarkdown text=\{recoverTranslationNewlines\(segment\.translation\)\} \/>/);
  assert.match(page, /visualPage: source\.visualOnly/);
  assert.match(page, /第 \$\{sourcePage\} 页没有文字层，正在生成整页图片/);
  assert.match(page, /翻译全文/);
  assert.match(page, /compatibleTranslationPages\(restoredTranslations\)/);
  assert.match(page, /const completedTranslationCount = useMemo\(\(\) => compatibleTranslationPages\(translations, pageSegments\)/);
  assert.match(page, /aria-label="全文翻译完成进度" value=\{completedTranslationCount\}/);
  assert.match(page, /isPageTranslationCompatible\(pageNumber, translatedSegments, sourceSegments\)/);
  assert.match(page, /译文需要更新/);
  assert.match(page, /请重新翻译本页或继续全文翻译/);
  assert.match(page, /extractEmbeddedPaperOutline/);
  assert.match(page, /buildDetectedPaperOutline/);
  assert.match(page, /全文目录/);
  assert.match(page, /onSelect=\{changePage\}/);
  assert.match(page, /rightTab === "translation" && !currentTranslation/);
  assert.match(page, /translationUpdatedAt/);
  assert.match(page, /persistTranslations/);
  assert.match(page, /mode: activeRepositoryUrl \? "auto" : "chat"/);
  assert.match(page, /getTranslationSource\(requestPage, controller\.signal, requestGeneration, setChatStatus\)/);
  assert.match(page, /onRepair: \(\) => setChatStatus\("AI 任务执行异常，Codex 正在诊断并修复…"\)/);
  assert.match(page, /inspectPdfIdentity/);
  assert.match(page, /inferPaperTitle/);
  assert.match(page, /aliases: identity\.aliases/);
  assert.match(page, /getActivePaperMention/);
  assert.match(page, /searchMentionTargets/);
  assert.match(page, /loadReferencedPaperPages/);
  assert.match(page, /loadReferencedPaperPages\(paper\.id\)\)\.filter\(\(page\) => page\.text\.trim\(\)\)/);
  assert.match(page, /contextScope: "full"/);
  assert.match(page, /loadCurrentPaperPages/);
  assert.match(page, /buildWholeDocumentChatContext/);
  assert.match(page, /针对整篇资料或选中内容提问/);
  assert.match(page, /全部可提取文字页并保留页码/);
  assert.match(page, /页 · 全文引用/);
  assert.match(page, /从我的空间引用资料/);
  assert.match(page, /Math\.min\(pdf\.numPages, 4\)/);
  assert.match(page, /GitHub repository discovery failed/);
  assert.match(page, /在 GitHub 打开仓库/);
  assert.match(page, /href=\{repositoryUrl\}/);
  assert.match(page, /target="_blank"/);
  assert.match(page, /按问题动态核实/);
  assert.match(page, /本次无需读取仓库/);
  assert.match(page, /pdf-text-layer/);
  assert.match(page, /highlight-mark/);
  assert.match(page, /onPointerDown=\{startErasing\}/);
  assert.match(page, /onPointerMove=\{moveEraser\}/);
  assert.match(page, /eraseHighlightAtPoint/);
  assert.match(page, /aria-label="橡皮擦"/);
  assert.doesNotMatch(page, /onRemoveHighlight/);
  assert.match(page, /type PaperComment/);
  assert.match(page, /commentsUpdatedAt/);
  assert.match(page, /persistComments/);
  assert.match(page, /deleteStoredPaper/);
  assert.match(page, /comment-anchor-mark/);
  assert.match(page, /comment-pin/);
  assert.match(page, /评论这一段/);
  assert.match(page, /comment-target-layer/);
  assert.match(page, /existingComment = comments\.find\(\(comment\) => comment\.segmentId === segment\.id\)/);
  assert.match(page, /primarySegmentId: segment\.id/);
  assert.match(page, /segments\.filter\(isCommentableSegment\)\.map/);
  assert.match(page, /aria-label="按段落评论"/);
  assert.match(page, /删除《\$\{paper\.displayName\}》/);
  assert.match(page, /AI Chat/);
  assert.match(page, /startChatResize/);
  assert.match(page, /resizeChatFromKeyboard/);
  assert.match(page, /调整资料阅读区和 AI Chat 高度/);
  assert.match(page, /detectCaptionFigureRegions/);
  assert.match(page, /refineFigureRegionsWithCanvas/);
  assert.match(page, /figure-region-target/);
  assert.match(page, /addFigureToChat/);
  assert.match(page, /onPaste=\{handleChatPaste\}/);
  assert.match(page, /normalizePastedImage/);
  assert.match(page, /chat-attachments/);
  assert.match(page, /images: \[\.\.\.chatPageSource\.images, \.\.\.chatImages\]\.map/);
  assert.match(page, /aria-label="移动端视图"/);
  assert.match(page, /changeZoom/);
  assert.match(page, /handleStageScroll/);
  assert.match(page, /onScroll=\{handleStageScroll\}/);
  assert.match(page, /PdfPageView/);
  assert.match(page, /aria-label="连续资料页面"/);
  assert.match(page, /findClosestPageToViewportCenter/);
  assert.match(page, /shouldRenderPage\(targetPage, pageNumber\)/);
  assert.doesNotMatch(page, /accumulatePageTurnIntent|PAGE_TURN_COOLDOWN_MS|onWheel=\{handleStageWheel\}/);
  assert.match(page, /适合宽度（100%）/);
  assert.match(page, /buildPageSegments/);
  assert.match(segmentation, /splitTextLineParts/);
  assert.match(page, /mapPdfTextItemsToSegments/);
  assert.match(page, /alignRenderedTextToSegments/);
  assert.match(segmentation, /const twoColumnPage = leftCount >= 3 && rightCount >= 3/);
  assert.match(segmentation, /> 8_000/);
  assert.match(page, /data-segment-id/);
  assert.match(page, /data-translation-segment/);
  assert.match(page, /katex\.renderToString/);
  assert.match(page, /formulaExplanation/);
  assert.match(page, /item\.role === "assistant" \? <ChatMarkdown text=\{item\.text\} \/>/);
  assert.match(page, /from "\.\/chat-markdown"/);
  assert.match(page, /SOURCE_FORMULA/);
  assert.match(translationResponse, /jsonPunctuationEscape/);
  assert.match(translationResponse, /jsonUnicodeEscape/);
  assert.match(page, /activateSegment/);
  assert.match(page, /handleSourceClick/);
  assert.match(page, /selectionMadeRef/);
  assert.match(page, /mergeSelectionRects/);
  assert.match(page, /onPointerUp=\{\(event\) => onPaperSelection\(pageNumber, event\.currentTarget\)\}/);
  assert.match(page, /if \(annotationMode === "highlight"\) \{\s*addHighlight\(nextSelection\);\s*return;/);
  assert.match(page, /setPendingSelection\(nextSelection\);\s*\}, \[addHighlight, annotationMode, startComment\]\);/);
  assert.doesNotMatch(page, /setPendingSelection\(nextSelection\);\s*selection\.removeAllRanges\(\)/);
  assert.match(page, /if \(annotationMode !== "select"\) return;\s*const target = \(event\.target as HTMLElement\)\.closest<HTMLElement>\("\[data-segment-id\]"\)/);
  assert.doesNotMatch(page, /setHighlights[\s\S]{0,500}setSelectedText\(selection\.text\)/);
  assert.match(page, /selectionContextRects/);
  assert.match(page, /contextSegmentIds/);
  assert.match(page, /range\.intersectsNode/);
  assert.match(page, /window\.getSelection\(\)\?\.removeAllRanges\(\)/);
  assert.match(page, /className="thumbnail-label"/);
  assert.match(page, /setChatContextKind\("paragraph"\)/);
  assert.match(page, /setChatContextKind\("selection"\)/);
  assert.match(page, /整篇资料已作为基础上下文/);
  assert.match(page, /chatMessages\?: ChatMessage\[\]/);
  assert.match(page, /setChatMessages\(existingStored\?\.chatMessages \|\| \[\]\)/);
  assert.match(page, /chatMessages: existingStored\?\.chatMessages \|\| \[\]/);
  assert.match(page, /updateStoredPaper\(paperId, \{ chatMessages: nextMessages, chatMessagesUpdatedAt: Date\.now\(\) \}\)/);
  assert.match(page, /commitChatMessages\(\(previous\) => \[\.\.\.previous, userMessage\]\)/);
  assert.match(page, /onMouseMove=\{\(\) =>/);
  assert.doesNotMatch(page, /copyForCodex|openPaste|粘贴当前页译文/);

  assert.match(bridge, /runCodexCommand\(installation/);
  assert.match(bridge, /materializeImages/);
  assert.match(bridge, /requestActivity\.start\(activeProvider, route\.payload\.mode\)/);
  assert.doesNotMatch(bridge, /code: "provider_busy"/);
  assert.match(bridge, /PAPERLENS_VISUAL_PAGE/);
  assert.match(bridge, /学习资料翻译助手/);
  assert.match(bridge, /必须实际查看随请求附带的整页图片/);
  assert.match(bridge, /args\.push\("--image", path\)/);
  assert.match(bridge, /paperlens-images-/);
  assert.match(bridge, /图片上下文/);
  assert.match(bridge, /referencedPaperContext/);
  assert.match(bridge, /读者通过 @ 从“我的空间”引用的其他资料/);
  assert.match(bridge, /必须明确写出资料名称和证据页码/);
  assert.match(bridge, /paper\?\.contextScope === "full"/);
  assert.match(bridge, /paper\.pages\.map/);
  assert.doesNotMatch(bridge, /paper\.pages\.slice\(0, 3\)/);
  assert.match(bridge, /24 \* 1024 \* 1024/);
  assert.match(bridge, /"--sandbox", "read-only"/);
  assert.match(bridge, /GitHub MCP、alphaXiv/);
  assert.match(bridge, /\[\[REPOSITORY_USED\]\]/);
  assert.match(bridge, /\[\[REPOSITORY_SKIPPED\]\]/);
  assert.match(bridge, /payload\.mode === "repository" \|\| payload\.mode === "auto"/);
  assert.match(bridge, /repositoryMode \? \["--search", "exec"\] : \["exec"\]/);
  assert.doesNotMatch(bridge, /args\.push\("--search"\)/);
  assert.match(bridge, /extractRepositoryDecision/);
  assert.match(bridge, /\$paper-reader/);
  assert.match(bridge, /skillAvailable/);
  assert.match(bridge, /translationSegments/);
  assert.match(bridge, /只输出严格 JSON/);
  assert.match(bridge, /公式规则/);
  assert.match(bridge, /formulaExplanation/);
  assert.match(bridge, /公式输出规则/);
  assert.match(bridge, /\[\[SOURCE_FORMULA\]\]/);
  assert.match(bridge, /127\.0\.0\.1/);
  assert.match(bridge, /request\.url === "\/convert-document"/);
  assert.match(bridge, /documentConversion/);
  assert.match(bridge, /readBytes\(request\)/);
  assert.match(converter, /OFFICE_DOCUMENT_EXTENSIONS/);
  assert.match(converter, /"\.doc", "\.docx", "\.ppt", "\.pptx"/);
  assert.match(converter, /--convert-to/);
  assert.match(converter, /paperlens-convert-/);
  assert.match(converter, /UserInstallation/);
  assert.match(converter, /await rm\(directory, \{ recursive: true, force: true \}\)/);
  assert.match(devScript, /\["--hostname", "localhost"\]/);
  assert.match(devScript, /scripts\/usb-gateway\.mjs/);
  assert.match(devScript, /fileURLToPath/);
  assert.match(bridge, /fileURLToPath/);
  assert.match(usbGateway, /169\.254\./);
  assert.match(usbGateway, /PaperLens iPad USB/);
  assert.match(usbGateway, /incoming\.on\("error", closeUpstream\)/);
  assert.match(usbGateway, /socket\.on\("error", destroyPair\)/);
  assert.match(usbGateway, /server\.on\("clientError"/);
  assert.match(layout, /PaperLens · 学习资料阅读与理解工作台/);
  assert.match(styles, /\.pdf-stage \{[^}]*overflow: auto/);
  assert.match(styles, /\.pdf-document-flow \{[^}]*flex-direction: column;[^}]*gap: 18px/);
  assert.match(styles, /-webkit-overflow-scrolling: touch/);
  assert.match(styles, /scrollbar-gutter: stable both-edges/);
  assert.match(styles, /\.paper-frame \{[^}]*max-width: none/);
  assert.match(styles, /\.sync-segment-box/);
  assert.match(styles, /\.full-translation-progress/);
  assert.match(styles, /\.translate-all-button/);
  assert.match(styles, /\.figure-region-target/);
  assert.match(styles, /\.comment-anchor-mark/);
  assert.match(styles, /\.comment-editor/);
  assert.match(styles, /\.comment-target-layer/);
  assert.match(styles, /\.comment-target:hover/);
  assert.match(styles, /\.paper-delete-button/);
  assert.match(styles, /\.chat-attachments/);
  assert.match(styles, /\.chat-height-resizer/);
  assert.match(styles, /body\.chat-resizing/);
  assert.match(styles, /\.paper-mention-menu/);
  assert.match(styles, /\.chat-paper-mentions/);
  assert.match(styles, /\.chat-markdown-table/);
  assert.match(styles, /\.sync-segment-box\.context/);
  assert.match(styles, /\.sync-selection-line/);
  assert.match(styles, /\.mode-highlight \.pdf-text-layer ::selection \{ background: rgba\(255,224,71,\.48\); \}/);
  assert.match(styles, /\.mode-highlight \.sync-highlight-layer \{ display: none; \}/);
  assert.match(styles, /\.mode-erase \.highlight-layer \{ z-index: 6; pointer-events: auto;/);
  assert.match(styles, /\.eraser-tool-icon/);
  assert.match(styles, /\.thumbnail-item > \.thumbnail-label/);
  assert.doesNotMatch(styles, /\.thumbnail-item span \{/);
  assert.match(styles, /\.thumbnail-item i \.anticon \{[^}]*position: absolute;[^}]*inset: 0;[^}]*justify-content: center;[^}]*margin: 0;[^}]*padding: 0/);
  assert.match(styles, /\.thumbnail-item i \.anticon svg \{[^}]*width: 11px;[^}]*height: 11px/);
  assert.match(styles, /\.translated-segment\.active/);
  assert.match(styles, /\.translated-segment\.context/);
  assert.match(styles, /\.translated-math\.display/);
  assert.match(styles, /\.tutorial-link/);
  assert.match(styles, /\.formula-explanation/);
  assert.match(pdfWorker, /getOrInsertComputed/);

  await access(new URL("../public/pdf.worker.min.mjs", import.meta.url));
});
