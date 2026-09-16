#!/usr/bin/env bash
# 红例对照入口 2/2：真实 entrypoint 定义 + **初版宽松** assert_plugin_row
# （name 任意缩进、不重置顶层项状态）。用来复现 name-in-other-config 的假阳性。
set -uo pipefail
eval "$(bash "$(dirname "${BASH_SOURCE[0]}")/legacy-assert-row.body.sh")"
