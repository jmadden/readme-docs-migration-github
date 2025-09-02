import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import pc from 'picocolors';

export async function findMarkdownFilesRecursive(
  root,
  { includeMdx = false } = {}
) {
  const out = [];
  async function walk(dir) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name === 'node_modules' || d.name.startsWith('.')) continue;
        await walk(p);
      } else if (d.isFile()) {
        const lower = p.toLowerCase();
        if (lower.endsWith('.md') || (includeMdx && lower.endsWith('.mdx')))
          out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

export async function ensureIndexesForCreatedDirs(root) {
  async function walk(dir) {
    const indexPath = path.join(dir, 'index.md');
    try {
      await fs.access(indexPath);
    } catch {
      const fm = {
        title: path.basename(dir),
        deprecated: false,
        hidden: false,
        metadata: { robots: 'index' },
      };
      const yamlStr = yaml.dump(fm, { lineWidth: 0 });
      await fs.writeFile(indexPath, `---\n${yamlStr}---\n`, 'utf8');
      console.log(pc.blue(`Created index.md in ${dir} (title: "${fm.title}")`));
    }
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      if (
        d.isDirectory() &&
        !d.name.startsWith('.') &&
        d.name !== 'node_modules'
      ) {
        await walk(path.join(dir, d.name));
      }
    }
  }
  await walk(root);
}

export async function updateAllOrderYamlIfPresent(root) {
  async function processDir(dir) {
    const orderPath = path.join(dir, '_order.yaml');
    try {
      await fs.access(orderPath);
    } catch {
      return;
    }
    const dirents = await fs.readdir(dir, { withFileTypes: true });

    const items = dirents
      .filter(d => {
        const name = d.name;
        if (name === '_order.yaml') return false;
        if (name === '_log.csv') return false;
        if (name === 'migration-report.json') return false;
        if (name === '_images.csv') return false;
        if (name.toLowerCase() === 'index.md') return false;
        if (name.startsWith('.')) return false;
        if (name.startsWith('_')) return false;
        if (d.isDirectory()) return true;
        if (d.isFile() && name.toLowerCase().endsWith('.md')) return true;
        return false;
      })
      .map(d => {
        let base = d.name;
        if (d.isFile()) base = base.replace(/\.[^.]+$/, '');
        const slug = base.toLowerCase().replace(/\s+/g, '-');
        return `- ${slug}`;
      })
      .sort((a, b) => a.localeCompare(b));

    const content = items.join('\n') + (items.length ? '\n' : '');
    await fs.writeFile(orderPath, content, 'utf8');
    console.log(pc.blue(`Updated _order.yaml in ${dir}`));
  }

  async function walk(dir) {
    await processDir(dir);
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      if (
        d.isDirectory() &&
        !d.name.startsWith('.') &&
        d.name !== 'node_modules'
      ) {
        await walk(path.join(dir, d.name));
      }
    }
  }
  await walk(root);
}
