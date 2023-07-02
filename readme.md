## DU-SH

This is just a cli utility to make my life easier. You can use it too if you want.
It is a simple wrapper around `du -sh` command. It will show you the list of files and directories in the current directory, but sorts them by size.

## Installation

```bash
$ npm install -g du-sh
```

This will add `dush` binary to your path. You can use it like this:

```bash
$ dush

  220KB  node_modules/
    4KB  bin/
    4KB  package-lock.json
    4KB  package.json
    4KB  readme.md

```
