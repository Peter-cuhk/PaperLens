# PaperLens Local

PaperLens Local 是面向论文、课程 PPT、讲义和阅读材料的本地优先阅读工作台。PDF 在浏览器中解析；Word / PowerPoint 只交给本机 bridge 临时转换。阅读器把原文、译文、选区、图表、批注、笔记和整篇资料问答放在同一个界面里。

本地版只有两种 AI 接入，不接收云 API Key，也不提供余额、充值或支付入口：

| 接入 | 问答 | 翻译 | 术语 | 图片 | 仓库实时核实 |
| --- | --- | --- | --- | --- | --- |
| 本机 Codex | 支持 | 支持 | 支持 | 支持 | 支持 |
| ChatGPT 网页 Chat | 支持 | 支持 | 支持 | 支持 | 不支持；需要本机 Codex |

ChatGPT 网页通道操作用户自己可见且已登录的普通 Chat 页面，不是 Work 模式，不读取 Cookie、密码或浏览器存储，也不调用 ChatGPT 私有接口。

## 一键安装

macOS 上克隆仓库后运行：

```bash
./scripts/setup-local.sh
```

脚本会：

1. 校验 Node.js 22.13+ 与 npm；
2. 使用 `npm ci` 安装锁定依赖；
3. 缺少 Codex 时尝试安装 `@openai/codex`；
4. 生成可上传 Chrome Web Store 的扩展 ZIP；
5. 安装 `/Applications/PaperLens.app`；
6. 执行本机诊断。

不希望安装全局 Codex 或 macOS App 时可用：

```bash
./scripts/setup-local.sh --no-codex --no-app
```

启动方式：

```bash
npm run dev
```

或直接打开 `/Applications/PaperLens.app`。Web 默认为 `http://localhost:3000`，AI bridge 为 `http://127.0.0.1:43123`。

## Codex 连接与状态

PaperLens 不再把“找到 `codex` 可执行文件”当成“可用”。界面分别显示：

- Codex CLI 是否安装、路径与版本；
- 是否已登录、登录方式、账号与计划（可用时）；
- Codex 额度窗口的已用/剩余百分比与重置时间（可用时）；
- 是否达到当前额度限制。

在“本地 AI 接入”中点击“连接 ChatGPT 账号”，PaperLens 会通过 Codex App Server 创建官方浏览器登录流程并持续刷新状态。CLI 诊断也可单独运行：

```bash
codex login status
npm run doctor
```

## ChatGPT 网页扩展

### 首选：Chrome Web Store

Chrome 官方只允许普通 macOS / Windows 用户直接安装由 Chrome Web Store 托管和签名的扩展；本地 CRX 不能静默安装。生成待发布包：

```bash
npm run chatgpt-web:package
```

产物位于 `release/paperlens-chatgpt-web-extension.zip`。发布后在 `.env` 填写：

```bash
PAPERLENS_EXTENSION_STORE_URL=https://chromewebstore.google.com/detail/...
```

PaperLens 会在连接面板显示商店安装按钮。发布需要扩展所有者登录 Chrome Web Store Developer Dashboard，完整流程见 [docs/chrome-extension-release.md](docs/chrome-extension-release.md)。

### GitHub 备选：unpacked extension

```bash
npm run chatgpt-web:setup
```

命令会打开 `chrome://extensions` 与仓库内 `browser-extension/` 文件夹。首次需要用户开启“开发者模式”并确认“加载已解压的扩展程序”；这是 Chrome 对 GitHub 本地扩展的安全限制，无法由应用静默绕过。之后打开并登录 [chatgpt.com](https://chatgpt.com/)，PaperLens 会通过短期配对令牌连接扩展。

扩展会：

- 把整篇资料上下文、选中段落、用户问题、最近对话和图片附件送入可见 Chat；
- 使用翻译/术语对应的严格 JSON 提示，并把最终回答返回现有解析器；
- 等待生成停止且回答正文连续稳定 6 秒，避免截断流式输出；
- 只监听 `127.0.0.1:43124`，同时校验扩展来源与当前 PaperLens 配对令牌。

## 资料上下文

当前资料会索引全部具有可提取文字的页面，并保留页码；选中段落会作为高优先级上下文。明确 `@` 单篇资料时携带该资料全部可提取文字页，`@` 文件夹时按问题检索最相关资料和证据页。网页回答会直接写回 PaperLens 聊天区。

扫描页和图表页会作为图片附件传给本机 Codex 或 ChatGPT 网页 Chat。超长资料仍受 ChatGPT 网页输入上限影响；PaperLens 会保留明确页码和失败信息，不会假装已提交被浏览器拒绝的内容。

## 常用命令

```bash
npm run setup                 # 可重复本机安装
npm run dev                   # 同时启动 Web、AI bridge、USB gateway
npm run doctor                # 安装、账号与服务诊断
npm run app:install           # 重建 /Applications/PaperLens.app
npm run chatgpt-web:setup     # GitHub unpacked 扩展安装向导
npm run chatgpt-web:package   # Chrome Web Store 上传包
npm run typecheck
npm run lint
npm test
```

## 安全边界

- PDF 在浏览器本地解析；Word/PPT 只进入回环 bridge 的临时目录，转换完成后清理。
- Codex 请求使用只读 sandbox；图片写入请求级临时目录后删除。
- Codex OAuth、token 刷新和额度读取由 Codex App Server 管理；PaperLens 不读取或保存 `auth.json`。
- 网页扩展只操作可见输入框、图片上传控件和最终回答正文。
- bridge 只接受 PaperLens 本地来源；网页 WebSocket 需要回环地址、扩展来源和每次 bridge 启动生成的配对令牌。

## 验证

```bash
npm run typecheck
npm run lint
npm test
git diff --check
```

测试覆盖整篇资料上下文、选区、翻译结构化修复、术语解析、两种 Provider 路由、Codex 账号/额度协议、网页 MCP 往返、图片附件和阅读器交互。
