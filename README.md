# Docs Migration Tool - GitHub Sync to ReadMe

This tool is designed to help migrate Markdown documentation from a customer’s local directory into a ReadMe-compatible Markdown (MDX) format, while performing necessary cleanup, HTML-to-Markdown conversion, and generating logs of issues encountered during the process.

---

## Features

- Converts `.md` files into ReadMe-compatible MDX format.
- Removes JavaScript, React components, and `import` statements from the top of files.
- Converts HTML elements into properly formatted Markdown, including headings, lists, strong text, and paragraphs.
- Converts `:::note`, `:::tip`, and `:::info` blocks into `<Callout>` components.
- Preserves HTML tables and transforms Docusaurus-style `<Tabs>` and `<TabItem>` into ReadMe `<Tabs>`/`<Tab>` components.
- Logs skipped files, removed JavaScript/React components, and missing images to a human-readable `_log.csv` file.
- Uploads referenced images to ReadMe (optional), replacing placeholders with `<img>` tags pointing to hosted URLs.
- Creates `_images.csv` manifest mapping doc → original image path → local file → hosted URL.
- Creates destination directories if they do not exist.
- Ensures all migrated files have a `.md` file extension.
- Updates `_order.yaml` in the destination directory (if present) with the correct order of files/folders, formatted in lowercase with spaces replaced by dashes.
- Creates an `index.md` in each migrated directory if one does not already exist, with the title set to the exact name of the parent directory.
- Maintains a JSON migration report.
- Skips over files that cause parsing errors instead of halting the migration.

---

## Requirements

- Node.js v16 or higher
- npm (Node package manager)
- [undici](https://www.npmjs.com/package/undici) (for image upload support)

---

## Installation

1. Clone or download this script into a working directory, for example:

   ```bash
   mkdir ~/Tools/md-migration-tool
   cd ~/Tools/md-migration-tool
   ```

2. Place the `convert-to-readme-mdx.mjs` file in this directory.

3. Install dependencies:

   ```bash
   npm install
   ```

4. Copy `.env.example` to `.env` and add your ReadMe API key if you plan to use image uploading:

   ```bash
   cp .env.example .env
   ```

---

## Command-Line Flags

The migration script supports the following flags:

| Flag              | Required | Description                                                                                                               |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--cwd`           | Yes      | The working directory where the script will run (the root of the customer’s documentation folder).                        |
| `--src`           | Yes      | The relative path (from `--cwd`) to the source directory containing the `.md` files you want to migrate.                  |
| `--out`           | Yes      | The absolute path to the destination directory in your ReadMe GitHub repo where the converted files should be saved.      |
| `--copy`          | No       | Optional secondary output directory for saving converted files.                                                           |
| `--include-mdx`   | No       | If set, include `.mdx` files in addition to `.md`.                                                                        |
| `--upload-images` | No       | If set, upload referenced images to ReadMe via API and rewrite documents with hosted image URLs.                          |
| `--images-src`    | No       | Root directory where local images are stored (typically your `/static` folder). Script will search `img/` and `assets/`.  |
| `--readme-api-key`| No       | API key for ReadMe. If not passed, will look in `README_API_KEY` env var.                                                 |

---

## Example Usage

Basic migration:

```bash
node convert-to-readme-mdx.mjs   --cwd '/path/to/customer/docs/modules/example-module'   --src .   --out '/path/to/readme/repo/docs/Example Module'
```

With image upload:

```bash
export README_API_KEY="your_api_key_here"

node convert-to-readme-mdx.mjs   --cwd '/path/to/customer/docs'   --src .   --out '/path/to/readme/repo/docs'   --images-src '/path/to/static'   --upload-images
```

---

## Output Files

- Migrated `.md` files in the specified `--out` directory.
- `_log.csv` — A CSV log of:
  - Skipped files with error messages
  - Missing images (with full URLs)
  - Removed JavaScript/React code snippets
- `_images.csv` — A manifest of images mapping doc → original path → local path → uploaded URL.
- `migration-report.json` — Detailed JSON report of the migration process.

---

## Notes

- Only `.md` files in the specified directory tree are processed (recursive).
- The `_log.csv` and `_images.csv` files are created in the output root directory and can be ignored in Git by adding them to `.gitignore`.
- If `--upload-images` is enabled but an image cannot be found or fails to upload, it will remain a placeholder, and a log entry will be created.

