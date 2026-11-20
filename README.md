# Melani

A local-first desktop app for writing novels. Your book is a folder of plain Markdown and JSON files that you own: back it up, sync it with anything, open it in any editor.

- A binder with parts, chapters and scenes; a text view, a corkboard and an outline table; collections
- A codex (story bible) whose names are recognised and highlighted as you write
- Comments, footnotes, highlights, snapshots, goals and stats
- Import from Word, Markdown and text; export to Markdown, Word and EPUB
- Optional AI help, using your own OpenRouter key. With no key, no AI appears and nothing touches the network

Melani is free software, licensed under the [GNU General Public License v3.0](LICENSE). It has no accounts and no telemetry.

## Development

Built with Tauri 2, React, TypeScript and TipTap.

```sh
pnpm install
pnpm tauri dev      # run the app
pnpm test           # frontend tests
cargo test          # backend tests, from src-tauri/
```
