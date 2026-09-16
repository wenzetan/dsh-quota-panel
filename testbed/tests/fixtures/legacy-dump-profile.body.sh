# 由 legacy-dump-profile.sh 用 bash 执行：把"真实 entrypoint 的定义 + 旧 dump_profile"
# 作为脚本文本打印到 stdout（entrypoint 的日志走 stderr，不会污染这份文本）。
printf 'main () { :; }\n'
cat "$REAL_ENTRYPOINT"
cat <<'LEGACY'

# ↓↓↓ 以下与 HEAD=5c95069 的旧实现逐字等价（/work/... 换成可覆盖路径以便宿主对照）↓↓↓
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
