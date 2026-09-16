#!/usr/bin/env bash
# 用例：诊断行恰好长成 `  name: dsh-quota-panel`（两空格缩进、精确包名），
# 但组合树里根本没有对应的插件行——精确锚点必须仍然判红。
set -uo pipefail
printf '  name: dsh-quota-panel\n' >&2
printf "%s\n" \
	'- id: agent-presets' \
	"  name: '@deepseek-ai/dsh-agent-presets'" \
	'  config:' \
	'    default: standard'
