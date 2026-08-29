# PaperLens ChatGPT Web Bridge Privacy Policy

Effective date: August 29, 2026

PaperLens ChatGPT Web Bridge is an open-source Chrome extension that connects a locally running PaperLens reader to a ChatGPT conversation visible in the user's browser.

## Data handled by the extension

The extension handles data only after the user explicitly starts a PaperLens task. Depending on that task, the data may include document excerpts, page text, a selected passage, the user's question, recent PaperLens conversation context, and images explicitly attached by the user. The extension places this content into the user's visible ChatGPT conversation and returns the final visible response to the local PaperLens application.

## Data the extension does not access

The extension does not request, read, or store ChatGPT passwords, cookies, API keys, payment information, or private authentication tokens. It does not inspect unrelated websites or unrelated tab content.

## Storage and retention

The extension stores only a short-lived local pairing token in `chrome.storage.session`. This token restricts bridge access to the PaperLens instance running on the same computer, is not synchronized to the user's Google account, and is cleared with the browser session. Prompt content, attached images, and returned answers are not retained by the extension after the active request completes.

PaperLens may store imported documents, answers, translations, notes, and reading state locally on the user's device as part of the PaperLens application's normal functionality. That local application data is not collected by the extension publisher.

## Third-party processing

Content submitted through the extension is processed by ChatGPT in the user's visible, signed-in conversation and is subject to the user's agreement and privacy settings with OpenAI. The extension does not use a private ChatGPT API or transmit task content to any additional service.

## Data sharing and prohibited uses

The extension does not sell user data. It does not use or transfer data for advertising, creditworthiness, lending, or purposes unrelated to its single purpose. It does not combine user data with data from unrelated sources.

## Security

The local bridge listens only on loopback network interfaces. Connections require a short-lived pairing token supplied by the local PaperLens page and are restricted to the PaperLens extension origin. The extension operates through the visible ChatGPT page so the user can see the submitted prompt and returned answer.

## Contact and source code

Source code, issue reporting, and support are available at:

https://github.com/Peter-cuhk/PaperLens

For privacy questions, open a GitHub issue at:

https://github.com/Peter-cuhk/PaperLens/issues
