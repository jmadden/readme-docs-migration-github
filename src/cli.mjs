#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';

import { parseArgs } from './utils/args.mjs';
import { initLogs, finalizeReport } from './utils/logging.mjs';
import { runPipeline } from './pipeline.mjs';

const rawArgs = parseArgs(process.argv.slice(2));

if (!rawArgs.cwd) {
  console.error(pc.red('Error: --cwd is required (root directory to scan).'));
  process.exit(1);
}
process.chdir(path.resolve(rawArgs.cwd));
console.log(pc.gray(`cwd => ${process.cwd()}`));

const args = rawArgs;
for (const k of ['src', 'out']) {
  if (!args[k]) {
    console.error(pc.red(`Error: --${k} is required.`));
    process.exit(1);
  }
}

const SRC_ROOT = path.resolve(args.src);
const DEST_ROOT = path.resolve(args.out);
const COPY_ROOT = args.copy ? path.resolve(args.copy) : null;
const IMAGES_SRC = args['images-src'] ? path.resolve(args['images-src']) : null;
const MOVE_MAP_CSV = args['move-map'] ? path.resolve(args['move-map']) : null;
const INCLUDE_MDX = !!args['include-mdx'];
const UPLOAD_IMAGES = !!args['upload-images'];
const FLAT_OUTPUT = !!args['flat-output'];
const README_API_KEY = process.env.README_API_KEY || null;

// Ensure destination (and optional copy) roots exist
await fs.mkdir(DEST_ROOT, { recursive: true });
if (COPY_ROOT) await fs.mkdir(COPY_ROOT, { recursive: true });

// Build concrete log/report paths (strings!) and initialize the CSV header
const LOG_PATH = path.join(DEST_ROOT, '_log.csv');
await initLogs(LOG_PATH);

// Bundle a report object the pipeline can enrich
const report = {
  startedAt: new Date().toISOString(),
  cwd: process.cwd(),
  srcRoot: SRC_ROOT,
  destRoot: DEST_ROOT,
  copyRoot: COPY_ROOT,
  imagesSrc: IMAGES_SRC,
  uploadImages: UPLOAD_IMAGES,
  moveMapCsv: MOVE_MAP_CSV,
  files: [],
};

try {
  await runPipeline({
    cwd: process.cwd(),
    srcRoot: SRC_ROOT,
    destRoot: DEST_ROOT,
    includeMdx: INCLUDE_MDX,
    copyRoot: COPY_ROOT,
    imagesSrc: IMAGES_SRC,
    uploadImages: UPLOAD_IMAGES,
    readmeApiKey: README_API_KEY,
    moveMapCsv: MOVE_MAP_CSV,
    flatOutput: FLAT_OUTPUT,
  });
} catch (err) {
  console.error(pc.red('Pipeline failed:'), String(err && (err.stack || err.message || err)));
}

// Finalize report JSON (written under DEST_ROOT)
report.completedAt = new Date().toISOString();
await finalizeReport(DEST_ROOT, report);

console.log(pc.green('\nDone. See _log.csv and migration-report.json.'));
