# 0020: Web stack

- Status: accepted
- Date: 2026-10-21

## Context

The web UI in `apps/web` is plain DOM and one hand-written stylesheet. That was enough for the first slice ([ADR 0004](0004-first-slice-and-provider-order.md)), but the UI now has to grow: a chat built from turns and work blocks, a question card, a composer that queues, Session states, Projects, a phone layout and a terminal view. Building that with `createElement` and global CSS gets hard to change and hard to review.

There is now a design system for it: tokens for two themes (colour, type, spacing, radius, shadow and size) and components named with a `pc-` prefix (button, badge, session row, view switch, chat turn, work block, question card, composer and notice). There are also mockups of the main screens built on those tokens.

Two later features shape how themes work:

- Users should be able to make their own themes, the way Pi lets users change everything else.
- A Session should be able to show its Profile's theme, so it's clear which Profile it runs. Profiles come in v2.

Every dependency is something to keep up to date. The stack should lean on the browser and Bun first and add a library only where they fall short.

## Decision

### React and Tailwind, bundled by Bun

- The web UI is written in React with TypeScript (`.tsx`).
- Styles are Tailwind utility classes. There are no hand-written stylesheets beyond the tokens, the fonts and Tailwind's entry file.
- Bun bundles it, as it already does through the HTML import in `apps/pi-cloud/src/serve.ts`, with `bun-plugin-tailwind` for the CSS. There is no Vite and no separate dev server.

### Tokens are CSS variables

- The design system's tokens become CSS variables with the same names (`--bg`, `--accent`, `--status-waiting` and so on), one block per theme selected by `data-theme`.
- Tailwind's `@theme` points at those variables, so `bg-panel` or `text-dim` read the live value instead of a colour compiled into the CSS.
- A theme is a set of values for those variables. It can be set on the whole page or on one element, so a Session view can carry a different theme from the shell. User themes and Profile themes then need no rebuild and no change to components.
- Components use token classes only. A raw colour in a component is a lint or review error.

### Dependencies

Runtime:

- `react` and `react-dom`.
- `@xterm/xterm` and `@xterm/addon-fit`, already used.
- `marked` for the markdown in Pi's answers.

Development:

- `tailwindcss` and `bun-plugin-tailwind`.
- `@types/react`.
- `happy-dom` for component tests under `bun test`.
- `eslint-plugin-react-hooks`.

### What we build instead of adding libraries

| Need                             | Instead of                | We use                                                                                     |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| Dialogs, sheets, menus, popovers | Radix, shadcn/ui          | `<dialog>`, the Popover API and `<details>`                                                |
| Variants of a component          | cva, clsx, tailwind-merge | a small `cn()` and plain objects from variant to classes                                   |
| Server data and live events      | TanStack Query            | our own hooks over `fetch` and `EventSource` (`useApi`, `useSessions`, `useSessionEvents`) |
| Routing                          | a router library          | the current hash routes behind one hook                                                    |
| Icons                            | lucide-react              | the Lucide icons we use, copied as SVG into one module                                     |
| Fonts                            | @fontsource               | the IBM Plex woff2 files we use, committed and bundled                                     |
| Long chats and lists             | a virtualisation library  | CSS `content-visibility: auto`                                                             |
| Code highlighting                | Shiki                     | none for now; code blocks are monospace on `bg-code`                                       |

- The server runs on the user's own machine, so the bundle loads nothing from a CDN, fonts included.
- Markdown rendering escapes raw HTML. Answers can quote tool output and repository files, so HTML in them is shown as text, never run.
- Searchable pickers (model, repository, branch) share one combobox component of our own, with keyboard tests.
- A menu is placed next to its button with CSS anchor positioning where the browser has it, and a few lines of positioning code where it doesn't.
- If one of these turns out to cost more than a library would, we add that one library in its own change, not a whole kit.

### Layout and tests

- Shared components, the tokens and the icons live in a `packages/ui` workspace package, so the app and the plugins' web parts use the same ones.
- Component tests render real components into `happy-dom` and find elements by role and text, the way a user would. The existing Playwright end-to-end test keeps covering the real app.
- The migration goes screen by screen. Old and new code can live side by side until the last screen moves over, then the old stylesheet is deleted.

## Consequences

- The UI matches the design system's tokens and components, and changing a token changes every screen.
- User themes and per-Profile themes are a matter of setting variables, not of rewriting components.
- The browser bundle grows by React. Pi Cloud's page is an app people keep open, so load size matters less than for a public site.
- We own a combobox, a markdown renderer setup, menu positioning and a few data hooks: a few hundred lines with their own tests.
- Plugin web parts change shape to React components ([ADR 0015](0015-plugins.md), amended).
