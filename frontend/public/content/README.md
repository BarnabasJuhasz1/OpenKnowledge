# Editable content

Files in this folder hold **editable copy** for the OpenKnowledge frontend —
documentation, tutorials, FAQs, and info pop-ups. You can edit them directly
without touching any component code; the app fetches them at runtime.

## How it works

- Every `.md` file here is served verbatim at `/content/<path>.md`.
- A page references copy by its **content key** — the path under this folder
  without the `.md` extension. For example `docs/guide.md` has the key
  `docs/guide`, and is rendered with `<app-markdown src="docs/guide" />`.
- Edit a file, save, reload the page — the new text appears. No rebuild of
  component templates is needed (a production deploy still re-ships the assets).

## Current content

| Key            | File                | Used by                                  |
| -------------- | ------------------- | ---------------------------------------- |
| `docs/guide`   | `docs/guide.md`     | Documentation page → "General Guide" tab |
| `popups/alpha` | `popups/alpha.md`   | "Alpha" version pop-up in the top nav    |

## Adding a new editable text

1. Drop a new `.md` file anywhere under this folder, e.g.
   `tutorials/getting-started.md`.
2. In the relevant component template, render it with
   `<app-markdown src="tutorials/getting-started" />`
   (import `MarkdownComponent` in that component).

## Supported Markdown

Headings (`#`–`####`), **bold**, *italic*, `inline code`, fenced code blocks
(```), links `[text](url)`, unordered (`-`) and ordered (`1.`) lists,
blockquotes (`>`), and horizontal rules (`---`). Raw HTML is escaped and will
not render — this keeps the content safe to edit.
