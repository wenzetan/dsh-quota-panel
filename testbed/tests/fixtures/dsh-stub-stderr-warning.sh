#!/usr/bin/env bash
# 用例：dsh 自身诊断走 stderr 且含包名。旧实现用 `> /work/dump-config.txt 2>&1`
# 把诊断混进 dump，再对整份文本做明文 grep ⇒ 这里会假阳性 exit 0。
# 本用例的 dsh 桩把诊断写 stderr，把（不含插件行的）组合树写 stdout。
set -uo pipefail
printf 'warning: skipping dsh-quota-panel (adapter not installed)\n' >&2
printf "%s\n" \
	'- id: agent-presets' \
	"  name: '@deepseek-ai/dsh-agent-presets'" \
	'  config:' \
	'    default: standard'
