import assert from "node:assert/strict";
import test from "node:test";

import { createRequestActivityTracker, taskChannelForMode } from "../bridge/request-activity.mjs";

test("maps translation, chat, and terminology work to independent task channels", () => {
  assert.equal(taskChannelForMode("translate"), "translation");
  assert.equal(taskChannelForMode("terms"), "terms");
  assert.equal(taskChannelForMode("chat"), "chat");
  assert.equal(taskChannelForMode("repository"), "chat");
});

test("tracks concurrent tasks on one provider without an exclusive busy lock", () => {
  const activity = createRequestActivityTracker();
  const stopTranslation = activity.start("chatgpt-web", "translate");
  const stopChat = activity.start("chatgpt-web", "chat");
  const stopTerms = activity.start("chatgpt-web", "terms");

  assert.deepEqual(activity.snapshot("chatgpt-web"), {
    total: 3,
    channels: { translation: 1, chat: 1, terms: 1 },
  });

  stopChat();
  stopChat();
  assert.deepEqual(activity.snapshot("chatgpt-web"), {
    total: 2,
    channels: { translation: 1, chat: 0, terms: 1 },
  });

  stopTranslation();
  stopTerms();
  assert.deepEqual(activity.snapshot("chatgpt-web"), {
    total: 0,
    channels: { translation: 0, chat: 0, terms: 0 },
  });
});
