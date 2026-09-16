# 由 legacy-assert-row.sh 用 bash 执行：真实 entrypoint 定义 + 初版（宽松）assert_plugin_row。
# 初版问题：name 用任意缩进匹配、每个顶层项不重置状态 ⇒ 其它插件 config 里的
# `    name: dsh-quota-panel` 会被误判成"插件行"。
printf 'main () { :; }\n'
cat "$REAL_ENTRYPOINT"
cat <<'LEGACY'

# ↓↓↓ 初版（3e3eef3 之前的工作副本）assert_plugin_row 逐字等价 ↓↓↓
assert_plugin_row() {
	awk -v want="$2" '
		function finish() { exit found ? 0 : 1 }
		/^-[[:space:]]+id:/ { last_id_line = NR; next }
		/^[[:space:]]*#/ { next }
		/^[[:space:]]*name:/ {
			if (last_id_line) {
				value = $0
				sub(/^[[:space:]]*name:[[:space:]]*/, "", value)
				sub(/[[:space:]]+$/, "", value)
				if (value == want) found = 1
			}
			next
		}
		END { finish() }
	' "$1"
}
LEGACY
printf 'main () { :; }\n'
