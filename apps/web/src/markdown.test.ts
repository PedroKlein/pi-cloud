import { expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

test("renders markdown", () => {
  expect(renderMarkdown("**done**, see `x.ts`")).toBe(
    "<p><strong>done</strong>, see <code>x.ts</code></p>\n",
  );
});

test("shows raw HTML as text", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">\n\n<b>hi</b>');

  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
  expect(html).toContain("&lt;img");
});

test("links only web addresses", () => {
  expect(renderMarkdown("[docs](https://pi.dev)")).toContain(
    '<a href="https://pi.dev" target="_blank" rel="noreferrer">docs</a>',
  );

  expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a");
});
