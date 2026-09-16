#!/usr/bin/env bash
# 用例：dsh --dump-config 正常退出（0）但 stdout 为空——空 dump 不得被当成通过。
set -uo pipefail
exit 0
