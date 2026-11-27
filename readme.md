# DU-SH

List files and directories by disk usage, largest first. A small wrapper around
the system's `du` command.

## Installation

Requires Node.js 22.13+ and macOS or Linux with `du` on `PATH`.
Native Windows is unsupported; use Linux in WSL.

```sh
npm install -g du-sh
```

## Usage

```sh
dush                  # Current directory, excluding hidden entries
dush ~/Downloads      # Another directory
dush --all            # Include hidden files and directories
dush -- -backups      # A directory whose name starts with a dash
dush --help
dush --version
```

Example output:

```text
  220KB  node_modules/
    4KB  bin/
    4KB  package-lock.json
    4KB  package.json
    4KB  readme.md
```

`-a`, `-h`, and `-v` are aliases for `--all`, `--help`, and `--version`.
An empty directory produces no output. Unknown options, invalid directories,
and failed measurements report an error to stderr and exit with status 1.
Listings are printed only after all measurements succeed.

## Disk usage and output

- Sizes describe allocated disk usage reported by `du -s -k`, not file length.
  Sparse files, compression, and filesystem allocation affect the result.
- Sizes use powers of 1024, retaining the `KB`, `MB`, `GB`, and `TB` labels.
- Each immediate entry is measured independently, with up to eight `du` calls
  at once. Hard links shared between entries count in each entry; within an
  entry, the system's normal `du` hard-link accounting applies.
- Symbolic links are measured without following their targets. Directory
  sizes include hidden descendants even when `--all` is omitted.
- Names containing control characters are quoted and escaped, keeping each
  entry on one line. Directories have a trailing `/`.
- Redirected output contains no colors or spinner escape sequences. Colors
  appear only on terminals; set `NO_COLOR=1` to disable them. Progress uses
  stderr only when both stdout and stderr are terminals.

## Development

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

Tests use Node's built-in runner, temporary directories, native `du`, and a
controlled `du` fixture for large sizes and failure cases. CI runs checks,
tests, and package validation on macOS and Linux with Node 22, 24, and 26.

Releases use Release Please and Conventional Commits to update versions and
the changelog before publication to npm.

## License

MIT. See [LICENSE](LICENSE).
