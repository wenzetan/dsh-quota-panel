#!/usr/bin/env bash
# 用例：形状不对——name 行在，但没有 preceding `- id:` 列表项锚点，不构成一条插件行。
set -uo pipefail
printf "%s\n" \
	'插件清单（非组合树）：' \
	'  name: dsh-quota-panel'
