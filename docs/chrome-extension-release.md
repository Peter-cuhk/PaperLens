# PaperLens ChatGPT 扩展发布

## 为什么首选 Chrome Web Store

Chrome 官方只支持两种正式分发方式：Chrome Web Store，以及受管理员策略控制的自托管。macOS 与 Windows 普通用户不能从本地 CRX 静默安装；GitHub unpacked 只能作为需要用户确认的开发者模式备选。

官方说明：

- https://developer.chrome.com/docs/extensions/how-to/distribute
- https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions

## 发布步骤

1. 更新 `browser-extension/manifest.json` 中的版本号。
2. 运行 `npm run typecheck && npm run lint && npm test`。
3. 运行 `npm run chatgpt-web:package`。
4. 登录 Chrome Web Store Developer Dashboard，新建或更新扩展。
5. 上传 `release/paperlens-chatgpt-web-extension.zip`。
6. 在权限说明中解释：
   - `tabs`：寻找或创建用户可见的 ChatGPT 标签页；
   - `storage`：在 Chrome session storage 中保存本次本机配对令牌；
   - `chatgpt.com`：写入提示、上传用户主动附加的图片、读取最终可见回答；
   - `localhost:3000`：接收 PaperLens 页面发出的短期配对令牌。
7. 完成商店审核后，把公开或 unlisted 安装 URL 写入 PaperLens `.env`：

   ```bash
   PAPERLENS_EXTENSION_STORE_URL=https://chromewebstore.google.com/detail/...
   ```

8. 重启 PaperLens，确认“本地 AI 接入”出现“从 Chrome 商店安装”。

## 发布前验收

- 新 Chrome 配置中可从商店安装，不需要开发者模式。
- 打开 PaperLens 后扩展只连接 `127.0.0.1:43124`。
- 未打开 PaperLens 时，缺少本次配对令牌的连接被拒绝。
- 未登录 ChatGPT 时显示“网页尚未登录”，不误报可用。
- 问答、文字页翻译、术语、扫描页图片翻译各完成一次真实往返。
- 回答生成停止且正文稳定 6 秒后才回传。
- 扩展更新后旧版本能由 Chrome Web Store 自动更新。

商店上传、开发者身份验证与发布确认必须由扩展所有者完成；仓库脚本不会代替用户登录或提交商店审核。
