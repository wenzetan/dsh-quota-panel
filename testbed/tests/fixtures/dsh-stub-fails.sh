#!/usr/bin/env bash
# 用例：dsh --dump-config 自身失败（非零退出）。
set -uo pipefail
printf 'dsh: unknown profile "web"\n' >&2
exit 1
