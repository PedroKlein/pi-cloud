# Design system

Pipoca's web UI is built from the tokens in `packages/ui/web/theme.css` and the components in `@pipoca/ui`. Plugins get the same tokens and components, so a plugin page looks like the rest of the app. This page is the reference for both. [ADR 0042](adr/0042-pipoca.md) sets the identity, and [ADR 0020](adr/0020-web-stack.md) sets the stack.

## Principles

- **Quiet by default.** Ink and Ivory carry the interface. Colour is for state, and Butter only shows in the mark.
- **Ask in place.** A choice is a chip in the composer or a switch on its row. It isn't a form. Settings save when they change ([ADR 0040](adr/0040-fewer-forms.md)).
- **Keyboard first, touch friendly.** Every control can be reached with Tab and shows a focus ring. On a touch screen, buttons grow to 44px.
- **One way to do each thing.** Use a component from `@pipoca/ui` before writing classes. If two pages need the same thing, it moves into `@pipoca/ui`.
- **Motion explains, never decorates.** Popovers pop in, pages rise in, and nothing loops except a working state. Reduced motion turns all of it off.

## Colour

Every colour is a CSS variable, set for a theme by `data-theme` on any element. Use the Tailwind names, never a hex value.

| Token                               | Light                   | Dark                  | Use                                   |
| ----------------------------------- | ----------------------- | --------------------- | ------------------------------------- |
| `bg`                                | Ivory `#faf7f0`         | `#14120e`             | Page                                  |
| `panel`                             | `#f3efe5`               | `#1a1814`             | Sidebar and chrome                    |
| `elevated`                          | `#fffdf8`               | `#221f1a`             | Cards, inputs, popovers, dialogs      |
| `hover`                             | `#ebe6da`               | `#2a2721`             | Hovered and current rows              |
| `line` / `line-strong`              | `#e3ddd0` / `#cbc3b3`   | `#322e27` / `#454037` | Borders, then hovered borders         |
| `line-focus`, `focus`               | ink tints               | puff tints            | A focused field's border and its ring |
| `fg` / `fg-strong` / `fg-dim`       | Ink                     | Puff                  | Text, headings, secondary text        |
| `accent` / `on-accent`              | Ink / Ivory             | Puff / Ink            | Primary buttons, selection, links     |
| `working` `waiting` `done` `failed` | teal, amber, green, red | lighter tints         | Session and runner states only        |

The four state colours mean the same thing everywhere and are never used for decoration. Butter `#f3c552` only shows in the mark, since it sits between amber and red.

## Type

| Class           | Size          | Use                                          |
| --------------- | ------------- | -------------------------------------------- |
| `text-hero`     | 40px, serif   | The home question, one per screen            |
| `text-wordmark` | 22px, serif   | `pipoca` next to the mark                    |
| `text-display`  | 28px          | Page titles; serif light for welcome screens |
| `text-title`    | 16px semibold | Section headings                             |
| `text-prose`    | 15px / 24px   | Chat messages and the composer               |
| `text-ui`       | 14px          | Controls and rows                            |
| `text-label`    | 13px          | Field labels, chips                          |
| `text-caption`  | 12px          | Hints, metadata, badges, group labels        |
| `text-mono`     | 13px mono     | Code, paths, commands                        |

Hanken Grotesk is the interface face, Newsreader Light (`font-serif`) is for the wordmark and the few large questions, and JetBrains Mono is for code. Headings and labels are in sentence case. Don't use uppercase or letter-spaced labels.

## Shape, depth and motion

- **Radius:** `rounded-sm` 6px for keys and tags, `rounded-md` 9px for buttons and fields, `rounded-lg` 14px for cards and popovers, `rounded-xl` 20px for composers and dialogs, and `rounded-full` for chips, switches and avatars.
- **Depth:** `shadow-xs` lifts a card or button off the page, `shadow-card` is for a composer or a welcome card, and `shadow-pop` is for a popover, menu or dialog. Nothing else casts a shadow.
- **Motion:** `animate-pop-in` (160ms) for popovers and dialogs, `animate-rise-in` (220ms) for a page or empty state, and `animate-fade-in` for overlays. Transitions run for 150ms on `ease-(--ease-out)`. `prefers-reduced-motion` turns them all off.
- **Width:** chat is `max-w-chat` (760px), settings and other pages are `max-w-form` (768px), and the sidebar is 288px.

## Components

| Component                                                    | Use                                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                                     | `primary` for the one main action on a screen, `default` for others, `ghost` in toolbars, `danger` to delete. Presses scale to 97%. |
| `Field` + `fieldClass`                                       | A label above, the control, and an optional `hint` below. Errors go in a `role="alert"` line.                                       |
| `Picker`                                                     | A chip that opens a searchable list, for folders, models, Environments and Profiles. `quiet` draws it as plain text in a composer.  |
| `Select`                                                     | The browser's select drawn as a field, for short fixed lists in settings.                                                           |
| `Switch`                                                     | An on/off setting that saves when flipped.                                                                                          |
| `FileButton`                                                 | A button that opens the file chooser. Never show a raw file input.                                                                  |
| `ListInput`                                                  | A short list of values as chips, added with Enter.                                                                                  |
| `KeyValues`                                                  | Variables and secrets.                                                                                                              |
| `Badge`                                                      | A state, with a dot. Only the four state colours plus `offline`.                                                                    |
| `PageTitle`, `Section`                                       | A page heading with its one-line description, and its sections.                                                                     |
| `Icon`                                                       | Lucide paths at 1.75 stroke. 16px in controls and 14px in chips.                                                                    |
| Card (`rounded-lg border border-line bg-elevated shadow-xs`) | Grouped content on a page.                                                                                                          |

## Inputs

Every new input follows these patterns, and older screens move over as they're touched. They're the patterns Claude's own apps use:

- **A quiet resting state.** A field is `elevated` with a `line` border. Hovering darkens the border, and focus adds a 4px `focus` ring. It never turns solid black.
- **Grow with the text.** Every textarea grows with what is typed, between a minimum and a maximum height (a base style in `style.css`; composers set their own heights). Nobody should have to drag a resize handle.
- **Enter sends, Shift+Enter makes a new line.** On a phone, Enter makes a new line and the Send button sends. The hint under the composer says which keys do what.
- **Chips, not forms.** The composer's chips pick where a Session runs, its branch and its model. Each one remembers the last choice.
- **Paste and drop.** Images can be pasted or dropped into a Session's composer.
- **`/` and `@` complete.** Commands and files show in a menu above the composer, which works with the arrow keys, Enter and Escape.
- **Save on change.** Switches, pickers and list inputs save at once. A form with a Save button is only for text that needs to be finished first.
- **Say why, in place.** A disabled control says why in its title. A failed save shows its error next to the control. Nothing fails silently.
- **Use the browser's help.** Set `autoComplete`, `type`, `inputMode` and `required` correctly, so password managers, phone keyboards and validation all work.

## Writing

- Labels name the thing ("Folder or repository"), and buttons say what happens ("Start session").
- Each description is one sentence about what something is for. It doesn't explain how the code works.
- Empty states say what goes there and how to add the first one.
- Use "Session", "Project", "Environment" and "Profile" as names, capitalised, as in [concepts](concepts.md).

## Plugins

A plugin's web part imports `@pipoca/ui` and uses only these classes and components. The page only builds the Tailwind classes the app itself uses, so a class that appears nowhere else won't work. Colours come from tokens, so a plugin follows the theme, including a future one that a Profile picks.
