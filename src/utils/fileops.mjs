import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import pc from 'picocolors';

/**
 * Recursively discover Markdown files under `root`.
 * Optionally include `.mdx` files when `includeMdx` is true.
 */
export async function findMarkdownFilesRecursive(rootDirectory, { includeMdx = false } = {}) {
  const discoveredFiles = [];

  async function walkDirectory(directoryPath) {
    let entries;
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        const isIgnored = entry.name === 'node_modules' || entry.name.startsWith('.');
        if (!isIgnored) {
          await walkDirectory(entryPath);
        }
        continue;
      }

      if (entry.isFile()) {
        const lower = entryPath.toLowerCase();
        const isMarkdown = lower.endsWith('.md') || (includeMdx && lower.endsWith('.mdx'));
        if (isMarkdown) {
          discoveredFiles.push(entryPath);
        }
      }
    }
  }

  await walkDirectory(rootDirectory);
  return discoveredFiles;
}

/**
 * Ensure each folder in `root` contains an `index.md`.
 * Title is the folder's basename (exactly as written).
 */
export async function ensureIndexesForCreatedDirs(rootDirectory) {
  async function recurse(directoryPath) {
    const indexMdPath = path.join(directoryPath, 'index.md');

    try {
      await fs.access(indexMdPath);
    } catch {
      const frontmatter = {
        title: path.basename(directoryPath),
        deprecated: false,
        hidden: false,
        metadata: { robots: 'index' },
      };
      const yamlBlock = yaml.dump(frontmatter, { lineWidth: 0 });
      await fs.writeFile(indexMdPath, `---\n${yamlBlock}---\n`, 'utf8');
      console.log(pc.blue(`Created index.md in ${directoryPath} (title: "${frontmatter.title}")`));
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        await recurse(path.join(directoryPath, entry.name));
      }
    }
  }

  await recurse(rootDirectory);
}

/**
 * If a folder contains `_order.yaml`, rewrite it to list folders and `.md` files
 * as lowercase, dash-separated slugs (excluding index.md and internal files).
 */
export async function updateAllOrderYamlIfPresent(rootDirectory) {
  async function updateOrderYamlInDirectory(directoryPath) {
    const orderYamlPath = path.join(directoryPath, '_order.yaml');

    try {
      await fs.access(orderYamlPath);
    } catch {
      return; // nothing to update in this directory
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true });

    const items = entries
      .filter((entry) => {
        const name = entry.name;
        if (name === '_order.yaml') return false;
        if (name === '_log.csv') return false;
        if (name === 'migration-report.json') return false;
        if (name === '_images.csv') return false;
        if (name.toLowerCase() === 'index.md') return false;
        if (name.startsWith('.')) return false;
        if (name.startsWith('_')) return false;

        if (entry.isDirectory()) return true;
        if (entry.isFile() && path.extname(name).toLowerCase() === '.md') return true;
        return false;
      })
      .map((entry) => {
        const baseName = entry.isFile()
          ? path.basename(entry.name, path.extname(entry.name))
          : entry.name;
        const slug = baseName.toLowerCase().replace(/\s+/g, '-');
        return `- ${slug}`;
      })
      .sort((a, b) => a.localeCompare(b));

    const yamlList = items.join('\n') + (items.length ? '\n' : '');
    await fs.writeFile(orderYamlPath, yamlList, 'utf8');
    console.log(pc.blue(`Updated _order.yaml in ${directoryPath}`));
  }

  async function recurse(directoryPath) {
    await updateOrderYamlInDirectory(directoryPath);

    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        await recurse(path.join(directoryPath, entry.name));
      }
    }
  }

  await recurse(rootDirectory);
}
