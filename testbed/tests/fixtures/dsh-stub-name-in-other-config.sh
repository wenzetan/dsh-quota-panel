#!/usr/bin/env bash
# 用例：其它插件的 config 块里出现 `    name: dsh-quota-panel`（YAML 展平键值），
# 组合树里并没有本插件的行。初版 assert_plugin_row 用任意缩进匹配 name 且不重置
# 顶层项状态 ⇒ 会假阳性；收紧后必须判红。
set -uo pipefail
printf "%s\n" \
	'- id: other' \
	'  name: other' \
	'  config:' \
	'    name: dsh-quota-panel'
