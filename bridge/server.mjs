import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { CodexAccountClient, detectCodexInstallation, readCodexCliLoginStatus } from "./codex-account.mjs";
import { ProviderError, normalizeProviderError } from "./provider-errors.mjs";
import { INVOCATION_MODES, PROVIDER_IDS, resolveProviderRoute } from "./provider-routing.mjs";
import { createChatGPTWebProvider } from "./providers/chatgpt-web.mjs";
import { createDocumentConverter, DocumentConversionError } from "./document-converter.mjs";
import { createRequestActivityTracker } from "./request-activity.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
try {
  loadEnvFile(join(PROJECT_ROOT, ".env"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const HOST = "127.0.0.1";
const PORT = Number(process.env.PAPERLENS_CODEX_PORT || 43123);
const APP_PORT = Number(process.env.PAPERLENS_PORT || 3000);
const CODEX_ROOT = process.env.CODEX_HOME || join(homedir(), ".codex");
const PAPER_READER_SKILL = process.env.PAPERLENS_SKILL_PATH || join(CODEX_ROOT, "skills", "paper-reader", "SKILL.md");
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${APP_PORT}`,
  `http://127.0.0.1:${APP_PORT}`,
]);

const codexInstallation = await detectCodexInstallation();
let codexPath = codexInstallation.command;
let codexAccountStatus = { loggedIn: false, authMode: null, email: null, planType: null, rateLimits: [], rateLimitReached: false };
let codexAvailable = false;
let codexStatusPromise = null;
let codexStatusCheckedAt = 0;
const codexAccountClient = codexInstallation.installed ? new CodexAccountClient(codexPath) : null;
const requestActivity = createRequestActivityTracker();
let documentConversionActive = false;
let skillAvailable = false;

const chatGPTWebProvider = createChatGPTWebProvider();
const documentConverter = await createDocumentConverter();

try {
  await access(PAPER_READER_SKILL);
  skillAvailable = true;
} catch {
  skillAvailable = false;
}

async function refreshCodexStatus({ force = false, refreshToken = false } = {}) {
  if (!codexInstallation.installed || !codexAccountClient) {
    codexAvailable = false;
    return codexAccountStatus;
  }
  if (!force && Date.now() - codexStatusCheckedAt < 5_000) return codexAccountStatus;
  if (codexStatusPromise) return codexStatusPromise;
  codexStatusPromise = (async () => {
    try {
      codexAccountStatus = await codexAccountClient.readStatus({ refreshToken });
    } catch {
      const fallback = await readCodexCliLoginStatus(codexPath);
      codexAccountStatus = {
        loggedIn: fallback.loggedIn,
        authMode: fallback.authMode,
        email: null,
        planType: null,
        rateLimits: [],
        rateLimitReached: false,
        limitedStatus: true,
      };
    }
    codexAvailable = codexAccountStatus.loggedIn && !codexAccountStatus.rateLimitReached;
    codexStatusCheckedAt = Date.now();
    return codexAccountStatus;
  })().finally(() => { codexStatusPromise = null; });
  return codexStatusPromise;
}

void refreshCodexStatus({ force: true });

function corsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : `http://localhost:${APP_PORT}`;
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-headers": "content-type,x-paperlens-file-name",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-expose-headers": "content-disposition,x-paperlens-converter",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    vary: "Origin",
  };
}

async function readBytes(request, limit = 80 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new DocumentConversionError("文件超过 80 MB，请先精简文档再导入", { code: "document_too_large", status: 413 });
    }
    chunks.push(chunk);
  }
  if (!size) throw new DocumentConversionError("文件内容为空", { code: "empty_document", status: 400 });
  return Buffer.concat(chunks);
}

function decodeFileName(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sendPdf(response, result, origin) {
  response.writeHead(200, {
    ...corsHeaders(origin),
    "content-type": "application/pdf",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    "x-paperlens-converter": result.engine,
  });
  response.end(result.pdf);
}

function sendJson(response, status, body, origin) {
  response.writeHead(status, corsHeaders(origin));
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 34_000_000) throw new Error("请求内容过长；请减少图片数量或尺寸");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function compact(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function imageMetadata(payload) {
  return Array.isArray(payload.images)
    ? payload.images.slice(0, 4).map((image, index) => ({
        label: compact(image?.label, 160) || `图片 ${index + 1}`,
        source: image?.source === "paper" ? "资料页面截图" : "用户粘贴图片",
        pageNumber: Number.isInteger(image?.pageNumber) ? image.pageNumber : null,
      }))
    : [];
}

function referencedPaperContext(payload) {
  return Array.isArray(payload.referencedPapers)
    ? payload.referencedPapers.slice(0, 5).map((paper) => ({
        title: compact(paper?.title, 300) || "未命名资料",
        fileName: compact(paper?.fileName, 300),
        aliases: Array.isArray(paper?.aliases) ? paper.aliases.slice(0, 8).map((alias) => compact(alias, 160)).filter(Boolean) : [],
        folderNames: Array.isArray(paper?.folderNames) ? paper.folderNames.slice(0, 3).map((name) => compact(name, 100)).filter(Boolean) : [],
        repositoryUrl: compact(paper?.repositoryUrl, 500),
        contextScope: paper?.contextScope === "full" ? "full" : "retrieved",
        pages: Array.isArray(paper?.pages) ? paper.pages.map((page) => ({
          pageNumber: Number.isInteger(page?.pageNumber) ? page.pageNumber : null,
          text: typeof page?.text === "string" ? page.text.trim() : "",
        })).filter((page) => page.pageNumber && page.text) : [],
      }))
    : [];
}

async function materializeImages(payload) {
  const images = Array.isArray(payload.images) ? payload.images.slice(0, 4) : [];
  if (!images.length) return { directory: "", paths: [] };
  const directory = await mkdtemp(join(tmpdir(), "paperlens-images-"));
  const paths = [];
  let totalBytes = 0;
  try {
    for (let index = 0; index < images.length; index += 1) {
      const dataUrl = compact(images[index]?.dataUrl, 15_000_000);
      const match = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/);
      if (!match) throw new Error(`第 ${index + 1} 张图片格式不受支持`);
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error(`第 ${index + 1} 张图片超过 10 MB`);
      totalBytes += bytes.length;
      if (totalBytes > 24 * 1024 * 1024) throw new Error("图片总大小不能超过 24 MB");
      const extension = match[1] === "jpeg" ? "jpg" : match[1];
      const path = join(directory, `image-${index + 1}.${extension}`);
      await writeFile(path, bytes, { flag: "wx" });
      paths.push(path);
    }
    return { directory, paths };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function buildPrompt(payload) {
  const mode = payload.mode;
  const rawPageText = typeof payload.pageText === "string" ? payload.pageText.trim() : "";
  const pageText = mode === "translate" || mode === "terms" ? rawPageText.slice(0, 28_000) : rawPageText;
  const selectedText = compact(payload.selectedText, 6_000);
  const question = compact(payload.question, 4_000);
  const paperTitle = compact(payload.paperTitle, 300);
  const repositoryUrl = compact(payload.repositoryUrl, 500);
  const repairError = compact(payload.repairError, 1_000);
  const attachedImages = imageMetadata(payload);
  const referencedPapers = referencedPaperContext(payload);
  const referencedFolders = Array.isArray(payload.referencedFolders)
    ? payload.referencedFolders.slice(0, 3).map((folder) => ({
        name: compact(folder?.name, 100) || "未命名文件夹",
        paperCount: Number.isInteger(folder?.paperCount) ? folder.paperCount : 0,
      }))
    : [];
  const translationSegments = Array.isArray(payload.segments)
    ? payload.segments.slice(0, 120).map((segment) => ({
        id: compact(segment?.id, 80),
        kind: segment?.kind === "heading" ? "heading" : segment?.kind === "formula" ? "formula" : "paragraph",
        text: compact(segment?.text, 4_000),
      })).filter((segment) => segment.id && segment.text)
    : [];
  const history = Array.isArray(payload.history)
    ? payload.history.slice(-6).map((item) => `${item.role === "assistant" ? "助手" : "读者"}: ${compact(item.text, 2_000)}`).join("\n\n")
    : "";

  if (mode === "translate") {
    const visualPage = payload.visualPage === true && attachedImages.length > 0;
    const repairAttempt = Number.isInteger(payload.repairAttempt) ? Math.max(0, payload.repairAttempt) : 0;
    if (!pageText && !visualPage) throw new Error("当前页没有可翻译文字");
    const pageNumber = Number.isInteger(payload.pageNumber) ? payload.pageNumber : 1;
    const segments = translationSegments.length ? translationSegments : [{ id: `p${pageNumber}-s1`, kind: "paragraph", text: pageText }];
    return [
      "Follow the PaperLens translation rules below.",
      "你是 PaperLens 中的学习资料翻译助手。把下面的英文资料（可能是论文、课程 PPT、讲义或阅读材料）翻译成自然、准确、易读的简体中文。",
      "严格要求：保留章节层级、公式、变量、引用编号和专业术语；不要总结；不要补充原文没有的信息。",
      "公式规则：所有可可靠还原的数学公式必须转写为有效 LaTeX；行内公式使用 \\( ... \\)，独立公式使用 \\[ ... \\]。不要在公式分隔符外裸露下划线、花括号或 \\prod、\\sum 等命令。公式内容本身不要翻译或改写。",
      "PDF 可能把同一公式的主体、乘积/求和符号、上下限和编号拆到多个输入 segment。只要当前 segment 不是一条完整、可独立核对的公式，或公式的任何关键部分位于相邻 segment，就必须使用 [[SOURCE_FORMULA]]；禁止输出缺少乘积号、上下限、条件项或等号一侧的半条 LaTeX 公式。",
      "kind 为 formula 的 segment 已经把同一条独立公式的几何碎片归并在一起。这类 segment 的 translation 只输出一个 [[SOURCE_FORMULA]]，formulaExplanation 只输出一段统一解释；不得再按求和符号、上下标、括号或编号分开解释。",
      "如果 PDF 抽取结果不足以无歧义地还原某个公式，绝对不要猜；在该公式原本的位置写入精确标记 [[SOURCE_FORMULA]]，界面会引导读者查看左侧原文。",
      "读者明确希望理解公式：只要本段包含公式，就在 formulaExplanation 中用 1–3 句简体中文解释公式表达的关系、主要变量和上下标/求和范围；只依据当前页上下文，不确定的符号要明确说上下文未定义。没有公式时 formulaExplanation 必须是空字符串。",
      "JSON 转义要求：LaTeX 的每个反斜杠在 JSON 字符串中必须写成双反斜杠，例如 \\\\prod、\\\\theta、\\\\[ 和 \\\\]；确保整个输出可被 JSON.parse 直接解析。",
      "为了让原文与译文双向同步，只输出严格 JSON，不要 Markdown 代码围栏，不要输出 JSON 以外的说明。结构必须是：{\"segments\":[{\"id\":\"原始 id\",\"translation\":\"对应中文译文（公式用 LaTeX 或 [[SOURCE_FORMULA]]）\",\"formulaExplanation\":\"公式解释；无公式时为空字符串\"}]}。每个输入 id 必须恰好出现一次、顺序不变，不得合并或拆分段落。",
      repairAttempt > 0 ? `这是第 ${repairAttempt} 次自动修复请求。上一次任务失败：${repairError || "译文响应不完整"}。请根据错误修复执行方式；本次输入只包含待补译段落，必须逐个完整返回所有 ${segments.length} 个 id，不得省略。` : "",
      visualPage ? "当前页采用整页视觉翻译：可能没有文字层，也可能因多栏、表格或跨栏内容使文字层顺序不可靠。必须实际查看随请求附带的整页图片，按视觉区块和真实阅读顺序翻译全部清晰可见的英文；绝对不得把同一水平线上的左右栏内容交叉拼接。保留标题、段落、图表标题、数字和专有名词；每个原文段落之间留一个空行。表格必须输出为 Markdown 表格，保持原始列名、行名、数值及加粗关系，表注单独成段，不得与旁边正文混合。看不清的文字标为［无法辨认］，禁止猜测。输入中 [[PAPERLENS_VISUAL_PAGE]] 只是视觉页占位符，不得翻译或出现在译文中。整页译文放入唯一输入 id 对应的 translation。" : "",
      `资料：${paperTitle || "本地资料"}`,
      visualPage ? `图片上下文：${attachedImages.map((image) => `${image.label}${image.pageNumber ? `（第 ${image.pageNumber} 页）` : ""}`).join("、")}` : "",
      "当前页分段原文：",
      JSON.stringify(segments),
    ].filter(Boolean).join("\n\n");
  }

  if (mode === "terms") {
    if (!pageText) throw new Error("当前页没有可整理的文字");
    return [
      "Follow the PaperLens terminology rules below and preserve accurate academic terminology.",
      "你是 PaperLens 的学习资料术语整理助手。只根据下面这一页实际出现的英文内容，提取 6–10 个对理解本页最重要的专业术语或短语，并给出准确、简洁的简体中文译名。",
      "严格要求：term 必须是当前页原文中实际出现的英文形式；优先当前资料特有的方法名、课程概念、任务名、模型名和技术短语；不要输出 author、method、result、model、data 等过于泛化的单词；不要重复、改写或补充原文没有的术语。缩写可保留，并在中文译名中必要时说明全称。",
      "只输出严格 JSON，不要 Markdown 代码围栏，不要输出 JSON 以外的说明。结构必须是：{\"terms\":[{\"term\":\"原文术语\",\"translation\":\"准确中文译名\"}]}。",
      repairError ? `上一次术语任务失败：${repairError}。请诊断原因并返回符合上述约束的修复结果。` : "",
      `资料：${paperTitle || "本地资料"}`,
      "当前页原文：",
      pageText,
    ].join("\n\n");
  }

  if (!question) throw new Error("请输入问题");
  const common = [
    "Follow the PaperLens explanation rules below unless this is a repository implementation question.",
    "你是运行在 PaperLens 学习资料阅读工作台里的 AI 阅读助手。请用简体中文回答，先给直接结论，再解释依据。不要假装看过没有提供或没有查到的内容。",
    "公式输出规则：回答中的每一个数学公式都必须写成有效 LaTeX；行内公式使用 \\( ... \\)，独立公式使用 \\[ ... \\]。不要在分隔符外裸露下划线、花括号或 \\prod、\\sum 等 LaTeX 命令，也不要把公式放进 Markdown 代码围栏。对公式的解释要说明它表达的关系、主要变量以及上下标或求和/乘积范围；当前上下文没有定义的符号要明确指出，禁止猜测。",
    repairError ? `上一次 AI 任务失败：${repairError}。请诊断原因，修复后完成用户原始任务，不要只复述错误。` : "",
    `资料：${paperTitle || "本地资料"}`,
    pageText ? `当前资料上下文（可能包含按页标注的全文）：\n${pageText}` : "",
    selectedText ? `读者选中的重点段落：\n${selectedText}` : "",
    attachedImages.length ? `图片上下文：\n${attachedImages.map((image, index) => `${index + 1}. ${image.label}（${image.source}${image.pageNumber ? `，资料第 ${image.pageNumber} 页` : ""}）`).join("\n")}` : "",
    attachedImages.length ? "请实际查看随请求附带的图片，并将图中的架构、模块、箭头、图例和文字与页面文本结合起来回答。明确区分图片中可见事实与自己的解释；看不清的部分直接说明，不得根据常识补画或猜测。" : "",
    referencedFolders.length ? `读者通过 @ 引用的文件夹：${referencedFolders.map((folder) => `${folder.name}（${folder.paperCount} 份资料）`).join("、")}。后续列出的资料是系统根据当前问题从这些文件夹中动态检索出的最相关证据。` : "",
    referencedPapers.length ? `读者通过 @ 从“我的空间”引用的其他资料：\n${referencedPapers.map((paper, index) => [
      `${index + 1}. ${paper.title}`,
      paper.folderNames.length ? `来源文件夹：${paper.folderNames.join("、")}` : "",
      paper.aliases.length ? `别名：${paper.aliases.join("、")}` : "",
      paper.repositoryUrl ? `仓库：${paper.repositoryUrl}` : "",
      paper.contextScope === "full" ? `上下文范围：全文（${paper.pages.length} 个可提取文字页）` : `上下文范围：按问题检索的证据页（${paper.pages.length} 页）`,
      ...paper.pages.map((page) => `[${paper.title}，第 ${page.pageNumber} 页]\n${page.text}`),
    ].filter(Boolean).join("\n")).join("\n\n")}` : "",
    referencedPapers.length ? "回答涉及被引用资料时，必须明确写出资料名称和证据页码；比较多份资料时分别说明证据，不得把一份资料的内容归到另一份。明确 @ 的单篇资料提供所有可提取文字页，不得再假定只有少量候选页；文件夹引用仍是按问题检索出的证据页。若资料来自被 @ 的文件夹，说明当前回答实际采用了其中哪些资料；证据不足时应明确说明。" : "",
    history ? `最近对话：\n${history}` : "",
  ].filter(Boolean);

  if (mode === "repository") {
    common.push(
      "Use $paper-reader in repository verification mode.",
      `当前资料对应仓库：${repositoryUrl}`,
      "这是一个代码实现问题。必须先通过 GitHub MCP、alphaXiv 的仓库读取工具或实时网页检索核实仓库内容，再回答。请引用准确的文件路径、类/函数/配置名和可访问链接；如果仓库无法访问或证据不足，明确说明，不得凭经验猜测。",
      "最终回答第一行必须是 [[REPOSITORY_USED]]，界面会隐藏这个标记。",
    );
  } else if (mode === "auto") {
    if (!repositoryUrl) throw new Error("自动仓库模式缺少仓库链接");
    common.push(
      `当前问题可按需核实的资料对应仓库：${[repositoryUrl, ...referencedPapers.map((paper) => paper.repositoryUrl)].filter(Boolean).join("、")}`,
      "先根据读者问题动态判断是否需要读取仓库。一般的资料概念解释、摘要理解、课程内容、方法直觉、术语和只依赖当前段落的问题，不要读取仓库，直接依据提供的资料上下文回答。",
      "如果问题涉及代码实现、文件或目录、类/函数/接口、配置参数、训练或评估脚本、数据格式、命令行、复现步骤、部署行为，或要求核对资料与代码是否一致，必须切换到 $paper-reader repository verification mode，并先通过 GitHub MCP、alphaXiv 的仓库读取工具或实时网页检索核实真实仓库。引用准确的路径、符号和可访问链接；访问失败时明确说明，禁止猜测。",
      "最终回答第一行必须二选一：实际读取并核实仓库时输出 [[REPOSITORY_USED]]；没有读取仓库时输出 [[REPOSITORY_SKIPPED]]。界面会隐藏这个标记并展示本次路由结果。",
    );
  }

  common.push(`读者问题：\n${question}`);
  return common.join("\n\n");
}

function extractRepositoryDecision(answer, mode) {
  const used = answer.includes("[[REPOSITORY_USED]]");
  const skipped = answer.includes("[[REPOSITORY_SKIPPED]]");
  const cleaned = answer.replace(/\[\[REPOSITORY_(?:USED|SKIPPED)\]\]/g, "").trim();
  if (mode === "repository") return { answer: cleaned, repositoryUsed: true, repositoryDecision: "used" };
  if (mode === "auto" && used) return { answer: cleaned, repositoryUsed: true, repositoryDecision: "used" };
  if (mode === "auto" && skipped) return { answer: cleaned, repositoryUsed: false, repositoryDecision: "skipped" };
  return { answer: cleaned, repositoryDecision: mode === "auto" ? "unreported" : "not-applicable" };
}

async function runCodex(payload, { signal } = {}) {
  const imageBundle = await materializeImages(payload);
  try {
    return await new Promise((resolve, reject) => {
    const repositoryMode = payload.mode === "repository" || payload.mode === "auto";
    // --search is a top-level Codex CLI option and must appear before `exec`.
    const args = repositoryMode ? ["--search", "exec"] : ["exec"];
    args.push("--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral");
    if (!repositoryMode) args.push("--ignore-user-config");
    for (const path of imageBundle.paths) args.push("--image", path);
    args.push("-C", PROJECT_ROOT, "-");

    const child = spawn(codexPath, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const prompt = buildPrompt(payload);
    const answers = [];
    let threadId = "";
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;

    const abort = () => {
      if (settled) return;
      child.kill("SIGTERM");
      reject(new ProviderError("请求已取消", { code: "request_aborted", status: 499, provider: "local-codex" }));
    };
    signal?.addEventListener("abort", abort, { once: true });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ProviderError("Codex 响应超时，请稍后重试", { code: "upstream_timeout", status: 504, retryable: true, provider: "local-codex" }));
    }, repositoryMode ? 360_000 : 240_000);

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started") threadId = event.thread_id || "";
          if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
            answers.push(event.item.text);
          }
        } catch {
          // Codex may emit non-JSON diagnostics; they are captured in stderr instead.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-12_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (!settled) reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      settled = true;
      const answer = answers.at(-1)?.trim();
      if (code === 0 && answer) resolve({ ...extractRepositoryDecision(answer, payload.mode), threadId });
      else reject(new Error(stderr.trim().split("\n").at(-1) || `Codex 退出，状态码 ${code}`));
    });
    child.stdin.end(prompt);
    });
  } finally {
    if (imageBundle.directory) await rm(imageBundle.directory, { recursive: true, force: true });
  }
}

function providerHealth() {
  const activity = (providerId) => requestActivity.snapshot(providerId);
  return {
    "local-codex": {
      id: "local-codex",
      label: "本机 Codex",
      configured: codexInstallation.installed,
      available: codexAvailable,
      busy: activity("local-codex").total > 0,
      activeTasks: activity("local-codex").channels,
      skillAvailable,
      installation: codexInstallation,
      account: codexAccountStatus,
      capabilities: { text: true, images: true, structuredOutput: true, repositoryVerification: true },
    },
    "chatgpt-web": {
      id: "chatgpt-web",
      label: chatGPTWebProvider.label,
      configured: chatGPTWebProvider.configured,
      available: chatGPTWebProvider.available,
      busy: activity("chatgpt-web").total > 0,
      activeTasks: activity("chatgpt-web").channels,
      capabilities: chatGPTWebProvider.capabilities,
      models: chatGPTWebProvider.models,
      allowedModels: chatGPTWebProvider.allowedModels,
      pairingToken: chatGPTWebProvider.pairingToken,
    },
  };
}

function defaultProvider() {
  if (codexAvailable) return "local-codex";
  if (chatGPTWebProvider.available) return "chatgpt-web";
  return "local-codex";
}

async function invokeProvider(providerId, payload, requestOptions) {
  if (providerId === "chatgpt-web") {
    return chatGPTWebProvider.invoke(payload, { prompt: buildPrompt(payload), signal: requestOptions.signal });
  }
  await refreshCodexStatus();
  if (!codexInstallation.installed) {
    throw new ProviderError("未安装本机 Codex CLI", { code: "provider_not_configured", status: 503, provider: "local-codex" });
  }
  if (!codexAccountStatus.loggedIn) {
    throw new ProviderError("本机 Codex 尚未登录 ChatGPT 账号", { code: "provider_not_configured", status: 503, provider: "local-codex" });
  }
  if (codexAccountStatus.rateLimitReached) {
    throw new ProviderError("本机 Codex 当前额度窗口已用尽，请等待重置后重试", { code: "quota_exceeded", status: 429, provider: "local-codex" });
  }
  const result = await runCodex(payload, { signal: requestOptions.signal });
  return { ...result, provider: "local-codex", model: "Codex CLI" };
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(origin));
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    await Promise.all([chatGPTWebProvider.refreshStatus(), refreshCodexStatus()]);
    sendJson(response, 200, {
      ok: true,
      service: "PaperLens AI bridge",
      edition: "local-two-connectors",
      projectRoot: PROJECT_ROOT,
      defaultProvider: defaultProvider(),
      providers: providerHealth(),
      extensionStoreUrl: /^https:\/\/chromewebstore\.google\.com\//.test(process.env.PAPERLENS_EXTENSION_STORE_URL || "")
        ? process.env.PAPERLENS_EXTENSION_STORE_URL
        : "",
      documentConversion: {
        available: documentConverter.available,
        engine: documentConverter.engine,
        formats: documentConverter.formats,
      },
    }, origin);
    return;
  }
  if (request.method === "POST" && request.url === "/codex/login") {
    try {
      if (!codexInstallation.installed || !codexAccountClient) {
        throw new ProviderError("未安装 Codex CLI，请先运行 npm run setup", { code: "provider_not_configured", status: 503, provider: "local-codex" });
      }
      const result = await codexAccountClient.startLogin();
      codexStatusCheckedAt = 0;
      sendJson(response, 200, { ok: true, loginId: result.loginId, authUrl: result.authUrl }, origin);
    } catch (error) {
      const normalized = normalizeProviderError(error, "local-codex");
      sendJson(response, normalized.status, { error: normalized.message, code: normalized.code }, origin);
    }
    return;
  }
  if (request.method === "POST" && request.url === "/codex/logout") {
    try {
      if (!codexAccountClient) throw new Error("Codex CLI 未安装");
      await codexAccountClient.logout();
      codexStatusCheckedAt = 0;
      await refreshCodexStatus({ force: true });
      sendJson(response, 200, { ok: true }, origin);
    } catch (error) {
      const normalized = normalizeProviderError(error, "local-codex");
      sendJson(response, normalized.status, { error: normalized.message, code: normalized.code }, origin);
    }
    return;
  }
  if (request.method === "POST" && request.url === "/setup/chatgpt-web") {
    try {
      const child = spawn(join(PROJECT_ROOT, "scripts", "open-chatgpt-web-setup.sh"), [], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      sendJson(response, 200, { ok: true }, origin);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "无法打开扩展安装向导" }, origin);
    }
    return;
  }
  if (request.method === "POST" && request.url === "/convert-document") {
    let acquiredConverter = false;
    try {
      if (documentConversionActive) {
        throw new DocumentConversionError("正在转换上一个文档，请稍候再试", { code: "converter_busy", status: 429 });
      }
      documentConversionActive = true;
      acquiredConverter = true;
      const fileName = decodeFileName(request.headers["x-paperlens-file-name"]);
      const bytes = await readBytes(request);
      const result = await documentConverter.convert(bytes, fileName);
      sendPdf(response, result, origin);
    } catch (error) {
      const status = error instanceof DocumentConversionError ? error.status : 500;
      const code = error instanceof DocumentConversionError ? error.code : "conversion_failed";
      sendJson(response, status, { error: error instanceof Error ? error.message : "文档转换失败", code }, origin);
    } finally {
      if (acquiredConverter) documentConversionActive = false;
    }
    return;
  }
  if (request.method === "POST" && request.url === "/test-provider") {
    try {
      const payload = await readJson(request);
      const providerId = PROVIDER_IDS.includes(payload.provider) ? payload.provider : "local-codex";
      if (providerId === "chatgpt-web") {
        const result = await chatGPTWebProvider.testConnection();
        sendJson(response, 200, { ...result, provider: providerId }, origin);
      } else {
        await refreshCodexStatus({ force: true, refreshToken: true });
        if (!codexInstallation.installed) throw new ProviderError("未安装本机 Codex CLI", { code: "provider_not_configured", status: 503, provider: providerId });
        if (!codexAccountStatus.loggedIn) throw new ProviderError("本机 Codex 尚未登录", { code: "provider_not_configured", status: 503, provider: providerId });
        if (codexAccountStatus.rateLimitReached) throw new ProviderError("本机 Codex 当前额度窗口已用尽", { code: "quota_exceeded", status: 429, provider: providerId });
        sendJson(response, 200, { ok: true, provider: providerId, skillAvailable, account: codexAccountStatus }, origin);
      }
    } catch (error) {
      const normalized = normalizeProviderError(error, "unknown");
      sendJson(response, normalized.status, { error: normalized.message, code: normalized.code, provider: normalized.provider, retryable: normalized.retryable }, origin);
    }
    return;
  }
  if (request.method !== "POST" || request.url !== "/invoke") {
    sendJson(response, 404, { error: "Not found" }, origin);
    return;
  }

  let activeProvider = "";
  let releaseActiveProvider = () => {};
  try {
    const payload = await readJson(request);
    if (!INVOCATION_MODES.includes(payload.mode)) {
      throw new ProviderError("不支持的 AI 模式", { code: "invalid_mode", status: 400, provider: "unknown" });
    }
    const requestedProvider = PROVIDER_IDS.includes(payload.provider) ? payload.provider : "local-codex";
    await refreshCodexStatus();
    const availability = Object.fromEntries(Object.entries(providerHealth()).map(([id, state]) => [id, state.available]));
    const route = resolveProviderRoute(payload, requestedProvider, availability);
    if (route.unsupportedReason) {
      throw new ProviderError(route.unsupportedReason, { code: "capability_unavailable", status: 503, provider: route.provider });
    }
    activeProvider = route.provider;
    releaseActiveProvider = requestActivity.start(activeProvider, route.payload.mode);
    const controller = new AbortController();
    request.on("aborted", () => controller.abort());
    response.on("close", () => { if (!response.writableEnded) controller.abort(); });
    const startedAt = Date.now();
    const requestOptions = {
      signal: controller.signal,
      translationModel: payload.translationModel,
      chatModel: payload.chatModel,
      reasoningEffort: payload.reasoningEffort,
    };
    const result = await invokeProvider(activeProvider, route.payload, requestOptions);
    sendJson(response, 200, {
      ...result,
      latencyMs: Date.now() - startedAt,
      fallbackReason: route.fallbackReason,
      repositoryDecision: route.repositoryDecision || result.repositoryDecision,
    }, origin);
  } catch (error) {
    const normalized = normalizeProviderError(error, activeProvider || "unknown");
    sendJson(response, normalized.status, {
      error: normalized.message,
      code: normalized.code,
      provider: normalized.provider,
      retryable: normalized.retryable,
    }, origin);
  } finally {
    releaseActiveProvider();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PaperLens AI bridge: http://${HOST}:${PORT}`);
});

async function shutdown() {
  codexAccountClient?.close();
  await chatGPTWebProvider.close().catch(() => {});
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
