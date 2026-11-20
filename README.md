# Melani

A local-first desktop app for writing novels. Your book is a folder of plain Markdown and JSON files that you own: back it up, sync it with anything, open it in any editor.

- A binder with parts, chapters and scenes; a text view, a corkboard and an outline table; collections
- A codex (story bible) whose names are recognised and highlighted as you write
- Comments, footnotes, highlights, goals and stats
- Find and replace in the text on screen (with regular expressions), and project-wide search that can be limited to a chapter or a scene
- Import from Word, Markdown and text; export to Markdown, Word and EPUB
- Optional AI help, using your own OpenRouter key. With no key, no AI appears and nothing touches the network

## Keeping your work safe

Undo goes further than the text you are typing:

- **Undo and redo** work in the text and in the binder (moves, renames, trashing). A scene's text history survives switching scenes and restarting the app. The **Activity** panel lists everything you can take back, including deleted codex entries and collection edits, with "Undo to here" for the binder.
- **Snapshots** keep a copy of a scene, a chapter or the whole project. The app also takes them by itself before risky changes: restoring, replace all, accepting a large AI suggestion, or a save that would remove most of a scene's text.
- **Backups** of the whole project (manuscript, codex, prompts and research notes) are taken automatically about once a day when you open it, and you can take one at any time. The last 14 are kept. Restoring unpacks a new folder next to your project and never changes the original.

The app keeps its own working files (undo history, backups, crash recovery) in a `.app` folder inside the project. It is ignored by git and safe to leave out of your own backups, but note that a sync tool will copy it unless you exclude it.

Melani is free software, licensed under the [GNU General Public License v3.0](LICENSE). It has no accounts and no telemetry.

## Development

Built with Tauri 2, React, TypeScript and TipTap.

```sh
pnpm install
pnpm tauri dev      # run the app
pnpm test           # frontend tests
cargo test          # backend tests, from src-tauri/
```
