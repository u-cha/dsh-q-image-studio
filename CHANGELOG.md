# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-08

### Added

- **Q Image Studio identity:** package `@u-cha/dsh-q-image-studio`, patch id `dsh-q-image-studio`, routes under `/plugins/dsh-q-image-studio/`, and a dedicated sidebar panel.
- **Provider settings v2:** connection check with paginated DashScope model discovery, image-generation capability filtering, verified model selection, manual model entry, and a Qwen-only warning for other domains.
- **Language and motion:** EN/RU switch stored in the plugin config, plus an Animations toggle that controls the generation pulse and respects `prefers-reduced-motion`.
- **Generation modes:** Precise (one image) and Vibe Create (four parallel images with independent seeds).
- **Size controls:** Auto, preset long side and aspect ratio with live pixel count and tariff hint, and manual width/height with validation.
- **Seed controls:** random seed by default, fixed seed input, and automatic prompt-enhancement fallback for exact repeats.
- **Transparent background:** exact Qwen transparency prompt, forced `prompt_extend=false`, alpha verification, and a warning when the model returns no alpha channel.
- **Prompt guide:** English digest of Qwen prompt advice opened as a modal reference from the prompt field, with a link to the full guide; closed by X, Esc, or a click outside.
- **Result cards and gallery:** readable metadata, copy/reveal/hide/delete actions, reuse and develop actions, references from the gallery, date groups, and “Show more”.
- **Icon:** `icon.png` shipped in the package root and declared as the manifest `icon`, and reused in the sidebar entry and the page brand, so DSH renders the Q + arc "MAGE" mark everywhere.
- **Saved parameters:** `index.json` records seed, prompt and final prompt, prompt enhancement, transparency and alpha state, full request JSON, plugin version, model, size, references, and date.
- **Custom dropdowns** for profiles, models, and preset long sides with keyboard navigation and ARIA listbox semantics.
- **Settings quality of life:** visible autosave status, editable profile name with a fallback label, and two-step profile deletion that also removes the vault key.
- **Save-folder migration:** legacy `~/Images/DSH-Image-Studio` contents move to `~/Images/Q-Image-Studio` on first launch; later folder changes ask before moving files and refuse a non-empty destination.
- **Page layout:** Q Image Studio is now a full page in the main area with a studio column, a large result canvas, and a horizontally scrollable history strip.
- **Lightbox:** click any result to see its prompt, final prompt, model, size, seed, transparency, file and date, with actions to reuse the settings, send it to references, copy the prompt, or reveal it in Finder.
- **Reference drop zone:** drag images from the history, drop files from Finder, or paste from the clipboard.
- **Model availability:** a model refused by the provider is marked as unavailable until a call succeeds.

### Changed

- Migrated provider keys from `IMAGE_STUDIO_KEY_*` to `DSH_Q_IMAGE_STUDIO_KEY_*`; legacy keys are read once and removed after migration.
- Switched generation to DashScope's native multimodal endpoint and parse `output.choices[].message.content[].image`.
- Reworked the settings card into a compact connection editor; generation controls live in the panel.
- Improved result-card actions, feed layout, spacing, focus states, and dark-theme contrast.
- **Prompt guide** opens as a modal reference with a link to the full guide; the inline copy action was removed.
- **Generation ring:** a thin neon ring and compact progress dots replace the previous full-panel glow.
- **Errors** show the HTTP status, the provider code, and the provider message instead of a generic failure.
- **README** is bilingual with a language switch, a real screenshot, and honest notes about the credential vault.

### Fixed

- Concurrent Vibe saves no longer collide on identical timestamps and filenames.
- Native model lists in `output.models` are parsed; an empty result falls back to the compatible model list.
- RGB PNGs without an alpha channel no longer raise a misleading transparency warning.
- Absolute image paths from older `index.json` files are normalized to the current gallery directory.
- Legacy `saveDir` values migrate to the new absolute default without losing files.

## [0.0.1] - 2026-11-07 (internal preview, never published)

### Added

- Initial DSH image plugin with provider profiles, DashScope/OpenAI-compatible generation, reference images, keys in the DSH vault, and a result gallery in the Web UI.
- Host tools and routes for generation, connection checks, key management, gallery listing, deletion, reveal, and folder selection.
- Local image storage with an atomic `index.json` and PNG download limits.
