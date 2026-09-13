import { describe, expect, it } from "vitest";

import {
  isEmailFormDirty,
  isNtfyFormDirty,
  isTelegramFormDirty,
  isWebhookFormDirty,
} from "../channel-form-dirty";

// The Test button sends through the saved config, so each card has to know
// when its form holds something the server does not (#947: a Gotify format
// picked after the last save was tested as the old generic body).
describe("channel form dirty state", () => {
  const webhookSaved = {
    url: "https://gotify.example.com/message",
    headerName: "X-Gotify-Key",
    format: "gotify",
  };
  const webhookForm = {
    url: "https://gotify.example.com/message",
    headerName: "X-Gotify-Key",
    headerValue: "",
    format: "gotify" as const,
  };

  it("webhook: a form that matches the saved config is clean", () => {
    expect(isWebhookFormDirty(webhookForm, webhookSaved)).toBe(false);
  });

  it("webhook: a changed format, URL, header name or a typed header value is a change", () => {
    expect(
      isWebhookFormDirty(webhookForm, { ...webhookSaved, format: undefined }),
    ).toBe(true);
    expect(
      isWebhookFormDirty(
        { ...webhookForm, url: "https://gotify.example.com/message?token=x" },
        webhookSaved,
      ),
    ).toBe(true);
    expect(
      isWebhookFormDirty({ ...webhookForm, headerName: "" }, webhookSaved),
    ).toBe(true);
    expect(
      isWebhookFormDirty({ ...webhookForm, headerValue: "tok" }, webhookSaved),
    ).toBe(true);
  });

  it("webhook: a config saved before the format choice reads as generic", () => {
    expect(
      isWebhookFormDirty(
        { ...webhookForm, format: "generic" },
        { ...webhookSaved, format: undefined },
      ),
    ).toBe(false);
  });

  it("ntfy: server, topic and a typed auth token count", () => {
    const saved = { serverUrl: "https://ntfy.sh", topic: "t" };
    const form = { serverUrl: "https://ntfy.sh", topic: "t", authToken: "" };
    expect(isNtfyFormDirty(form, saved)).toBe(false);
    expect(isNtfyFormDirty({ ...form, topic: "u" }, saved)).toBe(true);
    expect(isNtfyFormDirty({ ...form, serverUrl: "https://x" }, saved)).toBe(
      true,
    );
    expect(isNtfyFormDirty({ ...form, authToken: "a" }, saved)).toBe(true);
  });

  it("email: the recipient counts", () => {
    expect(
      isEmailFormDirty({ recipient: "a@x.io" }, { recipient: "a@x.io" }),
    ).toBe(false);
    expect(
      isEmailFormDirty({ recipient: "b@x.io" }, { recipient: "a@x.io" }),
    ).toBe(true);
  });

  it("telegram: a typed bot token or a changed chat id counts; whitespace alone does not", () => {
    expect(
      isTelegramFormDirty({ botToken: "", chatId: "1" }, { chatId: "1" }),
    ).toBe(false);
    expect(
      isTelegramFormDirty({ botToken: "  ", chatId: "" }, { chatId: null }),
    ).toBe(false);
    expect(
      isTelegramFormDirty(
        { botToken: "123:abc", chatId: "1" },
        { chatId: "1" },
      ),
    ).toBe(true);
    expect(
      isTelegramFormDirty({ botToken: "", chatId: "2" }, { chatId: "1" }),
    ).toBe(true);
  });

  it("nothing loaded yet is never a change", () => {
    expect(isWebhookFormDirty(webhookForm, undefined)).toBe(false);
    expect(
      isNtfyFormDirty({ serverUrl: "", topic: "", authToken: "x" }, undefined),
    ).toBe(false);
    expect(isEmailFormDirty({ recipient: "x" }, undefined)).toBe(false);
    expect(isTelegramFormDirty({ botToken: "x", chatId: "" }, undefined)).toBe(
      false,
    );
  });
});
