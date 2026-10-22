# Add 135642-163/dsh-knowledge-base

## What this adds

A local-first knowledge base for DeepSeek Harness:

- imports Word/PPT/Excel/PDF (text or scanned), EPUB, MOBI/AZW3, with OCR quality tracking and column-aware PDF reading order;
- builds Markdown parts with page anchors and OCR quality/confidence metadata;
- ranked regex search, cross-knowledge-base query, precise reading/editing;
- md / jsonl / zip export;
- auto-detects corrupted PDF text layers and OCRs only the affected pages.

Entry file: `data/plugins/135642-163__dsh-knowledge-base.yml` (one file, no README edits).

## Installability

`package.json` declares a bundle manifest:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`cordis.patch.yml` mounts `id: knowledge-base` with `kbRoot`/`defaultKb` defaults.
Source install works:

```bash
dsh plugin --profile web add github:135642-163/dsh-knowledge-base
```

No `npm:` field: the npm name `dsh-knowledge-base` is taken by an unrelated
package (`htcqp802/dsh-knowledge-base`), so this repo installs from GitHub.
The repo has no build scripts; `npm pack --dry-run` produces 22 files / ~95 KB
and excludes the 35 MB OCR model directory (models are downloaded on first use).

## Verification

- `npm test`: 99/99 passing.
- Bundle composition verified in an isolated profile:

  ```bash
  DSH_HOME=/tmp/dsh-bundle-test dsh --profile web --dump-config
  ```

  → emits `- id: knowledge-base` / `name: dsh-knowledge-base` from the package's
  `cordis.patch.yml`.

- Existing catalog entry `dsh-knowledge-base` belongs to a different owner
  (`htcqp802/dsh-knowledge-base`); this one is `135642-163/dsh-knowledge-base`.

## Checklist

- [x] one entry file under `data/plugins/`, no generated README edits
- [x] `dsh.bundle` manifest present
- [x] `description.en` is one line and ends with a period
- [x] no `npm:` / `tarball:` field (GitHub source install)
- [x] category `memory` (local knowledge base)
