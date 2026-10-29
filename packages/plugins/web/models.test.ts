import { expect, test } from "bun:test";
import { modelOptions } from "./models";

const many = [
  { provider: "openai", id: "gpt-5" },
  { provider: "alias", id: "medium-1" },
  { provider: "anthropic", id: "claude-sonnet" },
  { provider: "anthropic", id: "claude-opus" },
  { provider: "sap-ai-core", id: "gpt-5" },
  { provider: "sap-ai-core", id: "claude-sonnet" },
  { provider: "google", id: "gemini-pro" },
  { provider: "google", id: "gemini-flash" },
  { provider: "mistral", id: "mistral-large" },
];

test("lists models by provider, aliases first, with recent ones on top", () => {
  const { options, openGroups } = modelOptions(many, [
    "sap-ai-core/claude-sonnet",
    "gone/model",
  ]);

  expect(options.map(({ group }) => group)).toEqual([
    "Recent",
    "alias",
    "anthropic",
    "anthropic",
    "google",
    "google",
    "mistral",
    "openai",
    "sap-ai-core",
    "sap-ai-core",
  ]);

  expect(options[0]).toEqual({
    value: "sap-ai-core/claude-sonnet",
    label: "claude-sonnet",
    detail: "sap-ai-core",
    group: "Recent",
  });

  expect(openGroups).toEqual(["Recent", "alias"]);
});

test("leaves a short list open and without recent models", () => {
  const { options, openGroups } = modelOptions(many.slice(0, 3), [
    "openai/gpt-5",
  ]);

  expect(options.map(({ value }) => value)).toEqual([
    "alias/medium-1",
    "anthropic/claude-sonnet",
    "openai/gpt-5",
  ]);

  expect(openGroups).toBeUndefined();
});
