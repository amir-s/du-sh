const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const bytes = require("bytes");
const { print, startSpinner } = require("../lib/cli");
const { version } = require("../package.json");

const cli = path.resolve(__dirname, "../bin/dush");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dush-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "work");
  const bin = path.join(root, "bin");
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin);
  return { root, cwd, bin };
}

function run(cwd, args = [], overrides = {}) {
  const env = { ...process.env, TERM: "dumb" };
  for (const key of ["FORCE_COLOR", "NO_COLOR", "NODE_DISABLE_COLORS"]) delete env[key];
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...env, ...overrides },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b/u);
  return result.stdout.trimEnd().split("\n").filter(Boolean).map((line) => {
    const match = /^\s*(\S+)  (.*)$/.exec(line);
    assert.ok(match, `invalid row: ${JSON.stringify(line)}`);
    return { size: match[1], name: match[2] };
  });
}

function fakeDu(bin, source) {
  fs.writeFileSync(path.join(bin, "du"), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  // Do not fall back to the system du if the fixture cannot execute.
  return { PATH: bin };
}

function terminal(isTTY) {
  let output = "";
  const stream = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  stream.isTTY = isTTY;
  stream.getColorDepth = () => 8;
  stream.output = () => output;
  return stream;
}

function terminalEnv(t, overrides = {}) {
  const values = { TERM: "xterm-256color", NO_COLOR: undefined, FORCE_COLOR: undefined, NODE_DISABLE_COLORS: undefined, ...overrides };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("native du: sorts allocated usage and marks directories", (t) => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, "small"), randomBytes(4096));
  fs.writeFileSync(path.join(cwd, "large"), randomBytes(256 * 1024));
  fs.writeFileSync(path.join(cwd, "empty"), "");
  fs.mkdirSync(path.join(cwd, "directory"));
  fs.writeFileSync(path.join(cwd, "directory", ".hidden-child"), randomBytes(8192));
  const rows = success(run(cwd));
  assert.equal(rows[0].name, "large");
  assert.equal(rows.at(-1).name, "empty");
  assert.ok(rows.some((row) => row.name === "directory/"));
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const output = execFileSync("du", ["-s", "-k", `./${row.name}`], { cwd, encoding: "utf8" });
    assert.equal(row.size, bytes(Number(output.match(/^\d+/)[0]) * 1024));
  }
});

test("empty directories succeed without output or du", (t) => {
  const { cwd, bin } = fixture(t);
  assert.deepEqual(success(run(cwd, [], { PATH: bin })), []);
});

test("hidden entries are opt-in with --all or -a", (t) => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, ".hidden"), "hidden");
  assert.deepEqual(success(run(cwd)), []);
  for (const flag of ["--all", "-a"]) {
    assert.deepEqual(success(run(cwd, [flag])).map((row) => row.name), [".hidden"]);
  }
});

test("native du: leading dashes, whitespace, shell characters, and Unicode", (t) => {
  const { cwd } = fixture(t);
  const names = ["-z", "--help", "two words", "$(touch INJECTED)", "quote'\";*?", "café-你好"];
  for (const name of names) fs.writeFileSync(path.join(cwd, name), "sample");
  assert.deepEqual(success(run(cwd)).map((row) => row.name).sort(), names.sort());
  assert.equal(fs.existsSync(path.join(cwd, "INJECTED")), false);
});

test("native du: control characters in names are escaped onto one line", (t) => {
  const { cwd } = fixture(t);
  const names = ["tab\tname", "line\nname", "carriage\rreturn", "escape\u001b[31m", "delete\u007f", "control\u009b"];
  for (const name of names) fs.writeFileSync(path.join(cwd, name), "sample");
  const rows = success(run(cwd));
  assert.equal(rows.length, names.length);
  assert.deepEqual(rows.map((row) => JSON.parse(row.name)).sort(), names.sort());
  for (const row of rows) assert.doesNotMatch(row.name, /[\u0000-\u001f\u007f-\u009f]/u);
});

test("directory arguments work relative to cwd, absolutely, and after --", (t) => {
  const { cwd } = fixture(t);
  const target = path.join(cwd, "-target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "inside"), "sample");
  for (const args of [["./-target"], [target], ["--", "-target"]]) {
    assert.deepEqual(success(run(cwd, args)).map((row) => row.name), ["inside"]);
  }
});

test("help and version work without du", (t) => {
  const { cwd, bin } = fixture(t);
  fs.writeFileSync(path.join(cwd, "file"), "sample");
  for (const flag of ["--help", "-h"]) {
    const result = run(cwd, [flag], { PATH: bin });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Usage: dush/);
    assert.match(result.stdout, /--all/);
  }
  for (const flag of ["--version", "-v"]) {
    const result = run(cwd, [flag], { PATH: bin });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${version}\n`);
  }
});

test("unknown options and extra directory arguments fail clearly", (t) => {
  const { cwd } = fixture(t);
  for (const args of [["--unknown"], ["one", "two"], ["--all=yes"]]) {
    const result = run(cwd, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^dush: /);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});

test("missing directories and file operands fail clearly", (t) => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, "file"), "sample");
  for (const target of ["missing", "file"]) {
    const result = run(cwd, [target]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^dush: /);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});

test("missing du reports a useful error and exits unsuccessfully", (t) => {
  const { cwd, bin } = fixture(t);
  fs.writeFileSync(path.join(cwd, "file"), "sample");
  const result = run(cwd, [], { PATH: bin });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot run du.*PATH/);
});

test("du failures preserve diagnostics and suppress partial listings", (t) => {
  const { cwd, bin } = fixture(t);
  fs.writeFileSync(path.join(cwd, "file"), "sample");
  const env = fakeDu(bin, `
process.stdout.write("4\\t./file\\n");
process.stderr.write("du: permission denied\\n");
process.exitCode = 2;
`);
  const result = run(cwd, [], env);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot measure file: du: permission denied/);
});

test("native du: unreadable entries fail", { skip: process.getuid?.() === 0 }, (t) => {
  const { cwd } = fixture(t);
  const blocked = path.join(cwd, "blocked");
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, "file"), "sample");
  fs.chmodSync(blocked, 0);
  let result;
  try {
    result = run(cwd);
  } finally {
    fs.chmodSync(blocked, 0o700);
  }
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot measure blocked/);
});

test("sizes at and above 2 TiB stay positive and sort correctly", (t) => {
  const { cwd, bin } = fixture(t);
  for (const name of ["two", "four", "small"]) fs.writeFileSync(path.join(cwd, name), "");
  const env = fakeDu(bin, `
const sizes = { "./two": "2147483648", "./four": "4294967296", "./small": "4" };
process.stdout.write(sizes[process.argv[4]] + "\\tignored filename\\n");
`);
  assert.deepEqual(success(run(cwd, [], env)), [
    { size: "4TB", name: "four" },
    { size: "2TB", name: "two" },
    { size: "4KB", name: "small" },
  ]);
});

test("invalid or unsafe du sizes fail rather than showing misleading data", (t) => {
  const { cwd, bin } = fixture(t);
  fs.writeFileSync(path.join(cwd, "file"), "");
  for (const output of ["", "garbage\n", "-1\tfile\n", "9007199254740992\tfile\n"]) {
    const env = fakeDu(bin, `process.stdout.write(${JSON.stringify(output)});`);
    const result = run(cwd, [], env);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /invalid size from du/);
  }
});

test("more than eight entries complete with bounded parallelism and stable ties", (t) => {
  const { root, cwd, bin } = fixture(t);
  const log = path.join(root, "calls");
  const names = Array.from({ length: 18 }, (_, index) => `file-${String(index).padStart(2, "0")}`);
  for (const name of names) fs.writeFileSync(path.join(cwd, name), "");
  const env = fakeDu(bin, `
const fs = require("node:fs");
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, "start " + process.pid + "\\n");
setTimeout(() => {
  process.stdout.write("4\\tignored\\n");
  fs.appendFileSync(log, "end " + process.pid + "\\n");
}, 100);
`);
  assert.deepEqual(success(run(cwd, [], env)).map((row) => row.name), names);
  const active = new Set();
  let maximum = 0;
  for (const line of fs.readFileSync(log, "utf8").trim().split("\n")) {
    const [event, pid] = line.split(" ");
    if (event === "start") active.add(pid);
    else active.delete(pid);
    maximum = Math.max(maximum, active.size);
  }
  assert.equal(active.size, 0);
  assert.ok(maximum > 1 && maximum <= 8, `maximum parallel processes: ${maximum}`);
});

test("native du: hard-linked entries both appear with independent sizes", (t) => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, "original"), randomBytes(8192));
  fs.linkSync(path.join(cwd, "original"), path.join(cwd, "linked"));
  const rows = success(run(cwd));
  assert.deepEqual(rows.map((row) => row.name), ["linked", "original"]);
  assert.equal(rows[0].size, rows[1].size);
  assert.notEqual(rows[0].size, "0B");
});

test("native du: directory and broken symlinks are not followed or marked as directories", (t) => {
  const { root, cwd } = fixture(t);
  const target = path.join(root, "target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "large"), randomBytes(256 * 1024));
  fs.symlinkSync(target, path.join(cwd, "link"));
  fs.symlinkSync(path.join(root, "missing"), path.join(cwd, "broken"));
  const rows = success(run(cwd));
  assert.deepEqual(rows.map((row) => row.name).sort(), ["broken", "link"]);
  for (const row of rows) assert.ok(bytes.parse(row.size) < 256 * 1024);
});

test("piped output stays plain even when colors are forced", (t) => {
  const { cwd } = fixture(t);
  fs.mkdirSync(path.join(cwd, "directory"));
  for (const env of [{}, { FORCE_COLOR: "1" }, { NO_COLOR: "1" }]) {
    assert.equal(success(run(cwd, [], env))[0].name, "directory/");
  }
});

test("terminal output uses color and aligns sizes", (t) => {
  terminalEnv(t);
  const stdout = terminal(true);
  print([
    { name: "large", size: 102400, directory: false },
    { name: "small", size: 4096, directory: true },
  ], stdout);
  assert.match(stdout.output(), /\u001b\[/u);
  const plain = stdout.output().replace(/\u001b\[[\d;]*m/gu, "");
  assert.equal(plain, "  100KB  large\n    4KB  small/\n");
});

test("NO_COLOR disables terminal color, including an empty value", async (t) => {
  for (const value of ["1", ""]) {
    await t.test(`NO_COLOR=${JSON.stringify(value)}`, (t) => {
      terminalEnv(t, { NO_COLOR: value });
      const stdout = terminal(true);
      print([{ name: "directory", size: 4096, directory: true }], stdout);
      assert.equal(stdout.output(), "  4KB  directory/\n");
    });
  }
});

test("spinner stays off if either output is redirected", async (t) => {
  terminalEnv(t);
  for (const [outTTY, errTTY] of [[false, false], [true, false], [false, true]]) {
    const stdout = terminal(outTTY);
    const stderr = terminal(errTTY);
    const stop = startSpinner(stdout, stderr);
    await delay(120);
    stop();
    assert.equal(stdout.output(), "");
    assert.equal(stderr.output(), "");
  }
});

test("spinner writes only to terminal stderr and stops cleanly", async (t) => {
  terminalEnv(t);
  const stdout = terminal(true);
  const stderr = terminal(true);
  const stop = startSpinner(stdout, stderr);
  t.after(stop);
  await delay(150);
  stop();
  assert.equal(stdout.output(), "");
  assert.match(stderr.output(), /calculating/);
  assert.ok(stderr.output().endsWith("\u001b[2K\u001b[1G"));
  const stopped = stderr.output();
  await delay(150);
  assert.equal(stderr.output(), stopped);
});

test("dumb terminals have neither color nor spinner output", async (t) => {
  terminalEnv(t, { TERM: "dumb" });
  const stdout = terminal(true);
  const stderr = terminal(true);
  const stop = startSpinner(stdout, stderr);
  await delay(120);
  stop();
  print([{ name: "file", size: 4096, directory: false }], stdout);
  assert.equal(stdout.output(), "  4KB  file\n");
  assert.equal(stderr.output(), "");
});
