#!/usr/bin/env bash
# testbed entrypoint：在容器内构造隔离的 DSH_HOME，依次跑 L1（源码层）与 L2（真实宿主层）。
# 宿主侧只读挂载：/host-dsh-home（整份 $DSH_HOME）、/plugin-src（本仓库源码）、/companion-src（可选对端）。
set -euo pipefail

DSH_VERSION="${DSH_VERSION:?DSH_VERSION is required}"
GRID_LABEL="${GRID_LABEL:-local}"
PROFILE_MODE="${PROFILE_MODE:-minimal}"
COMPANION="${COMPANION:-}"
STEPS="${STEPS:-all}"
PLUGIN_CHECK_DEPS="${PLUGIN_CHECK_DEPS:-}"

STATE=/work/dsh-home
TARBALL=""
COMPANION_TARBALL=""
CRED_COUNT=0
PREFIX="[testbed][${DSH_VERSION}][${GRID_LABEL}]"

log() { printf '%s[%s] %s\n' "$PREFIX" "$1" "$2"; }
die() { log fail "$1"; exit 1; }

# want <step>：STEPS 为 all 或显式包含该步时返回 0
want() {
	case ",${STEPS}," in
		*,all,* | *,"$1",*) return 0 ;;
		*) return 1 ;;
	esac
}

check_image() {
	log image "node $(node -v) / npm $(npm -v)"
	log image "pnpm $(pnpm --version)"
	log image "dsh $(dsh --version)"
}

assert_readonly() {
	local m
	for m in /host-dsh-home /plugin-src; do
		[ -d "$m" ] || die "缺少只读挂载：$m"
		if touch "$m/.testbed-write-probe" 2>/dev/null; then
			rm -f "$m/.testbed-write-probe"
			die "$m 可写——拒绝运行（会污染宿主）。请确认 compose 使用 :ro 挂载"
		fi
	done
	log assert "宿主挂载确认为只读"
}

# 只复制配置类文件；会话/浏览器/账本数据一律不进容器。
seed_home() {
	rm -rf "$STATE"
	mkdir -p "$STATE"
	# 宿主目录本身必须可读且可搜索：否则下面每个白名单项的 `[ -e ]` / `[ -d ]`
	# 都为假而全部静默 continue，函数仍会打印"DSH_HOME 就绪"并 rc=0——下游拿到的
	# 是一份空 DSH_HOME 却显示成功（例如宿主目录 mode 0700 而 compose 设了 user:）。
	# 白名单项**缺席**仍不算错，只有"宿主目录不可用"才 die。
	[ -r /host-dsh-home ] && [ -x /host-dsh-home ] \
		|| die "播种失败：/host-dsh-home 不可读或不可搜索（挂载/权限有问题）"
	# 逐项显式失败关闭。实测（见 task-3-report §3.3a）：旧写法
	# `[ -e src ] && cp src dst` 在 cp 失败时其实是 rc=1——`set -e` 恰恰作用于
	# `&&` 列表的末位命令；但它只留下 cp 的裸报错，失败原因要靠读报错猜，且一旦
	# 该列表结构被改动（例如 cp 被挪进 `||` 分支或列表变长）就会退化为静默通过。
	# 显式 `|| die` 让失败路径与列表位置无关，并自带"是哪一项没复制成"的诊断。
	local f d
	for f in settings.yaml .credentials.yaml pet.json; do
		[ -e "/host-dsh-home/$f" ] || continue
		cp -a "/host-dsh-home/$f" "$STATE/$f" || die "播种失败：无法复制 $f"
	done
	for d in skills storages; do
		[ -d "/host-dsh-home/$d" ] || continue
		cp -a "/host-dsh-home/$d" "$STATE/$d" || die "播种失败：无法复制 $d/"
	done
	if [ -e "$STATE/.credentials.yaml" ]; then
		# 本仓库 CI 的 boot job 记录过这个门禁：credentials-local 拒绝 owner 之外
		# 可读的文件（默认 umask 给 644），权限过宽会让整棵插件树加载失败。
		chmod 600 "$STATE/.credentials.yaml"
		CRED_COUNT="$(grep -cE '^[A-Za-z0-9_]+:' "$STATE/.credentials.yaml" || true)"
		export CRED_COUNT
		log seed "凭据已播种（mode 600，引用数 ${CRED_COUNT:-0}）"
	fi
	log seed "DSH_HOME 就绪：$STATE"
}

# 复制源码时必须排除 node_modules（27 MB）、.tmp-*（本仓库的缓存/试验目录，实测约 136 MB）
# 与 .worktrees；刻意不复制 .git：因此产物新鲜度检查不能用 git diff，改用内容哈希。
stage_sources() {
	rm -rf /work/plugin
	mkdir -p /work/plugin
	tar -C /plugin-src \
		--exclude=./node_modules --exclude=./.git --exclude='./.tmp-*' --exclude=./.worktrees \
		-cf - . | tar -C /work/plugin -xf -
	[ -f /work/plugin/package.json ] || die "源码暂存失败：/work/plugin/package.json 不存在"
	log stage "源码已暂存：/work/plugin"
}

lib_digest() {
	find lib -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
}

run_l1() {
	cd /work/plugin
	log l1 "npm ci"
	npm ci --no-audit --no-fund
	local before after
	before="$(lib_digest)"
	log l1 "build（tsc → lib/ + vendored runtime 复制）"
	npm run build
	after="$(lib_digest)"
	if [ "$before" != "$after" ]; then
		die "lib/ 与全新构建不一致：产物过期，请在本地 npm run build 后提交重建的 lib/（等价于 CI 的 committed lib/ matches a fresh build）"
	fi
	log l1 "产物新鲜度：lib/ 内容哈希与全新构建一致"
	log l1 "双面脚本（Part A 宿主半边 + Part B 浏览器半边 vm 沙箱）"
	local out
	out="$(node scripts/test-page-script.mjs 2>&1)" || {
		printf '%s\n' "$out" | tail -40
		die "test-page-script.mjs 非零退出"
	}
	printf '%s\n' "$out" | tail -5
	if printf '%s\n' "$out" | grep -q '^FAIL:'; then
		printf '%s\n' "$out" | grep '^FAIL:' >&2
		die "双面脚本出现 FAIL 行"
	fi
	log l1 "全部通过"
}

# 可选：插件规范检查（需要 PLUGIN_CHECK_DEPS 指向含 dsh-plugin-check 的目录）
run_plugin_check() {
	[ -n "$PLUGIN_CHECK_DEPS" ] || { log l1 "跳过 plugin-check（未提供 PLUGIN_CHECK_DEPS）"; return 0; }
	cd /work/plugin
	log l1 "plugin-check（@deepseek-ai/dsh-plugin-check，strict）"
	node scripts/plugin-check.mjs
	log l1 "plugin-check 通过"
}

pack_plugin() {
	cd /work/plugin
	rm -rf /work/dist
	mkdir -p /work/dist
	npm pack --pack-destination /work/dist >/dev/null
	TARBALL="$(ls /work/dist/*.tgz | head -1)"
	[ -n "$TARBALL" ] || die "npm pack 未产出 tarball"
	export TARBALL
	log pack "已打包：$(basename "$TARBALL")"
}

# bundles 行决定 dsh 启动时装载哪些 bundle 层。CI 里这一步是手工补写的，
# 这里同样显式写入并打印，避免"装了但没注册"的假绿。
register_bundle_rows() {
	node -e '
		const fs = require("node:fs")
		const path = process.argv[1]
		const rows = process.argv.slice(2)
		const pkg = JSON.parse(fs.readFileSync(path, "utf8"))
		pkg.dsh ??= {}
		pkg.dsh.profile ??= {}
		pkg.dsh.profile.bundles ??= ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
		for (const row of rows) if (!pkg.dsh.profile.bundles.includes(row)) pkg.dsh.profile.bundles.push(row)
		fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n")
		console.log("bundles: " + pkg.dsh.profile.bundles.join(", "))
	' "$STATE/profiles/web/package.json" "$@"
}

build_profile() {
	case "$PROFILE_MODE" in
		minimal)
			log profile "PROFILE_MODE=minimal：空 profile + 安装本仓库 tarball"
			dsh plugin --profile web add "$TARBALL"
			;;
		preserve)
			die "PROFILE_MODE=preserve 尚未实现（见 Task 5）"
			;;
		*)
			die "未知 PROFILE_MODE：$PROFILE_MODE"
			;;
	esac
	[ -f "$STATE/profiles/web/package.json" ] || die "dsh plugin add 未生成 $STATE/profiles/web/package.json"
	register_bundle_rows dsh-quota-panel
}

# 从 `dsh --dump-config` 的 stdout 里精确判定"目标插件行"是否存在。
#
# 宿主 dump 规范（dsh 0.1.5-rc.1 对 --dump-config 的实测输出，见 tests/fixtures/real-dump-sample.txt）：
#   组合树是 YAML 列表，插件行形如
#     - id: quota-panel
#       name: dsh-quota-panel          <- name 恰好缩进 2 空格、裸值、行尾无内容
#   并在该层插入处带一行注释头 `# == <包名>`。注释头与 `name:` 值都可能只是别的层/
#   别的包的影子（base 层被 patch 时 section 头是 `# == <base>, patched by <plugin>`，
#   同名前缀的包也会有同样的 `- id:`/`name:` 行），因此只按"整份文本含子串"判绿会被
#   注释头、相似包名（dsh-quota-panel-companion）和 dsh 自身诊断骗过。
#
# 这里按行判定：先记住最近一个 `- id:` 列表项（"这是一行"的结构锚点），再要求随后的
# name 行与目标包名逐字相等。返回 0 命中 / 1 未命中（结构不符也归为未命中——本函数只
# 回答"这一行在不在"，dump 命令本身的失败由调用点单独判定）。
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

# 装配断言：组合树里必须出现本插件行。
#
# stderr 刻意单独落盘（不再 `2>&1`）：dsh 的 warning/进度都可能提到包名，混进 dump 后
# 会让下面的判定读到并不属于组合树的行。失败时两份文件都留给排查。
dump_profile() {
	local rc
	# 落盘路径可覆盖（默认就是容器里的 /work/dump-config.txt）：对照测试在宿主直接
	# source 本文件跑时，把 --dump-config 的输出写进临时目录，无需 Docker。
	local dump="${DUMP_CONFIG_PATH:-/work/dump-config.txt}"
	local dump_err="${DUMP_STDERR_PATH:-/work/dump-config.stderr.txt}"
	# dsh 的失败必须放在 if 条件里捕获：本脚本是 `set -euo pipefail`，
	# 裸的失败命令会在 `rc=$?` 之前就把 shell 收摊（表现为只有 [done]、没有 [fail] 报文）。
	if dsh --profile web --dump-config > "$dump" 2> "$dump_err"; then
		rc=0
	else
		rc=$?
	fi
	[ "$rc" -eq 0 ] \
		|| die "dsh --dump-config 失败（rc=$rc），见 $dump 与 $dump_err"
	# 同理：断言的非零返回是"判定结果"而不是脚本错误，必须由 if 捕获而不是让它触发 set -e。
	if assert_plugin_row "$dump" dsh-quota-panel; then
		:
	else
		die "组合树中没有 dsh-quota-panel 行（patch 层未生效）"
	fi
	log profile "装配断言通过：组合树包含 dsh-quota-panel"
}

# 可选：装卸配断言的对照测试（测试脚本与 fixture 由镜像打进 /usr/local/lib/testbed-tests，
# 它 source 的就是本 entrypoint，不会另写一份 grep）。
run_dump_profile_tests() {
	log test "dump_profile 对照测试（真实样本正例 + 注释/相似名/诊断/空/失败负例）"
	/usr/local/bin/testbed-test-dump-profile
	log test "对照测试全部通过"
}

main() {
	if [ "${1:-}" = "--check-image" ]; then
		check_image
		return 0
	fi
	want assert && assert_readonly
	want seed && seed_home
	want stage && stage_sources
	want l1 && run_l1
	want l1 && run_plugin_check
	want test && run_dump_profile_tests
	want pack && pack_plugin
	want profile && build_profile
	want profile && dump_profile
	log done "所选步骤完成：STEPS=${STEPS}"
}

main "$@"
