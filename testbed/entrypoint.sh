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
	local f d
	for f in settings.yaml .credentials.yaml pet.json; do
		[ -e "/host-dsh-home/$f" ] && cp -a "/host-dsh-home/$f" "$STATE/$f"
	done
	for d in skills storages; do
		[ -d "/host-dsh-home/$d" ] && cp -a "/host-dsh-home/$d" "$STATE/$d"
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

main() {
	if [ "${1:-}" = "--check-image" ]; then
		check_image
		return 0
	fi
	want assert && assert_readonly
	want seed && seed_home
	log done "所选步骤完成：STEPS=${STEPS}"
}

main "$@"
