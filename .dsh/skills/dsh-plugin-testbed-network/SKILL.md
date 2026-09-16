---
name: dsh-plugin-testbed-network
description: Use when running this repository's Docker Compose testbed locally or reproducing its GitHub Actions and CI environment.
---

# DSH Plugin Testbed Network

## Overview

Choose the network explicitly through the canonical launcher. Local testbed work uses `china`; GitHub Actions or CI reproduction uses `global`.

## Quick Reference

| Intent | Command |
| --- | --- |
| Local testbed | `node testbed/run.mjs --network china` |
| Reproduce GitHub Actions / CI | `node testbed/run.mjs --network global` |
| Validate China Compose | `node testbed/run.mjs --network china config` |
| Validate global Compose | `node testbed/run.mjs --network global config` |

Pass further Compose arguments after the network selection, for example:

```sh
node testbed/run.mjs --network china build testbed
```

## Rules

- When the request only says local testbed, select `china`.
- When it says CI, GitHub Actions, or CI reproduction, select `global`.
- Use `run.mjs`; do not guess a Compose file combination.
- Keep registry and proxy credentials out of commands, tracked env examples, logs, and reports. Put optional local proxy values only in an untracked `testbed/.env` or the process environment.
- Do not modify GitHub workflows to select a local network mode.

## Common Mistakes

| Mistake | Correction |
| --- | --- |
| Loading the China override for CI reproduction | Run with `--network global`. |
| Running a local testbed without choosing a network | Run with `--network china` (also the launcher's direct default). |
| Calling `docker compose` with guessed `-f` flags | Let `run.mjs` emit and execute the exact file list. |
| Saving proxy authentication in `.env.china.example` | Keep values only in ignored local configuration. |
