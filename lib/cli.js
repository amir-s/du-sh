const { execFile } = require("node:child_process");
const { readdir } = require("node:fs/promises");
const path = require("node:path");
const { clearLine, cursorTo } = require("node:readline");
const { parseArgs, promisify, styleText } = require("node:util");
const bytes = require("bytes");
const { version } = require("../package.json");

const runFile = promisify(execFile);
const help = `Usage: dush [options] [directory]

List entries by disk usage, largest first. Defaults to the current directory.

Options:
  -a, --all      Include hidden entries
  -h, --help     Show this help
  -v, --version  Show the version
  --            End options (for directory names starting with "-")

Requires macOS or Linux with du on PATH. Set NO_COLOR to disable colors.
`;

function displayName(name) {
  if (!/[\u0000-\u001f\u007f-\u009f]/u.test(name)) return name;
  return JSON.stringify(name).replace(/[\u007f-\u009f]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

async function measure(directory, entry) {
  let stdout;
  try {
    // One operand per call: parse only the size, never the filename. The ./
    // prefix protects leading dashes without relying on platform-specific flags.
    ({ stdout } = await runFile("du", ["-s", "-k", `./${entry.name}`], {
      cwd: directory,
      env: { ...process.env, LC_ALL: "C" },
    }));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("cannot run du; ensure it is installed and available on PATH");
    }
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`cannot measure ${displayName(entry.name)}: ${detail}`);
  }

  const match = /^(\d+)[\t ]/.exec(stdout);
  const size = match ? Number(match[1]) * 1024 : NaN;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`invalid size from du for ${displayName(entry.name)}`);
  }
  return { name: entry.name, directory: entry.isDirectory(), size };
}

async function scan(directory, all) {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => all || !entry.name.startsWith(".")
  );
  const data = [];
  let next = 0;
  let failure;

  // Bound subprocesses and wait for active work before reporting a failure.
  await Promise.all(
    Array.from({ length: Math.min(8, entries.length) }, async () => {
      while (!failure && next < entries.length) {
        const entry = entries[next++];
        try {
          data.push(await measure(directory, entry));
        } catch (error) {
          failure ??= error;
        }
      }
    })
  );
  if (failure) throw failure;
  return data.sort((a, b) =>
    b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

function startSpinner(stdout, stderr) {
  if (!stdout.isTTY || !stderr.isTTY || process.env.TERM === "dumb") {
    return () => {};
  }
  const frames = ["|", "/", "-", "\\"];
  let frame = 0;
  const timer = setInterval(() => {
    clearLine(stderr, 0);
    cursorTo(stderr, 0);
    stderr.write(`${frames[frame++ % frames.length]} calculating ...`);
  }, 100);
  timer.unref();
  return () => {
    clearInterval(timer);
    if (frame > 0) {
      clearLine(stderr, 0);
      cursorTo(stderr, 0);
    }
  };
}

function print(data, stdout) {
  const rows = data.map((entry) => ({ ...entry, label: bytes(entry.size) }));
  const width = rows.reduce((max, entry) => Math.max(max, entry.label.length), 0);
  const color = (format, text) => {
    if (!stdout.isTTY || process.env.NO_COLOR !== undefined || process.env.TERM === "dumb") {
      return text;
    }
    return styleText(format, text, { stream: stdout });
  };
  for (const entry of rows) {
    const name = displayName(entry.name) + (entry.directory ? "/" : "");
    const padding = " ".repeat(width - entry.label.length);
    const label = color("green", entry.label);
    const filename = entry.directory ? color(["bold", "blue"], name) : name;
    stdout.write(`  ${padding}${label}  ${filename}\n`);
  }
}

async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: "boolean", short: "a" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return process.stdout.write(help);
  if (values.version) return console.log(version);
  if (positionals.length > 1) {
    throw new Error("expected at most one directory; see dush --help");
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("supported on macOS and Linux only");
  }

  const stopSpinner = startSpinner(process.stdout, process.stderr);
  let data;
  try {
    data = await scan(path.resolve(positionals[0] ?? "."), values.all);
  } finally {
    stopSpinner();
  }
  print(data, process.stdout);
}

module.exports = { main, print, startSpinner };
