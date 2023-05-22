// @ts-check
"use strict";
/**
 * @typedef {import("./runSuite.test").WorkerData} WorkerData
 * @typedef {import("node:fs").Dirent} Dirent
 * */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { cpus } from "node:os";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

/**
 * Split {@linkcode items} into {@linkcode n} arrays, distributing leftover
 * elements among the initial arrays.
 *
 * @template T
 * @param items {T[]} List of items to split into list of lists
 * @param n {number} Number of lists to split into
 */
function splitInto(items, n) {
  const partLength = Math.floor(items.length / n);
  const res = Array(n)
    .fill(null)
    .map((_, i) => items.slice(i * partLength, (i + 1) * partLength));
  for (let i = partLength * n; i < items.length; i++) {
    res[i - partLength * n].push(items[i]);
  }
  return res;
}

const outFolder = "out";

const testRoot = process.cwd();

/** @type {(Record<"root" | "files", string> & { name?: string })[]} */
const config = JSON.parse(readFileSync("suites.json").toString());

if (!existsSync("in")) mkdirSync("in");
if (!existsSync(outFolder)) mkdirSync(outFolder);

const fullOutFolder = `${testRoot}/${outFolder}`;

/** @type {WorkerData["tests"]} */
let tests = [];

if (!process.argv.includes("--skipConfig") || !existsSync("in/all.in")) {
  for (const { files, root, name } of config) {
    // @ts-ignore
    const configName = name ?? root.replaceAll("/", "-");
    process.chdir(root);
    const cwd = process.cwd();
    const d = opendirSync(files);
    /** @type {Dirent | null} */
    let next;
    let shouldCopyToCoqProject = true;
    let hasMake = false;
    while ((next = d.readSync())) {
      if (next.name === "_CoqProject") shouldCopyToCoqProject = false;
      if (next.name === "Make") hasMake = true;
      if (!next.name.endsWith(".v")) {
        continue;
      }

      const file = files + "/" + next.name;
      const displayName = configName + "-" + next.name;

      tests.push({
        cwd,
        displayName,
        file,
        name: next.name,
      });
    }
    d.closeSync();
    if (shouldCopyToCoqProject && hasMake) copyFileSync("Make", "_CoqProject");
    process.chdir(testRoot);
  }
}
if (existsSync("in/all.in")) {
  tests = JSON.parse(readFileSync("in/all.in").toString()).tests;
}

const workerCount = Math.min(Math.floor((cpus().length - 1) / 2), tests.length);
// const workerCount = 3;
const sorter = ({ name: nameA }, { name: nameB }) =>
  nameA === "IndProp.v" ? -1 : nameB === "IndProp.v" ? 1 : 0;
process.chdir("vscode");
const splitTests = splitInto(tests, workerCount);
for (let i = 0; i < workerCount; i++) {
  /** @type {WorkerData} */
  splitTests[i].sort(sorter);
  const data = { fullOutFolder, tests: splitTests[i] };

  const workerDetailsFile = `../in/${i}.in`;
  // if (!existsSync(workerDetailsFile))
  writeFileSync(workerDetailsFile, JSON.stringify(data));

  const worker = spawn(
    "./scripts/test.sh",
    [
      "--run",
      "src/vs/editor/contrib/suggest/test/browser/runSuite.test.ts",
      "--timeout",
      "1000000000",
    ],
    {
      env: { ...process.env, TEST_WORKER_ID: i.toString() },
      stdio: ["ignore", "inherit", "inherit"],
    }
  );
  worker.on("close", console.log);
  // worker.send(data);
  // TODO: Create a testing thing
}
