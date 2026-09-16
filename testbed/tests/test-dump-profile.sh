#!/usr/bin/env bash
# dump_profile 装配断言的对照测试：直接 source 真正安装的 entrypoint（不复制函数、
# 不另写一份 grep/predicate），用 dsh 桩喂入各种 dump 形态，断言 exit 码与日志分支。
#
# 覆盖：真实样本正例；注释头 / 相似包名 / 干净无行 / 形状不符 / stderr 诊断 /
#       伪造成 name 行的诊断 六种负例；dump 命令失败；dsh 正常退出但 stdout 为空。
#
# 用法 1（宿主，最快，不需要 Docker；本机需有 bash/awk/grep）：
#   testbed/tests/test-dump-profile.sh
# 用法 2（容器内，验证镜像里安装的那一份）：
#   docker compose run --rm --entrypoint bash testbed -lc \
#     'STEPS=none . /usr/local/bin/testbed-entrypoint; /usr/local/bin/testbed-test-dump-profile'
#   # 等价：STEPS=test docker compose run --rm --build testbed
set -uo pipefail

ENTRYPOINT="${ENTRYPOINT:-/usr/local/bin/testbed-entrypoint}"
# 本脚本在容器里是通过 /usr/local/bin/testbed-test-dump-profile 这个软链接调用的，
# 必须解析软链接才能找到同目录的 fixtures（BASH_SOURCE 给的是链接路径）。
SELF="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
	SELF="$(readlink -f "$SELF")"
fi
HERE="$(cd "$(dirname "$SELF")" && pwd)"
if [ ! -f "$ENTRYPOINT" ]; then
	ENTRYPOINT="$HERE/../entrypoint.sh"
fi
FIX="$HERE/fixtures"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dump-profile-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# 默认测"真正安装的 entrypoint"。`LEGACY_DUMP_PROFILE=1` 时改测 HEAD=5c95069 的旧
# dump_profile（红例对照，见 fixtures/legacy-dump-profile.sh），用来演示这套用例能红。
TARGET="$ENTRYPOINT"
if [ "${LEGACY_DUMP_PROFILE:-}" = "1" ]; then
	TARGET="$FIX/legacy-dump-profile.sh"
	export REAL_ENTRYPOINT="$ENTRYPOINT"
fi

echo "entrypoint: $ENTRYPOINT"
echo "fixtures:   $FIX"
echo "scratch:    $WORK"

PASS_COUNT=0
FAIL_COUNT=0

# 宿主 dump 规范（dsh 0.1.5-rc.1 实测）：插件行形如
#   `- id: quota-panel`
#   `  name: dsh-quota-panel`      <- name 恰好缩进 2 空格、裸值、行尾无内容
# 测试用同一锚点从 dump 里取"目标 name 行"，判绿/判红依据行本身而非任意子串。
dump_names() {
	awk '/^  name: / { print substr($0, 9) }' "$1"
}

# 桩 dsh：PATH 前置一个把调用转发给 $STUB 的同名 dsh。
# `</dev/null` 必须在这里：桩若从 stdin 读到本 harness 自己的源码，`grep -q` 会失败并
# 冒充"断言命中"以外的分支（实测：clean-no-target 曾因此落到"dsh --dump-config 失败"分支）。
setup_stub() {
	mkdir -p "$WORK/bin"
	{
		printf '#!/usr/bin/env bash\n'
		printf 'exec bash "$STUB" "$@" </dev/null\n'
	} >"$WORK/bin/dsh"
	chmod +x "$WORK/bin/dsh"
	export STUB
	export PATH="$WORK/bin:$PATH"
}

# run_case <名字> <桩 fixture> <期望 exit> <期望日志分支> [FIXTURE 值]
run_case() {
	local name="$1" stub="$2" expect_rc="$3" expect_line="$4" fixture="${5:-}" rc out
	# 参数错位要立刻炸：漏写 FIXTURE 位置参数时，expect_rc 会拿到一句中文，
	# 于是 `[ "$rc" != "$expect_rc" ]` 恒真却又"看起来在测"（实测踩过一次）。
	case "$expect_rc" in
		'' | *[!0-9]*) echo "    FATAL: run_case($name) 的 expect_rc 不是数字：'$expect_rc'（参数错位）"; exit 2 ;;
	esac
	[ -f "$stub" ] || { echo "    FATAL: run_case($name) 的桩不存在：$stub"; exit 2; }
	[ -z "$fixture" ] || [ -f "$fixture" ] \
		|| { echo "    FATAL: run_case($name) 的 FIXTURE 不存在：$fixture"; exit 2; }
	echo "--- case: ${name}（期望 exit=${expect_rc} / 分支：${expect_line}）---"
	# `</dev/null`：被测函数的子进程（桩 dsh）不得读到本 harness 继承的 stdin——
	# 否则桩会把本测试脚本自己的源码当成 dump 读掉（例如 `cat`/`grep -q` 在无文件参数时读 stdin）。
	STUB="$stub" FIXTURE="$fixture" STATE="$WORK/state" \
		DUMP_CONFIG_PATH="$WORK/$name.dump.txt" DUMP_STDERR_PATH="$WORK/$name.dump.stderr.txt" \
		DSH_VERSION=test GRID_LABEL=test PROFILE_MODE=minimal STEPS=none COMPANION= \
		bash -c '( . "$0"; dump_profile )' "$TARGET" </dev/null >"$WORK/$name.out" 2>&1
	rc=$?
	out="$(cat "$WORK/$name.out")"
	printf '%s\n' "$out" | sed 's/^/    | /'
	if [ "$rc" != "$expect_rc" ]; then
		echo "    FAIL: exit=${rc}，期望 ${expect_rc}"
		FAIL_COUNT=$((FAIL_COUNT + 1))
		return 1
	fi
	if ! printf '%s\n' "$out" | grep -qF "$expect_line"; then
		echo "    FAIL: 日志里没有期望分支：$expect_line"
		FAIL_COUNT=$((FAIL_COUNT + 1))
		return 1
	fi
	echo "    ok: exit=${rc}，命中分支：$expect_line"
	PASS_COUNT=$((PASS_COUNT + 1))
	return 0
}

setup_stub

# 正例前置自检：真实样本必须恰好只有 1 条目标 name 行（否则正例本身不可信）。
echo "--- case: real-sample 前置自检 ---"
echo "    样本 name 行共 $(dump_names "$FIX/real-dump-sample.txt" | wc -l) 条，其中 dsh-quota-panel 恰好 $(dump_names "$FIX/real-dump-sample.txt" | grep -cFx dsh-quota-panel) 条"
dump_names "$FIX/real-dump-sample.txt" | grep -Fx dsh-quota-panel | sed 's/^/    | 目标行: /'
if [ "$(dump_names "$FIX/real-dump-sample.txt" | grep -cFx dsh-quota-panel)" != 1 ]; then
	echo "    FATAL: 真实样本里 dsh-quota-panel 的 name 行不是恰好 1 条"
	exit 2
fi

run_case real-sample "$FIX/dsh-stub-emit.sh" 0 "装配断言通过" "$FIX/real-dump-sample.txt"
run_case comment-only "$FIX/dsh-stub-emit.sh" 1 "组合树中没有 dsh-quota-panel 行" "$FIX/comment-only-dump.txt"
run_case similar-name "$FIX/dsh-stub-emit.sh" 1 "组合树中没有 dsh-quota-panel 行" "$FIX/similar-name-dump.txt"
run_case clean-no-target "$FIX/dsh-stub-emit.sh" 1 "组合树中没有 dsh-quota-panel 行" "$FIX/clean-other-layers-dump.txt"
run_case malformed-row "$FIX/dsh-stub-malformed.sh" 1 "组合树中没有 dsh-quota-panel 行" ""
run_case stderr-warning "$FIX/dsh-stub-stderr-warning.sh" 1 "组合树中没有 dsh-quota-panel 行" ""
run_case name-on-stderr "$FIX/dsh-stub-name-on-stderr.sh" 1 "组合树中没有 dsh-quota-panel 行" ""
run_case dump-fails "$FIX/dsh-stub-fails.sh" 1 "dsh --dump-config 失败" ""
run_case empty-dump "$FIX/dsh-stub-empty.sh" 1 "组合树中没有 dsh-quota-panel 行" ""

echo
echo "dump_profile 对照测试：PASS=${PASS_COUNT} FAIL=${FAIL_COUNT}"
[ "$FAIL_COUNT" = 0 ] || exit 1
exit 0
