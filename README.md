# MD Migration Tool

This tool is designed to help migrate Markdown documentation from a customer’s local directory into a ReadMe-compatible Markdown (MDX) format, while performing necessary cleanup, HTML-to-Markdown conversion, and generating logs of issues encountered during the process.

---

## Features

- Converts `.md` files into ReadMe-compatible MDX format.
- Removes JavaScript, React components, and `import` statements from the top of files.
- Converts HTML elements into properly formatted Markdown, including headings, lists, strong text, and paragraphs.
- Logs skipped files, removed JavaScript/React components, and missing images to a human-readable `_log.csv` file.
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

---

## Command-Line Flags

The migration script supports the following flags:

| Flag    | Required | Description                                                                                                                                                               |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--cwd` | Yes      | The working directory where the script will run (the root of the customer’s documentation folder).                                                                        |
| `--src` | Yes      | The relative path (from `--cwd`) to the source directory containing the `.md` files you want to migrate. Use `.` to indicate the current directory.                       |
| `--out` | Yes      | The absolute path to the destination directory in your ReadMe GitHub repo where the converted files should be saved. If the directory does not exist, it will be created. |

---

## Example Usage

```bash
node convert-to-readme-mdx.mjs \
  --cwd '/path/to/customer/docs/modules/example-module' \
  --src . \
  --out '/path/to/readme/repo/docs/Example Module'
```

### How This Works

- `--cwd` sets the starting point for the migration.
- `--src` tells the script which subdirectory (relative to `--cwd`) contains the markdown files.
- `--out` tells the script where in the ReadMe repo to place the processed files.

---

## Output Files

- Migrated `.md` files in the specified `--out` directory.
- `_log.csv` — A CSV log of:
  - Skipped files with error messages
  - Missing images (with full URLs)
  - Removed JavaScript/React code snippets
- `migration-report.json` — Detailed JSON report of the migration process.

---

## Example Workflow

### Before

**Customer docs directory:**

```bash
/path/to/customer/docs/workflow/quick-start/workflow-steps
```

**ReadMe repo directory:**

```bash
/path/to/readme/repo/docs/Workflows/quick-start
```

### Running the script

```bash
node convert-to-readme-mdx.mjs \
  --cwd '/path/to/customer/docs/workflow/quick-start/workflow-steps' \
  --src . \
  --out '/path/to/readme/repo/docs/Workflows/quick-start'
```

This will:

1. Convert all `.md` files in the source folder to ReadMe-compatible MDX.
2. Remove any imports, JavaScript, and React/MDX components.
3. Convert HTML to proper Markdown syntax.
4. Log skipped files, missing images, and removed JS/React code.
5. Create/update `_order.yaml` if it exists in the output directory.
6. Ensure `index.md` exists with the title set to the parent directory’s exact name.

---

## Notes

- Only `.md` files in the specified directory are processed — subdirectories are ignored unless explicitly passed via `--src`.
- The `_log.csv` file is created in the output directory for review and can be ignored in Git by adding it to `.gitignore`.
