# Catalog submission materials

This directory contains a ready-to-copy submission for
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
The catalog stores one YAML file per plugin; the READMEs are generated and must
not be edited by hand.

## The one file

```
data/plugins/135642-163__dsh-knowledge-base.yml
```

It is already at that path under this directory:

```
docs/catalog-pr/data/plugins/135642-163__dsh-knowledge-base.yml
```

## Submit

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`.
2. Copy the file to the same path in the fork:

   ```bash
   cp docs/catalog-pr/data/plugins/135642-163__dsh-knowledge-base.yml \
      <fork>/data/plugins/135642-163__dsh-knowledge-base.yml
   ```

3. Commit only that file. Do **not** edit `README.md` / `README.zh.md`; they are
   regenerated after merge. (Optional preview: `npm ci && node scripts/generate-readme.mjs`,
   then revert the README changes before committing.)
4. Open a PR with the title/body in [PR.md](PR.md).

## Format notes (from the catalog's contributing guide)

- `url` must match the repository exactly.
- `name` is `owner/repo` (link text), not an npm package name.
- `category` must be one of the catalog categories; `memory` fits a local
  knowledge base.
- Only `description.en` is required; it must be one line ending with a period.
  Quote it if it contains `: ` (this entry does).
- `zh` is optional; a maintainer will add it if missing.
- Do **not** add an `npm:` field — the catalog derives npm from the registry and
  rejects hand-written `npm:` keys. This repo intentionally has no npm package.
- `tarball:` is optional and only needed if the repo cannot install from source.
  This repo installs from source (no build scripts), so it is omitted.

## After merge

- The catalog rebuilds and the entry becomes available to dsh-market.
- GitHub installs are updated by comparing the installed commit with the
  repository's default-branch HEAD; publishing a new version only needs
  `git push origin main` (no tag/Release required).
- For an installed user, check:

  ```bash
  curl -s "http://127.0.0.1:55929/dsh-market/api/v1/updates?name=dsh-knowledge-base&force=1"
  ```
