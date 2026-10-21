import { Marked, type Tokens } from "marked";

const escapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => escapes[char] ?? char);
}

function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href, "https://relative.invalid/");

    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? href
      : undefined;
  } catch {
    return undefined;
  }
}

// Answers quote tool output and repository files, so raw HTML in them is
// shown as text and only web links become links.
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escape(text),
    link({ href, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens);
      const target = safeHref(href);

      return target === undefined
        ? label
        : `<a href="${escape(target)}" target="_blank" rel="noreferrer">${label}</a>`;
    },
    image: ({ text }) => escape(text),
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false });
}
