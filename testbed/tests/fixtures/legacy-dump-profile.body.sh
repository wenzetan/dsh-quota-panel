# 由 legacy-dump-profile.sh / legacy-assert-row.body.sh 用 bash 执行：把"真实 entrypoint
# 的定义 + 所选历史实现"作为脚本文本打印到 stdout（entrypoint 的日志走 stderr，不污染文本）。
printf 'main () { :; }\n'
cat "$REAL_ENTRYPOINT"
cat <<'LEGACY'

# ↓↓↓ 与 5c95069（本次修复前）的 dump_profile 逐字等价：`2>&1` 混流 + 明文子串 grep
#     （/work/... 换成可覆盖路径，以便在宿主与新版读同一份输出）↓↓↓
dump_profile() {
	local dump="${DUMP_CONFIG_PATH:-/work/dump-config.txt}"
	set +e
	dsh --profile web --dump-config > "$dump" 2>&1
	local rc=$?
	set -e
	[ "$rc" -eq 0 ] || die "dsh --dump-config 失败，见 $dump"
	if grep -q "dsh-quota-panel" "$dump"; then
		:
	else
		die "组合树中没有 dsh-quota-panel 行（patch 层未生效）"
	fi
	log profile "装配断言通过：组合树包含 dsh-quota-panel"
}
LEGACY
printf 'main () { :; }\n'
