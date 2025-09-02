#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { parseArgs } from './utils/args.mjs';
import {
  ensureIndexesForCreatedDirs,
  updateAllOrderYamlIfPresent,
} from './utils/fileops.mjs';
import { initLogs, appendToLog, finalizeReport } from './utils/logging.mjs';
import { runPipeline } from './pipeline.mjs';
import { readMoveMapCsv } from './moveMap.mjs';

const rawArgs = parseArgs(process.argv.slice(2));
if (!rawArgs.cwd) {
  console.error(pc.red('Error: --cwd is required (root directory to scan).'));
  process.exit(1);
}
process.chdir(path.resolve(rawArgs.cwd));
console.log(pc.gray(`cwd => ${process.cwd()}`));

const args = rawArgs;
['src', 'out'].forEach(k => {
  if (!args[k]) {
    console.error(pc.red(`Error: --${k} is required.`));
    process.exit(1);
  }
});

const SRC_ROOT = path.resolve(args.src);
const DEST_ROOT = path.resolve(args.out);
const COPY_ROOT = args.copy ? path.resolve(args.copy) : null;

await fs.mkdir(DEST_ROOT, { recursive: true });
if (COPY_ROOT) await fs.mkdir(COPY_ROOT, { recursive: true });

const { LOG_PATH, REPORT_PATH, IMAGES_CSV_PATH, report } = await initLogs({
  destRoot: DEST_ROOT,
  cwd: process.cwd(),
  srcRoot: SRC_ROOT,
  destRootAbs: DEST_ROOT,
  copyRootAbs: COPY_ROOT,
});

let moveMap = null,
  moveDupes = new Set();
if (args['move-map']) {
  const mmPath = path.resolve(args['move-map']);
  ({ map: moveMap, dupes: moveDupes } = await readMoveMapCsv(
    mmPath,
    DEST_ROOT
  ));
  console.log(
    pc.gray(
      `Loaded move map: ${moveMap.size} entries, ${moveDupes.size} duplicate filename(s)`
    )
  );
}

const results = await runPipeline({
  args,
  srcRoot: SRC_ROOT,
  destRoot: DEST_ROOT,
  copyRoot: COPY_ROOT,
  logPath: LOG_PATH,
  imagesCsvPath: IMAGES_CSV_PATH,
  moveMap,
  moveDupes,
  report,
});

await ensureIndexesForCreatedDirs(DEST_ROOT);
await updateAllOrderYamlIfPresent(DEST_ROOT);
await finalizeReport(REPORT_PATH, report);

if (results.failed) {
  console.log(
    pc.red(`\nCompleted with ${results.failed} failure(s). See _log.csv.`)
  );
} else {
  console.log(pc.green('\nCompleted with no failures.'));
}
