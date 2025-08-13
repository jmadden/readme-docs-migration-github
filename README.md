# Markdown → ReadMe Migration Tool

This Node.js script automates migrating a customer’s Markdown docs into a ReadMe‑compatible format. It converts embedded HTML to Markdown, normalizes frontmatter, strips unsupported code (JavaScript/MDX), logs all changes, ensures each target directory has an `index.md`, and (optionally) refreshes `_order.yaml` when present.

---

## Features

- **Non‑recursive processing**: operates only on files directly inside the `--src` folder.
- **Inputs**: `.md` by default; add `--include-mdx` to also accept `.mdx` in the same folder.
- **Outputs**: always writes `.md` files (ReadMe wants `.md`, not `.mdx`).
- **Frontmatter mapping**:
  - Builds ReadMe frontmatter like:
    ```yaml
    ---
    title: Title Here
    deprecated: false
    hidden: false
    metadata:
      robots: index
    ---
    ```
  - Title source preference: customer frontmatter (`sidebar_label` → `title`) → first `# Heading` → fallback from filename (Title Case).
- **HTML → Markdown conversion** (headings, lists, emphasis, breaks, etc.).
- **Unsafe code removal**:
  - Strips `<script>` tags (inline code and external `src`).
  - Removes inline DOM event handlers (e.g., `onClick`, `onLoad`).
  - Removes top‑of‑file `import …` lines.
  - Detects MDX/JSX components and records them.
- **Comprehensive audit log**: `_log.csv` with columns:
  - `Type` (e.g., `IMAGES`, `REMOVED_JS`, `REMOVED_IMPORTS`, `REMOVED_MDX`, `STRIPPED_HTML`, `FAILED`, `FATAL`)
  - `File`
  - `Error Message`
  - `Removed Code` (removed imports, JS, handlers, and MDX/JSX components)
  - `Missing Images` (newline‑separated list; includes values from expressions like `useBaseUrl("/img/…")`)
- **Image URL discovery**:
  - Markdown images `![alt](url)`
  - HTML `<img src="…">`
  - JSX `src={useBaseUrl("…")}` and `useBaseUrl("…")` anywhere in text
- **`index.md` auto‑creation**:
  - If missing in the output directory, creates `index.md` using the title from the first `.md` file (frontmatter `title` → first `#` → Title‑Case filename).
- **`_order.yaml` updater** (idempotent, optional):
  - If `_order.yaml` exists in the output directory, rewrites it to list **immediate subfolders** and **`.md` files** (excluding `index.md`) as slugs:
    ```
    - how-to-api
    - instructions
    - workflows
    ```
  - Rules: lowercase; spaces → dashes; one item per line prefixed with `- `.
- **Error‑tolerant**: logs failures but continues to the next file.

---

## Requirements

- **Node.js** ≥ 18
- **npm** (bundled with Node)
- Access to:
  - The customer docs folder
  - Your GitHub‑synced ReadMe docs folder

---

## Installation

1. Clone or download the script into a working directory, for example:

   ```bash
   mkdir ~/Tools/md-migration-tool
   cd ~/Tools/md-migration-tool
   ```

2. Save the script as convert-to-readme-mdx.mjs in that folder.

3. Install dependencies:

```bash
npm install
```

4. (Optional) Make it executable:

```bash
chmod +x convert-to-readme-mdx.mjs
```

## Usage

### Command

```bash
node convert-to-readme-mdx.mjs \
  --cwd "<base-customer-docs-dir>" \
  --src "<relative-path-to-source-folder>" \
  --out "<absolute-output-folder>" \
  [--dest-name "<subdir-name>"] \
  [--copy "<second-output-folder>"] \
  [--config "<path/to/config.json>"] \
  [--include-mdx] \
  [--in-place]
```

### Flags

- --cwd

Directory to chdir into before running (useful when providing a relative --src).

- --src

Source folder **relative to --cwd** containing .md (and optionally .mdx) files.
**Non‑recursive**: only processes files directly inside this folder.

- --out

Absolute path to the primary output directory. Created if it doesn’t exist.

- --dest-name

Optional subdirectory name to create under --out (and --copy if used).

- --copy

Optional second destination to also write converted files to.

- --config

Optional JSON config file to tweak defaults (e.g., component replacement rules).

- --include-mdx

When present, also processes .mdx files in the same (non‑recursive) folder.

- --in-place

Write the converted files back into --src. (Use with caution.)

### Example

**Customer docs:**

```bash
/Users/jim/Customer Projects/Socure/devhub-v2-feature-docs-3225-create-doc-structure-effectiv/docs/workflow/quick-start/workflow-steps
```

**ReadMe repo:**

```bash
/Users/jim/Customer Projects/Socure/docs_readme/docs/Workflows/quick-start
```
