#!/usr/bin/env bash
# 用例：dsh 桩正常退出，但组合树里既没有本插件行、也没有任何诊断。
set -uo pipefail
printf "%s\n" \
	'- id: agent-presets' \
	"  name: '@deepseek-ai/dsh-agent-presets'" \
	'  config:' \
	'    default: standard'
