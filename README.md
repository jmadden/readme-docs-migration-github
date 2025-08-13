# MD to ReadMe Migration Tool

This tool automates the migration of customer Markdown documentation into a ReadMe-compatible format.

It is designed for cases where:

- Customer files may contain **HTML**, **JavaScript**, or **React/MDX components** that must be removed or converted.
- Customer frontmatter differs from ReadMe's frontmatter format.
- HTML must be converted to clean, semantic Markdown.
- Image references and missing assets must be logged for follow-up.
- A `_order.yaml` file may need updating to reflect migrated file/folder structure.
- A placeholder `index.md` may need to be generated.

---

## Features

1. **Frontmatter Conversion**

   - Transforms customer frontmatter into ReadMe frontmatter:
     ```yaml
     ---
     title: Example Title
     deprecated: false
     hidden: false
     metadata:
       robots: index
     ---
     ```

2. **HTML → Markdown Conversion**

   - Converts `<h1>` to `#`, `<h2>` to `##`, `<h3>` to `###`, `<ul>` to `- list`, `<strong>` to `**bold**`, `<p>` to new lines, etc.

3. **JavaScript & MDX Component Removal**

   - Removes embedded scripts/components.
   - Logs removed code in `_log.csv`.

4. **Import Statement Removal**

   - Removes all top-of-file `import` statements.
   - Logs removed imports.

5. **Image Logging**

   - Detects image URLs in Markdown or MDX syntax.
   - Logs missing image references in `_log.csv` for follow-up.

6. **Graceful Error Handling**

   - If a file fails conversion, logs the issue in `_log.csv` and continues.

7. **Directory Management**

   - Can create the destination directory if it does not exist.
   - Only processes `.md` files (no recursion into subdirectories unless specified).

8. **\_order.yaml Update**

   - If `_order.yaml` exists in the destination folder, updates it to reflect the new files/folders.
   - Converts spaces to dashes, lowercases names.

9. **index.md Auto-Creation**

   - If missing, creates `index.md` with title based on the **parent directory name** exactly as written.

10. **Logging**
    - Generates `_log.csv` with columns:
      - **Type** – Error, Missing Images, Removed JS, Removed Imports.
      - **File** – Full file path.
      - **Error Message** – If applicable.
      - **Missing Images** – Comma-separated list of missing images.
      - **Removed Code** – Code snippets removed.

---

## Requirements

- **Node.js** v16+
- **npm** or **yarn** installed

---

## Installation

1. Clone or download this script into a working directory, for example:

   ```bash
   mkdir /path/to/md-migration-tool
   cd /path/to/md-migration-tool
   ```

2. Install dependencies (if any are needed for HTML → Markdown conversion):

   ```bash
   npm install
   ```

3. Make sure your source (customer docs) and destination (ReadMe repo) folders are ready.

---

## Usage

```bash
node convert-to-readme-mdx.mjs <source-directory> <destination-directory>
```

### Example

**Customer docs (source directory):**

```bash
/path/to/customer/docs/workflow/quick-start/workflow-steps
```

**ReadMe repo (destination directory):**

```bash
/path/to/readme/repo/docs/Workflows/quick-start
```

Run the script:

```bash
node convert-to-readme-mdx.mjs "/path/to/customer/docs/workflow/quick-start/workflow-steps" "/path/to/readme/repo/docs/Workflows/quick-start"
```

---

## Output

1. Migrated `.md` files in destination directory.
2. `_log.csv` summarizing:
   - Errors
   - Missing images
   - Removed JavaScript/MDX components
   - Removed imports
3. `_order.yaml` updated (if exists).
4. `index.md` created if missing.

---

## Notes

- If a file contains unsupported JavaScript or MDX, it will be removed from the output and logged.
- HTML is converted to Markdown using rules that preserve semantic meaning and readability.
- The `_log.csv` can be safely `.gitignore`'d to avoid committing migration logs to your repo.

---

## License

MIT License
