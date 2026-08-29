# Chrome Web Store field values

- Category: Productivity
- Language: English
- Store icon: `browser-extension/icon-128.png`
- Screenshot: `docs/store-listing/store-screenshot-1280x800.jpg`
- Homepage URL: `https://github.com/Peter-cuhk/PaperLens`
- Support URL: `https://github.com/Peter-cuhk/PaperLens/issues`
- Mature content: Off
- Privacy policy URL: `https://github.com/Peter-cuhk/PaperLens/blob/codex/paperlens-local-connectors/docs/privacy-policy.md`

## Single purpose

Connect a locally running PaperLens reader to the user's visible, signed-in ChatGPT web conversation so user-initiated document questions, translations, terminology tasks, selected passages, and image attachments can be sent through that visible conversation and the final visible answer can be returned to PaperLens.

## Permission justifications

### tabs

Used only to locate an existing `chatgpt.com` tab or open one when the user initiates a PaperLens task, and to report whether that visible page is signed in and ready. The extension does not inspect unrelated tab content.

### storage

Used only with `chrome.storage.session` to retain the short-lived pairing token for the current local PaperLens session while the extension service worker is suspended. The token is not synced and is cleared with the browser session.

### chatgpt.com host access

Required to insert the user-initiated PaperLens prompt into the visible ChatGPT composer, attach images explicitly selected in PaperLens, observe generation completion, and read the final visible answer body for return to PaperLens.

### localhost host access

Required to receive the short-lived pairing token from the PaperLens page at `http://localhost:3000` or `http://127.0.0.1:3000`. No remote website can supply this token.

## Remote code

No. All executable extension code is included in the submitted package. The extension does not download or execute remote JavaScript or WebAssembly.

## Data use

The extension handles website content and user communications only when the user explicitly initiates a PaperLens task. Document excerpts, questions, and explicitly attached images are placed into the user's visible ChatGPT conversation. The extension does not retain this content outside the active local request, sell it, use it for advertising, or transfer it for unrelated purposes.

## Reviewer test instructions

1. Clone `https://github.com/Peter-cuhk/PaperLens` and check out `codex/paperlens-local-connectors`.
2. Install Node.js 22.13 or newer.
3. Run `npm ci` and `npm run dev`.
4. Open `http://localhost:3000`, open “本地 AI 接入”, and select “ChatGPT 网页 Chat”.
5. Open a visible `https://chatgpt.com/` tab and sign in with a reviewer-controlled account.
6. Return to PaperLens and click “测试当前服务”.
7. For a full functional test, import a short PDF, select ChatGPT Web Chat, then run a question, translation, or terminology task. The prompt appears in the visible ChatGPT tab and the final visible answer returns to PaperLens.

The extension never asks the reviewer to provide a ChatGPT password to PaperLens. Authentication remains entirely within the normal visible ChatGPT website.
