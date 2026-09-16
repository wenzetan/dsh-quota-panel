# Docker Compose 测试环境（testbed）实施计划 — dsh-quota-panel

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本仓库新增自包含的 `testbed/`，用 Docker Compose 在容器内跑通源码层（L1）与真实宿主启动层（L2）校验，支持多宿主版本与插件组合，且宿主环境零改动。

**Architecture:** 单个 `node:24-bookworm-slim` 镜像（`ARG DSH_VERSION` 决定容器内 dsh 版本）+ 单 service compose 模板（全部行为由环境变量驱动）+ 六步 entrypoint（只读断言 → 播种 `$DSH_HOME` → 暂存源码 → 构造 profile → L1 → L2）+ 一个矩阵脚本遍历"宿主版本 × 插件组合"。宿主的 `$DSH_HOME` 与仓库源码都以**只读**方式挂载进容器，一切写入落在容器可写层与命名卷。

**Tech Stack:** Docker / Docker Compose v2、Node.js 24、pnpm（`dsh plugin` 转发目标）、bash、Node 内建模块（`matrix.mjs` 不引入任何依赖）。

**Spec:** `docs/superpowers/specs/2026-09-15-docker-compose-testbed-design.md`

## Global Constraints

- 基础镜像固定 `node:24-bookworm-slim`（与 CI 的 node 24 对齐）；镜像内安装 `pnpm` 与 `@deepseek-ai/dsh@${DSH_VERSION}`。
- 新增文件只位于 `testbed/`，另在 `.gitignore` 追加一行 `testbed/.out/`；**不改动**现有 CI 任务、`package.json`、`src/` 与 `scripts/`。
- 宿主 `$DSH_HOME`（默认 `/root/.dsh`）与仓库源码（`..`）一律**只读**挂载；entrypoint 必须在启动时断言两者不可写，否则立即失败退出。
- 容器端口映射固定为 `127.0.0.1:${HOST_PORT:-13080}:3080`——宿主 `3080` 正被 GUI 占用，绝不占用。
- 默认值：`DSH_VERSION=0.1.5-rc.1`（= npm 的 `latest`，也是本机宿主正在运行的版本）、`PROFILE_MODE=minimal`、`HOST_PORT=13080`、`GRID_LABEL=local`、`STEPS=all`。
- 产物流水：`testbed/.out/<version>-<combo>.log`；日志前缀 `[testbed][<version>][<combo>][<step>]`。
- 退出码：单格 0 = 全绿 / 非零 = 失败；矩阵 0 = 全部格绿 / 1 = 存在失败格。
- 本插件保持**零运行时依赖**：`package.json` 的 `dependencies` 不新增（当前为空）；`peerDependencies` 不变。
- 宿主侧 `docker` 的状态目录 `/root/.docker` 在开发沙箱下只读：所有宿主侧 `docker compose` 调用必须在 `testbed/` 目录内使用仓库内的可写配置目录（`export DOCKER_CONFIG="$PWD/.docker-config"`）。该目录**不得**存放任何凭据文件，且必须被 `.gitignore` 忽略。
- 基础镜像获取：当 daemon 的 registry mirror 不可用或 `docker.io` 直连超时时，允许从可信镜像站预取后**按原名打本地标签**（`Dockerfile` 的 `FROM` 始终保持官方名），并在 README 记录来源与 digest；不得把第三方镜像站写进 `FROM`。
- 本轮不做浏览器 E2E（`scripts/verify.mjs` 的 CDP 路线仍是 Windows 开发机上的手工工具）、不做真实上游调用（**不运行 `fetch-all`**，不消耗任何配额）、不接 CI。
- 注释、README、提交信息使用中文说明 + 英文技术标识（与本仓库双语文档传统一致）。

## File Structure

| 文件 | 职责 |
| --- | --- |
| `testbed/Dockerfile` | 构建带 node 24 + pnpm + 指定版本 dsh 的镜像；`ARG DSH_VERSION`/`ARG NPM_REGISTRY` |
| `testbed/compose.yaml` | 单 service 模板：镜像构建、环境变量、只读挂载、命名卷、端口、host-gateway |
| `testbed/entrypoint.sh` | 六步流程；支持 `STEPS` 分步执行与 `--check-image` 自检 |
| `testbed/probes/boot-probe.sh` | L2 探针：认证、首页、boot 图、`specs` 通道、日志卫生 |
| `testbed/probes/rpc-specs.mjs` | 从 `lib/index.js` 的导出动态取得 `specs` 的路径与方法（端点改名不会让探针恒绿） |
| `testbed/probes/preserve-seed.mjs` | `preserve` 模式：从宿主 profile 读出 `dsh.profile.bundles` 行 |
| `testbed/matrix.mjs` | 版本/组合解析、逐格执行、宿主零改动快照、汇总表 |
| `testbed/.empty/.gitkeep` | 未提供 `COMPANION_HOST_DIR` 时的占位只读挂载点 |
| `testbed/.env.example` | 宿主侧变量示例（Linux / Windows 各一段） |
| `testbed/README.md`、`testbed/README.zh.md` | 双语用法与排查 |
| `.gitignore` | 追加 `testbed/.out/` |

**任务依赖**：Task 1 → 2 → 3 → 4 → {5, 6} → 7 → 8 → 9。Task 5 与 Task 6 可互换顺序，但都必须在 Task 4 之后。

---

### Task 1: 镜像骨架与 compose service

**Files:**
- Create: `testbed/Dockerfile`
- Create: `testbed/compose.yaml`
- Create: `testbed/.empty/.gitkeep`
- Create: `testbed/.env.example`
- Create: `testbed/entrypoint.sh`（仅自检分支，后续任务扩展）

**Interfaces:**
- Consumes: 无
- Produces: 镜像自检入口 `entrypoint.sh --check-image`（打印 node/pnpm/dsh 版本）；compose service 名 `testbed`；环境变量契约 `DSH_VERSION` / `PROFILE_MODE` / `COMPANION` / `COMPANION_HOST_DIR` / `DSH_HOME_HOST` / `HOST_PORT` / `GRID_LABEL` / `STEPS`

- [ ] **Step 1: 写 `testbed/Dockerfile`**

```dockerfile
# testbed 镜像：node 24（与 CI 一致）+ pnpm（dsh plugin 转发 pnpm）+ 指定版本的 dsh。
# 刻意不写 `# syntax=docker/dockerfile:1`：本文件只用标准 Dockerfile 语法，而该行会让每次构建
# 都去 registry 解析一次 frontend 镜像——在本机（mirror 不可用）实测每次要等 60 秒超时。
# NPM_REGISTRY 可覆盖：CI 的 boot job 曾因 registry 的 stale-packument（EINTEGRITY）
# 改用 https://registry.npmmirror.com，这里保留同一个逃生口。
FROM node:24-bookworm-slim

ARG DSH_VERSION=0.1.5-rc.1
ARG NPM_REGISTRY=https://registry.npmjs.org

ENV DSH_VERSION=${DSH_VERSION} \
    DSH_HOME=/work/dsh-home \
    DEBIAN_FRONTEND=noninteractive

# curl 供探针使用；ca-certificates 供 HTTPS；git 供 pnpm 解析 git 依赖。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund --registry="${NPM_REGISTRY}" \
      pnpm "@deepseek-ai/dsh@${DSH_VERSION}" \
 && dsh --version \
 && pnpm --version

WORKDIR /work
COPY entrypoint.sh /usr/local/bin/testbed-entrypoint
RUN chmod +x /usr/local/bin/testbed-entrypoint

ENTRYPOINT ["/usr/local/bin/testbed-entrypoint"]
```

- [ ] **Step 2: 写 `testbed/compose.yaml`**

```yaml
# testbed：单 service 模板。宿主 $DSH_HOME 与仓库源码都只读挂载；写入只落在
# 容器可写层与命名卷。宿主 3080 被 GUI 占用，这里固定映射到 13080 起。
name: dsh-testbed-quota-panel

services:
  testbed:
    build:
      context: .
      args:
        DSH_VERSION: "${DSH_VERSION:-0.1.5-rc.1}"
        NPM_REGISTRY: "${NPM_REGISTRY:-https://registry.npmjs.org}"
    image: "dsh-testbed-quota-panel:${DSH_VERSION:-0.1.5-rc.1}"
    environment:
      DSH_VERSION: "${DSH_VERSION:-0.1.5-rc.1}"
      PROFILE_MODE: "${PROFILE_MODE:-minimal}"
      COMPANION: "${COMPANION:-}"
      GRID_LABEL: "${GRID_LABEL:-local}"
      STEPS: "${STEPS:-all}"
      PLUGIN_CHECK_DEPS: "${PLUGIN_CHECK_DEPS:-}"
    volumes:
      - "${DSH_HOME_HOST:-/root/.dsh}:/host-dsh-home:ro"
      - "..:/plugin-src:ro"
      - "${COMPANION_HOST_DIR:-./.empty}:/companion-src:ro"
      - "npm-cache:/root/.npm"
      - "pnpm-store:/root/.local/share/pnpm/store"
    ports:
      - "127.0.0.1:${HOST_PORT:-13080}:3080"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    working_dir: /work

volumes:
  npm-cache:
  pnpm-store:
```

- [ ] **Step 3: 写 `testbed/.empty/.gitkeep`（空文件）与 `testbed/.env.example`**

```dotenv
# testbed 宿主侧变量示例。复制为 testbed/.env 后按需修改；不要提交 .env。
#
# Linux / macOS：
DSH_HOME_HOST=/root/.dsh
# Windows（Docker Desktop）：
# DSH_HOME_HOST=C:/Users/<you>/.dsh
#
# 互不相同的宿主端口（GUI 占用 3080，故从 13080 起）：
HOST_PORT=13080
# 镜像源：遇到 @deepseek-ai/* 的 EINTEGRITY 时改用镜像
# NPM_REGISTRY=https://registry.npmmirror.com
# 可选：提供含 @deepseek-ai/dsh-plugin-check 的目录时追加插件规范检查
# PLUGIN_CHECK_DEPS=/deps
```

- [ ] **Step 4: 写 `testbed/entrypoint.sh` 骨架（本任务只实现自检分支）**

```bash
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

main() {
	if [ "${1:-}" = "--check-image" ]; then
		check_image
		return 0
	fi
	die "entrypoint 尚未实现完整流程（见后续任务）"
}

main "$@"
```

- [ ] **Step 5: 构建并自检镜像**

Run:
```bash
cd testbed && docker compose run --rm --build testbed --check-image
```
Expected: 三行 `[testbed][0.1.5-rc.1][local][image] …`，分别打印 node 版本（v24.x）、pnpm 版本、dsh 版本；退出码 0。

- [ ] **Step 6: 验证版本参数真的生效（反例）**

Run:
```bash
cd testbed && DSH_VERSION=0.1.5-rc.2 docker compose run --rm --build testbed --check-image
```
Expected: 第四行打印的 dsh 版本为 `0.1.5-rc.2`（而非默认的 `0.1.5-rc.1`）——证明 `ARG`/`image` 标签与运行时版本联动。

- [ ] **Step 7: 提交**

```bash
git add testbed/Dockerfile testbed/compose.yaml testbed/.empty/.gitkeep testbed/.env.example testbed/entrypoint.sh
git commit -m "test(testbed): 容器镜像骨架与 compose 单 service 模板"
```

---

### Task 2: 只读断言与 DSH_HOME 播种

**Files:**
- Modify: `testbed/entrypoint.sh`（新增 `assert_readonly`、`seed_home`，接入 `STEPS`）
- Create: `testbed/.gitignore`（忽略 `.out/`、`.env`、`.docker-config/`）
- Create: `testbed/.docker-config/.gitkeep`（宿主侧 docker CLI 的可写状态目录；**不含任何凭据文件**）

**Interfaces:**
- Consumes: Task 1 的 `PREFIX` / `log` / `die` / `want` / `check_image`
- Produces: 容器内可用的 `$STATE`（`/work/dsh-home`）与函数 `assert_readonly`、`seed_home`

- [ ] **Step 1: 记录基线（当前骨架对"可写挂载"毫无反应）**

Run:
```bash
cd testbed && docker build -t dsh-testbed-quota-panel:0.1.5-rc.1 .
docker run --rm \
  -v /root/.dsh:/host-dsh-home:ro \
  -v "$PWD/.empty:/plugin-src:rw" \
  -e DSH_VERSION=0.1.5-rc.1 \
  dsh-testbed-quota-panel:0.1.5-rc.1
```
Expected: 此刻 entrypoint 只有自检分支，无参数时 `die`（退出码非 0）且**与挂载可写无关**——记下这一点：实现断言之前，可写挂载不会被拒绝。

> 为什么不用 `docker compose run -v` 来构造可写挂载：Compose v5.3.1 下 `run -v` 与 service 中同 target 的 `:ro` 卷合并时 service 定义胜出，反例会得到 exit 0 的**假绿**（已实测）。

- [ ] **Step 2: 实现 `assert_readonly` 与 `seed_home`**

把 `testbed/entrypoint.sh` 的 `check_image` 之后插入以下两个函数，并替换 `main`：

```bash
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
```

同时把 `CRED_COUNT=0` 加入文件顶部变量区。

- [ ] **Step 3: 验证正常路径**

Run:
```bash
cd testbed && STEPS=assert,seed docker compose run --rm --build testbed
```
Expected:
```
[testbed][0.1.5-rc.1][local][assert] 宿主挂载确认为只读
[testbed][0.1.5-rc.1][local][seed] 凭据已播种（mode 600，引用数 N）
[testbed][0.1.5-rc.1][local][seed] DSH_HOME 就绪：/work/dsh-home
[testbed][0.1.5-rc.1][local][done] 所选步骤完成：STEPS=assert,seed
```
退出码 0。若宿主没有 `.credentials.yaml`，则跳过凭据那行——此时 L2 的 `specs` 探针仍可运行（本插件的 `specs` 是离线语义），但 catalog 行数会是 0。

- [ ] **Step 4: 验证反例——可写挂载必须被拒绝**

Run:
```bash
cd testbed && docker run --rm \
  -v /root/.dsh:/host-dsh-home:ro \
  -v "$PWD/.empty:/plugin-src:rw" \
  -e DSH_VERSION=0.1.5-rc.1 \
  dsh-testbed-quota-panel:0.1.5-rc.1; echo "exit=$?"
```
Expected: 输出 `…[fail] /plugin-src 可写——拒绝运行（会污染宿主）。请确认 compose 使用 :ro 挂载`，`exit=1`。（必须用裸 `docker run`：`docker compose run -v` 无法覆盖 service 里同 target 的 `:ro`。）

- [ ] **Step 5: 验证宿主配置文件确实没被改**

Run:
```bash
find /root/.dsh -maxdepth 1 -newermt '-2 minutes' -not -name '.*' -not -path '/root/.dsh/sessions*' -not -path '/root/.dsh/storages*' -not -path '/root/.dsh/change-ledger*'
```
Expected: 无输出（`settings.yaml`、`profiles/`、`.credentials.yaml` 的时间戳都没变）。

- [ ] **Step 5b: 创建宿主侧 docker 配置目录与 `testbed/.gitignore`**

写 `testbed/.gitignore`：

```gitignore
# testbed 运行产物与本地配置
.out/
.env
# 忽略 docker CLI 状态目录内容，但保留占位文件（否则同一步无法提交它）
.docker-config/*
!.docker-config/.gitkeep
```

并创建 `testbed/.docker-config/.gitkeep`（0 字节）。该目录只为让 docker CLI 有一个**可写**状态目录（本会话下 `/root/.docker` 只读）；**不得**把 `~/.docker/config.json` 或任何含凭据的文件复制进来。

验证（同时验证该目录可用）：

```bash
cd testbed && export DOCKER_CONFIG="$PWD/.docker-config" && docker compose run --rm --build testbed --check-image
```
Expected: 三行 `[testbed][…][local][image] …`，退出码 0。

- [ ] **Step 6: 提交**

```bash
git add testbed/entrypoint.sh testbed/.gitignore testbed/.docker-config/.gitkeep
git commit -m "test(testbed): 只读断言、DSH_HOME 播种与宿主 docker 配置目录"
```

---

### Task 3: 源码暂存与 L1（构建、产物新鲜度、双面脚本）

**Files:**
- Modify: `testbed/entrypoint.sh`（新增 `stage_sources`、`lib_digest`、`run_l1`）

**Interfaces:**
- Consumes: Task 2 的 `STATE` / `seed_home`
- Produces: `/work/plugin`（源码副本，不含 `node_modules` / `.git` / `.tmp-*` / `.worktrees`）；函数 `stage_sources`、`lib_digest`、`run_l1`

- [ ] **Step 1: 新增函数并接入 `main`**

在 `testbed/entrypoint.sh` 的 `seed_home` 之后插入：

```bash
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
```

并把 `main` 改为：

```bash
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
	log done "所选步骤完成：STEPS=${STEPS}"
}

main "$@"
```

- [ ] **Step 2: 运行 L1（首次会下载依赖，约数分钟）**

Run:
```bash
cd testbed && STEPS=assert,seed,stage,l1 docker compose run --rm --build testbed
```
Expected: 出现 `[l1] 产物新鲜度：lib/ 内容哈希与全新构建一致`、双面脚本末行 `PASS: …`、`[l1] 全部通过`；退出码 0。

- [ ] **Step 3: 验证产物新鲜度能红（反例）**

Run:
```bash
printf '\n// testbed freshness probe\n' >> lib/index.js
cd testbed && STEPS=assert,seed,stage,l1 docker compose run --rm --build testbed; echo "exit=$?"
cd .. && git checkout -- lib/index.js
```
Expected: 输出 `…[fail] lib/ 与全新构建不一致：产物过期…`，`exit=1`；`git checkout` 还原后重跑 Step 2 回到全绿。（源码副本由宿主目录复制而来，宿主的临时改动会被带进容器——这正是该断言要抓的情形。）

- [ ] **Step 4: 验证双面脚本的判红通道有效（反例）**

Run:
```bash
cd testbed && STEPS=assert,seed,stage,l1 docker compose run --rm --build --entrypoint bash testbed -lc '
  set -e
  STEPS=assert,seed,stage /usr/local/bin/testbed-entrypoint >/dev/null
  cd /work/plugin
  npm ci --no-audit --no-fund >/dev/null 2>&1
  printf "\nconsole.log(\"FAIL: injected probe\")\n" >> scripts/test-page-script.mjs
  STEPS=l1 /usr/local/bin/testbed-entrypoint
'; echo "exit=$?"
```
Expected: `exit=1`，尾部打印 `FAIL: injected probe`——证明 `FAIL:` 行确实会让该层判红。

- [ ] **Step 5: 提交**

```bash
git add testbed/entrypoint.sh
git commit -m "test(testbed): 源码暂存与 L1（构建/产物新鲜度/双面脚本/可选 plugin-check）"
```

---

### Task 4: profile 构造（minimal）与装配断言

**Files:**
- Modify: `testbed/entrypoint.sh`（新增 `pack_plugin`、`register_bundle_rows`、`build_profile`、`dump_profile`）

**Interfaces:**
- Consumes: Task 3 的 `/work/plugin`
- Produces: `/work/dist/*.tgz`；容器内 `$STATE/profiles/web`；函数 `build_profile`、`dump_profile`

- [ ] **Step 1: 新增函数并接入 `main`**

在 `run_plugin_check` 之后插入：

```bash
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

# 装配断言：组合树里必须出现本插件行。
dump_profile() {
	dsh --profile web --dump-config > /work/dump-config.txt 2>&1 \
		|| die "dsh --dump-config 失败，见 /work/dump-config.txt"
	grep -q "dsh-quota-panel" /work/dump-config.txt \
		|| die "组合树中没有 dsh-quota-panel 行（patch 层未生效）"
	log profile "装配断言通过：组合树包含 dsh-quota-panel"
}
```

并把 `main` 改为：

```bash
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
	want pack && pack_plugin
	want profile && build_profile
	want profile && dump_profile
	log done "所选步骤完成：STEPS=${STEPS}"
}

main "$@"
```

- [ ] **Step 2: 运行到装配断言**

Run:
```bash
cd testbed && STEPS=assert,seed,stage,l1,pack,profile docker compose run --rm --build testbed
```
Expected:
```
… [pack] 已打包：dsh-quota-panel-0.9.2-rc.3.tgz
… bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-quota-panel
… [profile] 装配断言通过：组合树包含 dsh-quota-panel
```
退出码 0。

- [ ] **Step 3: 验证装配断言能红（反例）**

**不能**用"删掉 `register_bundle_rows` 调用"来做这个对照：`dsh plugin --profile web add` 在本宿主版本上**自己**就会把包名写进 `dsh.profile.bundles`，所以删掉该调用后装配断言依然绿（`register_bundle_rows` 只是幂等兜底 + 打印）。有效的变异点是**装完之后把 profile 里的那一行剥掉**：

```bash
cd testbed && docker compose run --rm --build --entrypoint bash testbed -lc '
  set -e
  STEPS=assert,seed,stage,l1,pack,profile /usr/local/bin/testbed-entrypoint >/dev/null
  node -e "
    const fs = require(\"node:fs\")
    const p = process.env.DSH_HOME + \"/profiles/web/package.json\"
    const pkg = JSON.parse(fs.readFileSync(p, \"utf8\"))
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((r) => r !== \"dsh-quota-panel\")
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + \"\\n\")
    console.log(\"mutated bundles:\", pkg.dsh.profile.bundles.join(\", \"))
  "
  STEPS=none . /usr/local/bin/testbed-entrypoint
  dump_profile
'; echo "exit=$?"
```
Expected: 先打印 `mutated bundles: …`（不含 `dsh-quota-panel`），随后以 `[fail] 组合树中没有 dsh-quota-panel 行（patch 层未生效）` 结束、`exit=1` —— 失败落在 `dump_profile` 的 grep 分支，证明 bundles 行正是"组合树出现该插件行"的因。

（`STEPS=none` 让 entrypoint 只定义函数、不执行任何步骤，因此可以在同一个容器里直接调用 `dump_profile`。`set -e` 保证变异未生效时会立刻暴露，而不是悄悄走到断言。）
- [ ] **Step 4: 提交**

```bash
git add testbed/entrypoint.sh
git commit -m "test(testbed): minimal profile 构造、npm pack 与装配断言"
```

---

### Task 5: `preserve` 模式实测（spec 第 10 节的风险收敛）

**Files:**
- Create: `testbed/probes/preserve-seed.mjs`
- Modify: `testbed/entrypoint.sh`（实现 `build_profile` 的 `preserve` 分支）

**Interfaces:**
- Consumes: Task 4 的 `TARBALL` / `register_bundle_rows`
- Produces: `preserve-seed.mjs`（stdout 每行一个宿主 profile 的 bundle 行，已剔除 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与 `dsh-quota-panel` 自身）

- [ ] **Step 1: 写 `testbed/probes/preserve-seed.mjs`**

```js
// 读出宿主 web profile 的 bundle 行，供 preserve 模式在容器内重建同一组合。
// 用法：node /usr/local/bin/probes/preserve-seed.mjs <宿主的 profiles/web/package.json>
import { readFileSync } from 'node:fs'

const [, , manifestPath] = process.argv
const SELF = 'dsh-quota-panel'
const BASE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
const rows = pkg?.dsh?.profile?.bundles ?? []
for (const row of rows) {
	if (BASE.includes(row) || row === SELF) continue
	console.log(row)
}
```

- [ ] **Step 2: 实现 `preserve` 分支**

把 `testbed/entrypoint.sh` 里 `build_profile` 的 `preserve` 分支替换为：

```bash
		preserve)
			log profile "PROFILE_MODE=preserve：先还原宿主 profile 的 bundle 行"
			local host_manifest=/host-dsh-home/profiles/web/package.json
			[ -f "$host_manifest" ] || die "preserve 需要宿主 profile：$host_manifest 不存在"
			local rows row
			rows="$(node /usr/local/bin/probes/preserve-seed.mjs "$host_manifest" || true)"
			if [ -n "$rows" ]; then
				while IFS= read -r row; do
					[ -n "$row" ] || continue
					log profile "还原第三方行：$row"
					dsh plugin --profile web add "$row" || log profile "警告：还原 $row 失败（依赖网络或上游包）"
				done <<< "$rows"
			fi
			log profile "安装本仓库 tarball（覆盖发行版行）"
			dsh plugin --profile web add "$TARBALL"
			;;
```

同时把探针目录带进镜像——`probes/` 到这一步才存在，因此 `COPY probes` 不能放在 Task 1：

```dockerfile
COPY probes /usr/local/bin/probes
```

`boot-probe.sh` 由 entrypoint 用 `bash` 显式调用，不需要可执行位，因此这里不设 `chmod`。

- [ ] **Step 3: 实测 preserve 是否会因 npm/pnpm 布局混用而失败**

Run:
```bash
cd testbed && STEPS=assert,seed,stage,l1,pack,profile \
  PROFILE_MODE=preserve DSH_VERSION=0.1.5-rc.1 docker compose run --rm --build testbed
```
Expected（两种结果都必须被记录下来，二选一）：
- **成功**：出现 `bundles: …` 与 `[profile] 装配断言通过`，退出码 0 → 在 Task 9 的 `README.zh.md` 里把 `preserve` 记为可用模式。
- **失败**：在 Task 9 的 `README.zh.md` "已知限制"里写明失败原文（命令、错误行、宿主 profile 布局），并把失败当作**结论**而非待办——默认仍是 `minimal`。

- [ ] **Step 4: 提交**

```bash
git add testbed/probes/preserve-seed.mjs testbed/entrypoint.sh
git commit -m "test(testbed): preserve 模式实现与实测（记录 npm/pnpm 混用结论）"
```

---

### Task 6: L2 探针与阴性对照 A（RPC 通道）

**Files:**
- Create: `testbed/probes/rpc-specs.mjs`
- Create: `testbed/probes/boot-probe.sh`
- Modify: `testbed/entrypoint.sh`（新增 `run_l2`）

**Interfaces:**
- Consumes: Task 4 的 profile；`$STATE`
- Produces: `run_l2`；`/work/rpc-specs.json`（`specs` 的真实路径与方法）；`/work/dsh-web.log`

- [ ] **Step 1: 写 `testbed/probes/rpc-specs.mjs`**

```js
// 从插件自身的导出取 specs 的路径与方法，避免探针里硬编码端点名：
// 端点一旦改名，硬编码的探针会打到 SPA 回退上而"看起来正常"，这是恒绿风险。
// 用法：node /usr/local/bin/probes/rpc-specs.mjs /work/plugin > /work/rpc-specs.json
const pluginDir = process.argv[2]
const m = await import(`file://${pluginDir}/lib/index.js`)
const route = m.rpcRoutePath('specs')
const method = m.rpcMethod('specs')
if (typeof route !== 'string' || typeof method !== 'string') {
	throw new Error('插件未导出 rpcRoutePath/rpcMethod，无法动态取得 specs 端点')
}
console.log(JSON.stringify({ route, method, endpoints: m.RPC_ENDPOINTS ?? [] }))
```

> 注意：`specs` 的真实访问路径自带 `/api` 前缀（本仓库 CI 的 boot job 打的是 `/api/dsh-quota-panel/specs`），因此脚本**不能**自己拼 `/dsh-quota-panel/specs`。

- [ ] **Step 2: 写 `testbed/probes/boot-probe.sh`**

```bash
#!/usr/bin/env bash
# L2 探针：真实 dsh web 启动 + 浏览器会话 + 首页 + boot 图 + specs 通道 + 日志卫生。
# 认证流程与本仓库 CI 的 boot job 一致：一次性 token 换会话 cookie（0.1.5 起强制）。
set -euo pipefail

PORT="${PORT:-3080}"
LOG="${LOG:-/work/dsh-web.log}"
COOKIE="${COOKIE:-/work/cookies.txt}"
BODY=/work/specs-body.json
SPECS=/work/rpc-specs.json
TAG="[testbed][${DSH_VERSION}][${GRID_LABEL}][l2]"

say() { printf '%s %s\n' "$TAG" "$1"; }
die() { printf '%s [fail] %s\n' "$TAG" "$1"; [ -f "$LOG" ] && tail -40 "$LOG"; exit 1; }

# 0) 动态取得 specs 端点（必须、且必须与插件导出一致）
node /usr/local/bin/probes/rpc-specs.mjs /work/plugin > "$SPECS" || die "无法取得 specs 端点导出"
ROUTE="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync("/work/rpc-specs.json","utf8")).route)')"
METHOD="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync("/work/rpc-specs.json","utf8")).method)')"
say "specs 端点：${ROUTE}（method ${METHOD}）"

rm -f "$COOKIE"
dsh web > "$LOG" 2>&1 &
WEB_PID=$!
trap 'kill "$WEB_PID" 2>/dev/null || true' EXIT

# 1) 等 token → 会话 cookie
code=""
for _ in $(seq 1 90); do
	kill -0 "$WEB_PID" 2>/dev/null || die "dsh web 启动过程中退出"
	token="$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | head -1 | cut -d= -f2 || true)"
	if [ -n "$token" ]; then
		curl -s -c "$COOKIE" -b "$COOKIE" -o /dev/null "http://127.0.0.1:${PORT}/?token=${token}" || true
		if [ -s "$COOKIE" ]; then
			code="$(curl -s -b "$COOKIE" -o /work/index.html -w '%{http_code}' "http://127.0.0.1:${PORT}/" || true)"
			[ "$code" = "200" ] && break
		fi
	fi
	sleep 1
done
[ "$code" = "200" ] || die "首页未就绪（最后 HTTP ${code:-none}）"
say "认证与会话建立完成，首页 200"

# 2) 浏览器半边进入 boot 图
grep -q 'dsh-quota-panel/client.js' /work/index.html \
	|| die "boot 图中缺少 dsh-quota-panel/client.js 引用"
say "boot 图包含客户端 bundle"

# 3) specs 通道真实应答（payload 用 null，与本仓库 CI 一致）
rpc_code="$(curl -s -b "$COOKIE" -o "$BODY" -w '%{http_code}' -X POST \
	"http://127.0.0.1:${PORT}${ROUTE}" \
	-H 'content-type: application/json' \
	-d "{\"type\":\"client-request\",\"rpcId\":\"testbed-probe\",\"method\":\"${METHOD}\",\"payload\":null}" || true)"
case "$rpc_code" in
	200) ;;
	405) die "RPC 端点 ${ROUTE} 缺失（405 = SPA 回退，路由未注册）" ;;
	401 | 403) die "RPC 端点 ${ROUTE} 被 /api 围栏拒绝（HTTP $rpc_code）" ;;
	*) die "specs RPC 应答 HTTP $rpc_code" ;;
esac

# 4) 响应语义：ok 信封 + rows 数组 + 工作区 patch 的 refreshMs + 不泄漏凭据/端点
node -e '
	const fs = require("node:fs")
	const raw = fs.readFileSync(process.argv[1], "utf8")
	const body = JSON.parse(raw)
	if (body.type !== "server-response" || body.rpcId !== "testbed-probe") throw new Error("信封不符：" + raw.slice(0, 200))
	const value = body.result?.value
	if (body.result?.ok !== true) throw new Error("ok 不为 true：" + raw.slice(0, 200))
	if (!Array.isArray(value?.rows)) throw new Error("value.rows 不是数组：" + raw.slice(0, 200))
	// refreshMs 来自本仓库 cordis.patch.yml 的 quota-panel 行：这个值证明生效的是
	// 工作区源码的 patch，而不是宿主 profile 里残留的发行版行。
	if (value.refreshMs !== 60000) throw new Error("refreshMs 不是工作区 patch 的 60000：" + String(value.refreshMs))
	if (/sk-|https?:\/\//.test(raw)) throw new Error("specs 响应泄漏了凭据或端点：" + raw.slice(0, 200))
	console.log("specs rows=" + value.rows.length + " refreshMs=" + value.refreshMs + "（行数为 diagnostic，不断言具体数量）")
' "$BODY" || die "specs 响应校验失败"
say "specs 应答语义正确（ok 信封 + rows + refreshMs=60000 + 无凭据泄漏）"

# 5) 日志卫生：本仓库历史事故的形态
if grep -qE 'plugin tree failed to load|without inject' "$LOG"; then
	die "日志出现插件加载失败特征"
fi
say "日志卫生通过"
say "L2 全部通过"
```

- [ ] **Step 3: 在 `entrypoint.sh` 里接入 `run_l2`**

在 `dump_profile` 之后插入：

```bash
run_l2() {
	log l2 "启动真实 dsh web 并执行探针"
	bash /usr/local/bin/probes/boot-probe.sh || die "L2 探针失败，日志：/work/dsh-web.log"
}
```

并把 `main` 的步骤序列末尾改为：

```bash
	want l2 && run_l2
	log done "所选步骤完成：STEPS=${STEPS}"
```

- [ ] **Step 4: 跑通 L2**

Run:
```bash
cd testbed && docker compose run --rm --build testbed; echo "exit=$?"
```
Expected: 依次出现 `specs 端点：/api/dsh-quota-panel/specs（method dsh-quota-panel/specs）`、`认证与会话建立完成，首页 200`、`boot 图包含客户端 bundle`、`specs rows=N refreshMs=60000（行数为 diagnostic，不断言具体数量）`、`日志卫生通过`、`L2 全部通过`、`exit=0`。

- [ ] **Step 5: 阴性对照 A——通道未注册必须变红**

Run:
```bash
cd testbed && docker compose run --rm --build --entrypoint bash testbed -lc '
  set -e
  STEPS=assert,seed,stage,l1,pack,profile /usr/local/bin/testbed-entrypoint
  target="$(readlink -f "$DSH_HOME/profiles/web/node_modules/dsh-quota-panel/lib/index.js")"
  echo "破坏目标：$target"
  grep -q "connection\.fetch(" "$target" || { echo "阴性对照无效：目标里没有 connection.fetch("; exit 2; }
  sed -i "s/connection\.fetch(/connection.__disabled_fetch(/g" "$target"
  grep -q "__disabled_fetch" "$target" || { echo "阴性对照无效：替换未生效"; exit 2; }
  STEPS=l2 /usr/local/bin/testbed-entrypoint
'; echo "exit=$?"
```
Expected: 末尾失败行为 `[l2] RPC 端点 /api/dsh-quota-panel/specs 缺失（405 = SPA 回退，路由未注册）`，整体 `exit=1`——复现 405 形态，证明该断言不是恒绿。若打印 `阴性对照无效：…` 且 `exit=2`，说明破坏点没选对（源码里实际的注册调用名不同），此时按实际名字调整 `grep`/`sed` 模式后重跑，**不能把"没红"当成通过**。

破坏必须落在**已安装进 profile 的副本**（`$DSH_HOME/profiles/web/node_modules/…`）上，而不是 `/work/plugin`：L2 启动的是 profile 里由 tarball 安装的那份代码，改 `/work/plugin` 不会影响它。`readlink -f` 用来解析 pnpm 的符号链接，避免 `sed -i` 把链接本身替换掉。

- [ ] **Step 6: 提交**

```bash
git add testbed/probes/rpc-specs.mjs testbed/probes/boot-probe.sh testbed/entrypoint.sh
git commit -m "test(testbed): L2 启动探针（认证/首页/boot 图/specs/日志卫生）+ 405 阴性对照"
```

---

### Task 7: 组合格与阴性对照 B（浏览器半边）

**Files:**
- Modify: `testbed/entrypoint.sh`（`COMPANION` 支持）
- Modify: `testbed/probes/boot-probe.sh`（组合断言）

**Interfaces:**
- Consumes: Task 6 的探针
- Produces: `COMPANION` 生效路径：`/work/companion` 源码副本 + 装入 profile 的对端 tarball

- [ ] **Step 1: 在 `entrypoint.sh` 里支持对端**

把 `stage_sources` 的末尾追加：

```bash
	if [ -n "$COMPANION" ]; then
		[ -f /companion-src/package.json ] || die "COMPANION=$COMPANION 但 /companion-src 不是插件源码（检查 COMPANION_HOST_DIR）"
		rm -rf /work/companion
		mkdir -p /work/companion
		# 与 self 相反：对端的 prepack 就是构建（tsc），因此必须保留它的 node_modules；
		# 排除掉会让 npm pack 报 `tsc: not found`（实测 exit 127）。
		tar -C /companion-src \
			--exclude=./.git --exclude='./.tmp-*' \
			-cf - . | tar -C /work/companion -xf -
		[ -x /work/companion/node_modules/.bin/tsc ] || die "对端缺少 node_modules/.bin/tsc：暂存对端时必须保留其 node_modules（对端的 prepack 会构建）"
		log stage "对端源码已暂存：/work/companion（$COMPANION）"
	fi
```

在 `pack_plugin` 之后追加：

```bash
pack_companion() {
	[ -n "$COMPANION" ] || return 0
	cd /work/companion
	log pack "打包对端：$COMPANION"
	npm pack --pack-destination /work/dist >/dev/null
	COMPANION_TARBALL="$(ls -t /work/dist/*.tgz | head -1)"
	[ -n "$COMPANION_TARBALL" ] || die "对端 npm pack 未产出 tarball"
	export COMPANION_TARBALL
}
```

在 `build_profile` 的两种模式里，于安装本仓库 tarball **之后**追加（`register_bundle_rows` 已接受任意个包名参数）：

```bash
	if [ -n "$COMPANION" ]; then
		log profile "安装对端：$COMPANION"
		dsh plugin --profile web add "$COMPANION_TARBALL"
		register_bundle_rows "$COMPANION"
	fi
```

同时把 `main` 里 `pack_plugin` 之后加一行：

```bash
	want pack && pack_companion
```

- [ ] **Step 2: 在 `boot-probe.sh` 里追加组合断言**

在"日志卫生"之前插入：

```bash
# 组合格：两个客户端 bundle 必须同时进入 boot 图，两个 RPC 通道都必须应答且不串扰。
if [ -n "${COMPANION:-}" ]; then
	grep -q "dsh-quota-panel/client.js" /work/index.html || die "组合格缺少 dsh-quota-panel 客户端 bundle"
	grep -q "${COMPANION}/client.js" /work/index.html || die "组合格缺少 ${COMPANION} 客户端 bundle"
	say "组合格：两个客户端 bundle 均在 boot 图中"

	c1="$(curl -s -b "$COOKIE" -o /work/c1.json -w '%{http_code}' -X POST \
		"http://127.0.0.1:${PORT}${ROUTE}" -H 'content-type: application/json' \
		-d "{\"type\":\"client-request\",\"rpcId\":\"combo-self\",\"method\":\"${METHOD}\",\"payload\":null}" || true)"
	[ "$c1" = "200" ] || die "组合格：specs 通道非 200（HTTP $c1）"

	c2="$(curl -s -b "$COOKIE" -o /work/c2.json -w '%{http_code}' -X POST \
		"http://127.0.0.1:${PORT}/llm-newapi/ci-probe" -H 'content-type: application/json' \
		-d '{"type":"client-request","rpcId":"combo-peer","method":"ci-probe","payload":{}}' || true)"
	[ "$c2" = "200" ] || die "组合格：/llm-newapi 通道非 200（HTTP $c2）"

	node -e '
		const fs = require("node:fs")
		const self = JSON.parse(fs.readFileSync("/work/c1.json", "utf8"))
		const peer = JSON.parse(fs.readFileSync("/work/c2.json", "utf8"))
		if (self.rpcId !== "combo-self") throw new Error("自身通道返回了别的响应：" + JSON.stringify(self).slice(0, 200))
		if (peer.rpcId !== "combo-peer") throw new Error("对端通道返回了别的响应：" + JSON.stringify(peer).slice(0, 200))
		if (peer.result?.ok !== false || !String(peer.result?.error?.message ?? "").includes("unknown endpoint ci-probe")) {
			throw new Error("对端 unknown-endpoint 语义不符：" + JSON.stringify(peer).slice(0, 200))
		}
	' || die "组合格：通道响应串扰或对端语义不符"
	say "组合格：两个 RPC 通道各自应答，无覆盖"
fi
```

- [ ] **Step 3: 跑通组合格**

Run:
```bash
cd testbed && COMPANION=dsh-llm-newapi COMPANION_HOST_DIR="$PWD/../../dsh-llm-newapi" \
  GRID_LABEL=self+newapi docker compose run --rm --build testbed; echo "exit=$?"
```
Expected: 出现 `组合格：两个客户端 bundle 均在 boot 图中`、`组合格：两个 RPC 通道各自应答，无覆盖`、`L2 全部通过`、`exit=0`。

- [ ] **Step 4: 阴性对照 B——破坏客户端入口必须变红**

Run:
```bash
cd testbed && docker compose run --rm --build --entrypoint bash testbed -lc '
  set -e
  STEPS=assert,seed,stage,l1,pack,profile /usr/local/bin/testbed-entrypoint
  target="$(readlink -f "$DSH_HOME/profiles/web/node_modules/dsh-quota-panel/lib/client.js")"
  echo "破坏目标：$target"
  [ -f "$target" ] || { echo "阴性对照无效：profile 里没有 client.js"; exit 2; }
  mv "$target" "$target.disabled"
  STEPS=l2 /usr/local/bin/testbed-entrypoint
'; echo "exit=$?"
```
Expected: `exit=1`，失败行为 `[l2] boot 图中缺少 dsh-quota-panel/client.js 引用`。与对照 A 同理：破坏的是 **profile 内已安装的副本**（`readlink -f` 解析 pnpm 符号链接），而不是 `/work/plugin`；若打印 `阴性对照无效：…` 与 `exit=2`，说明破坏点没选对。

- [ ] **Step 5: 提交**

```bash
git add testbed/entrypoint.sh testbed/probes/boot-probe.sh
git commit -m "test(testbed): 组合格（COMPANION 叠加）与浏览器半边阴性对照"
```

---

### Task 8: 矩阵脚本（版本解析、遍历、宿主零改动快照、汇总）

**Files:**
- Create: `testbed/matrix.mjs`

**Interfaces:**
- Consumes: 全部前置任务的可运行 compose service
- Produces: `node testbed/matrix.mjs [--versions a,b] [--combos self,self+companion] [--jobs N] [--no-check-host]`；退出码 0 = 全部格绿 / 1 = 存在失败格

- [ ] **Step 1: 写 `testbed/matrix.mjs`**

```js
// 矩阵编排：解析宿主版本集合（默认 latest + next 去重）与组合，逐格执行单 service，
// 期间对宿主 $DSH_HOME 做白名单快照，结束时打印汇总表。只用 Node 内建模块。
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const outDir = join(here, '.out')
const dockerConfig = join(here, '.docker-config')
mkdirSync(dockerConfig, { recursive: true })
const DEFAULT_PORT = 13080

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
	const i = argv.indexOf(name)
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const combos = argOf('--combos', 'self').split(',').map((s) => s.trim()).filter(Boolean)
const jobs = Number(argOf('--jobs', '1'))
const checkHost = !argv.includes('--no-check-host')

// 版本解析：显式给出则原样使用（并打印来源）；否则解析 dist-tags 的 latest + next 去重。
function resolveVersions() {
	const explicit = argOf('--versions', '')
	if (explicit) return { source: '显式 --versions', versions: explicit.split(',').map((s) => s.trim()).filter(Boolean) }
	const cacheDir = join(tmpdir(), 'dsh-testbed-npm-cache')
	const r = spawnSync('npm', ['view', '@deepseek-ai/dsh', 'dist-tags', '--json', '--cache', cacheDir], { encoding: 'utf8' })
	if (r.status !== 0) {
		console.error('[matrix] 无法解析 dist-tags，请显式给出 --versions。stderr:\n' + (r.stderr || ''))
		process.exit(1)
	}
	const tags = JSON.parse(r.stdout)
	return { source: `dist-tags（latest=${tags.latest}, next=${tags.next}）`, versions: [...new Set([tags.latest, tags.next].filter(Boolean))] }
}

// 宿主白名单快照：只看配置类文件，排除会持续变化的 sessions/storages/browser-*/change-ledger。
const HOST_TARGET = process.env.DSH_HOME_HOST || '/root/.dsh'
function hostSnapshot() {
	const entries = []
	const walk = (rel) => {
		const abs = join(HOST_TARGET, rel)
		if (!existsSync(abs)) return
		const st = statSync(abs)
		if (st.isDirectory()) {
			for (const name of readdirSync(abs).sort()) {
				if (rel === 'profiles' && name === 'node_modules') continue
				walk(join(rel, name))
			}
			return
		}
		entries.push(`${rel}\t${st.size}\t${st.mtimeMs}`)
	}
	for (const rel of ['settings.yaml', '.credentials.yaml', 'pet.json', 'skills', 'profiles']) walk(rel)
	return entries.join('\n')
}

function runGrid(version, combo, port) {
	const env = {
		...process.env,
		DSH_VERSION: version,
		GRID_LABEL: `${version.replace(/[^0-9A-Za-z._-]/g, '_')}-${combo}`,
		HOST_PORT: String(port),
		// 本会话下 /root/.docker 只读：用仓库内可写目录作为 docker CLI 状态目录
		DOCKER_CONFIG: dockerConfig,
	}
	if (combo === 'self+companion') {
		env.COMPANION = 'dsh-llm-newapi'
		env.COMPANION_HOST_DIR = join(repoRoot, '..', 'dsh-llm-newapi')
	}
	const logPath = join(outDir, `${env.GRID_LABEL}.log`)
	const r = spawnSync('docker', ['compose', 'run', '--rm', '--build', 'testbed'], { cwd: here, env, encoding: 'utf8' })
	writeFileSync(logPath, (r.stdout || '') + (r.stderr || ''))
	return { grid: env.GRID_LABEL, ok: r.status === 0, logPath }
}

const { source, versions } = resolveVersions()
mkdirSync(outDir, { recursive: true })
console.log(`[matrix] 版本来源：${source}`)
console.log(`[matrix] 版本集合：${versions.join(', ')}`)
console.log(`[matrix] 组合：${combos.join(', ')}`)

const before = checkHost ? hostSnapshot() : ''
const results = []
let port = DEFAULT_PORT
for (const version of versions) {
	for (const combo of combos) {
		console.log(`\n[matrix] === ${version} × ${combo}（端口 ${port}）===`)
		results.push(runGrid(version, combo, port))
		port += 1
	}
}
const after = checkHost ? hostSnapshot() : ''

console.log('\n[matrix] 汇总')
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.grid}  ${r.ok ? '' : '→ ' + r.logPath}`)

let hostOk = true
if (checkHost && before !== after) {
	hostOk = false
	const beforeSet = new Set(before.split('\n'))
	const changed = after.split('\n').filter((l) => l && !beforeSet.has(l))
	console.error('\n[matrix] 宿主 $DSH_HOME 发生变化（本测试承诺零改动）：')
	for (const line of changed.slice(0, 20)) console.error('  ' + line)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n[matrix] ${results.length - failed.length}/${results.length} 格通过；宿主零改动：${hostOk ? '是' : '否'}`)
process.exit(failed.length === 0 && hostOk ? 0 : 1)
```

> `--jobs` 目前串行执行（保留参数以便后续并行）；端口从 `13080` 起逐格递增，避免同一时刻的端口冲突。

- [ ] **Step 2: 跑通两版本 × self**

Run:
```bash
cd testbed && node matrix.mjs
```
Expected: 打印解析到的版本（当前 `0.1.5-rc.1`、`0.1.5-rc.2`）、两行 `PASS`、末行 `2/2 格通过；宿主零改动：是`，退出码 0；`testbed/.out/` 下生成两个日志。

- [ ] **Step 3: 验证矩阵能红（反例）**

Run:
```bash
cd testbed && node matrix.mjs --versions 0.1.5-rc.1,0.1.5-rc.99 ; echo "exit=$?"
```
Expected: `0.1.5-rc.99` 格 `FAIL`（镜像构建阶段 npm 找不到该版本），`1/2 格通过`，`exit=1`。

- [ ] **Step 4: 验证宿主零改动检测真的有效（反例）**

Run:
```bash
cd testbed && (touch "$DSH_HOME_HOST/settings.yaml" 2>/dev/null || touch /root/.dsh/settings.yaml 2>/dev/null) \
  && echo "已触碰宿主配置（仅时间戳）" || echo "宿主 DSH_HOME 对当前会话只读，无法做写入式反例"
node matrix.mjs --versions 0.1.5-rc.2 ; echo "exit=$?"
```
Expected: 若宿主 `$DSH_HOME` 可写，`touch` 使快照变化，末行显示 `宿主零改动：否` 且 `exit=1`；若当前会话对宿主只读（本机实为只读），`touch` 失败，则此步以打印说明结束——此时以 Task 2 Step 5 的 `find -newermt` 结果作为宿主零改动的证据。

- [ ] **Step 5: 提交**

```bash
git add testbed/matrix.mjs
git commit -m "test(testbed): 矩阵脚本（版本解析/遍历/宿主零改动快照/汇总表）"
```

---

### Task 9: 双语文档、`.gitignore` 与端到端验收

**Files:**
- Create: `testbed/README.md`、`testbed/README.zh.md`
- Modify: `.gitignore`（追加 `testbed/.out/`）

**Interfaces:**
- Consumes: Task 1–8 的全部命令与开关
- Produces: 用户可照着执行的文档；完成 spec 第 9 节的验收标准

- [ ] **Step 1: 追加 `.gitignore`**

`testbed/.gitignore`（Task 2 已建立）覆盖 `.out/`、`.env`、`.docker-config/`；本步只确认，不再往仓库根 `.gitignore` 重复添加：

```bash
cat testbed/.gitignore
git check-ignore -v testbed/.out/x testbed/.env testbed/.docker-config/x
```
Expected: 三行输出分别命中 `.out/`、`.env`、`.docker-config/` 三条规则；仓库根 `.gitignore` 保持未修改。

- [ ] **Step 2: 写 `testbed/README.zh.md`**

内容必须覆盖：前置条件、首次构建、常用命令、宿主零改动如何验证、故障排查、已知限制。骨架：

````markdown
# testbed：容器化插件测试环境

在不影响宿主 DSH 环境的前提下，跑源码层（L1）与真实宿主启动层（L2）校验；
支持多宿主版本与插件共存组合。

## 前置条件
- Docker Engine + Compose v2
- 能访问 npm registry（或在 `.env` 里设 `NPM_REGISTRY`）
- 宿主 `$DSH_HOME`（默认 `/root/.dsh`）：只读挂载，容器内不会修改

## 首次构建
```sh
cd testbed
cp .env.example .env   # 按需修改 DSH_HOME_HOST / HOST_PORT
docker compose build
```

## 常用命令
```sh
# 1) 单格：默认宿主版本（latest，当前 0.1.5-rc.1）跑完整 L1 + L2
docker compose run --rm --build testbed

# 2) 指定宿主版本
DSH_VERSION=0.1.5-rc.2 docker compose run --rm --build testbed

# 3) 叠加对端插件（共存验证）
COMPANION=dsh-llm-newapi COMPANION_HOST_DIR=../../dsh-llm-newapi \
  GRID_LABEL=self+newapi docker compose run --rm --build testbed

# 4) 全矩阵（latest + next 去重 × self）
node matrix.mjs
```

## 断言分层
- **L1**：`npm ci` → `npm run build` → 产物新鲜度（`lib/` 内容哈希与全新构建一致）→ `scripts/test-page-script.mjs`（出现任何 `FAIL:` 行即判红）。
- **L2**：真实 `dsh web` → 一次性 token 换会话 cookie → 首页 200 → boot 图含客户端 bundle → `specs` 端点真实应答（路径与方法动态取自 `lib/index.js` 的导出，返回需满足 `ok` 信封、`refreshMs=60000`、无凭据泄漏）→ 日志不含 `plugin tree failed to load` / `without inject`。
- 单格不断言 catalog 行数：宿主凭据的引用名与 catalog 别名不一定匹配，行数作为 diagnostic 打印；catalog 的精确正确性由 L1 的双面脚本用替身断言覆盖。

## 宿主侧准备

本机下 `/root/.docker` 可能是只读的，docker CLI 需要一个**可写**状态目录：

```sh
export DOCKER_CONFIG="$PWD/.docker-config"   # 在 testbed/ 目录内执行
```

该目录由本仓库提供且已被忽略，**不要**把 `~/.docker/config.json` 复制进来（它可能含凭据）。`matrix.mjs` 会自动设置该变量。

## 基础镜像获取

`Dockerfile` 的 `FROM` 始终是官方的 `node:24-bookworm-slim`。若 daemon 的 registry mirror 不可用、`docker.io` 直连超时，可先预取再按原名打本地标签：

```sh
docker pull docker.m.daocloud.io/library/node:24-bookworm-slim
docker tag  docker.m.daocloud.io/library/node:24-bookworm-slim node:24-bookworm-slim
```

预取时记录 registry 下发的 digest 以便核对；不要把第三方镜像站写进 `FROM`。

## 宿主零改动如何验证
- 每次 `docker compose run` 前会断言 `/host-dsh-home` 与 `/plugin-src` 只读，可写即拒绝运行。
- `matrix.mjs` 运行前后对宿主配置做白名单快照（`settings.yaml`、`.credentials.yaml`、`pet.json`、`skills/`、`profiles/`），变化即判红。
- 手工复核：`find "$DSH_HOME" -maxdepth 1 -newermt '-5 minutes'`。

## 故障排查
| 现象 | 处理 |
| --- | --- |
| `@deepseek-ai/*` 报 EINTEGRITY | 在 `.env` 设 `NPM_REGISTRY=https://registry.npmmirror.com` 后重跑 |
| 端口被占用 | 设 `HOST_PORT=13081`（宿主 3080 是 GUI，永不用） |
| `specs` 应答 405 | 路由未注册（历史事故形态）；看 `/work/dsh-web.log` |
| `specs` 应答 401/403 | `/api` 围栏拒绝：确认探针带了会话 cookie |
| `can only be read by its owner` 类加载失败 | 凭据权限：entrypoint 已 `chmod 600`；Windows 挂载下可能无法设权限 |
| 构建产物新鲜度判红 | 在宿主执行 `npm run build` 并提交重建的 `lib/` |
| 首次构建很慢 | 拉取 `node:24-bookworm-slim`；后续构建命中层缓存 |

## 已知限制
- 不做浏览器 E2E（`scripts/verify.mjs` 的 CDP 路线仍是 Windows 开发机上的手工工具），也不做真实上游调用（不运行 `fetch-all`，不消耗配额）。
- 这是本地开发测试环境，**不是安全沙箱**：容器会执行本仓库与对端插件源码，且能读到只读挂载的真实凭据。
- `PROFILE_MODE=preserve` 的实测结论：（在此写明 Task 5 的结果：可用 / 失败原文）
````

- [ ] **Step 3: 写 `testbed/README.md`（英文，内容与中文版等价）**

骨架与中文版逐节对应，标题用英文：`Prerequisites` / `First build` / `Common commands` / `Assertion layers` / `How host-untouched is verified` / `Troubleshooting` / `Known limitations`。

- [ ] **Step 4: 端到端验收（spec 第 9 节的四条硬标准）**

Run:
```bash
cd testbed
node matrix.mjs                                   # ① 两版本 × self 全绿 + 宿主零改动：是
COMPANION=dsh-llm-newapi COMPANION_HOST_DIR=../../dsh-llm-newapi \
  GRID_LABEL=self+newapi docker compose run --rm --build testbed   # ② 组合格绿
git -C .. status --short                          # ③ 只有预期的 testbed/ 与 .gitignore 变更
```
Expected: ① 末行 `2/2 格通过；宿主零改动：是`、退出码 0；② `L2 全部通过`；③ `git status` 只列出 `testbed/` 下的新文件与 `.gitignore` 的修改，没有 `src/`、`lib/`、`scripts/`、`package.json` 的改动。

- [ ] **Step 5: 阴性对照复跑（确认还原后仍全绿）**

Run:
```bash
cd testbed && node matrix.mjs --versions 0.1.5-rc.1
```
Expected: `1/1 格通过；宿主零改动：是`——Task 6/7 的破坏实验都发生在容器内副本上，宿主仓库应完全未受影响。

- [ ] **Step 6: 提交**

```bash
git add testbed/README.md testbed/README.zh.md .gitignore
git commit -m "test(testbed): 双语用法文档与 .gitignore（含 preserve 实测结论）"
```

---

### Task 10: 全球 / 中国双网络配置与本地 skill（2026-09 批准补充）

> 本次 quota 子项目只实现当前存在的单格 Compose/launcher/skill；`matrix.mjs` 与双语 README 尚未创建，以下 matrix/README 要求保留为后续 Task 8/9 的验收契约，不在本任务伪造。

**Files:**
- Create: `testbed/compose.china.yaml`
- Create: `testbed/.env.china.example`
- Create: `testbed/run.mjs`
- Create: `testbed/tests/network-config.test.mjs`
- Create: `.dsh/skills/dsh-plugin-testbed-network/SKILL.md`
- Modify: `testbed/Dockerfile`、`testbed/compose.yaml`
- Future (not present yet): matrix 与双语 README 接入；本任务只记录契约，不创建占位实现

**Interfaces:**
- `node testbed/run.mjs --network global|china [docker compose 子命令...]` 是本地统一入口；未显式给模式时默认 `china`。
- GitHub Actions 与 CI 继续只加载 `testbed/compose.yaml`（全球配置）。
- `matrix.mjs` 尚未存在；未来实现时，`--network global|china` 使用同一 Compose 文件选择逻辑，并把模式与解析后的 build inputs 写入格标签、新鲜度指纹与日志。

- [x] **Step 1: RED——配置 / 启动器 / skill 测试先失败**

使用 Node 内建测试覆盖：全球配置无中国镜像域；中国覆盖解析出独立 project/image、Node/npm/apt 镜像及代理；启动器本地默认 China、显式 global、错误模式与 Docker 退出码；skill 的触发元数据与命令。

- [x] **Step 2: GREEN——实现双网络配置**

全球 Compose 保持官方默认；中国 override 只覆盖网络相关 build args/env。Dockerfile 参数化 `NODE_IMAGE`、`NPM_REGISTRY`、`APT_MIRROR`，apt 镜像只在安装层临时启用并恢复/清理。slim 基础层未自带 CA，China apt 默认 HTTP 引导并依赖 apt 仓库签名校验，仍允许覆盖 HTTPS。npm registry 同时进入构建与运行期；launcher 缺省使用仓库内已忽略的 `.docker-config`，但尊重显式 `DOCKER_CONFIG`。

- [x] **Step 3: 编写并测试项目 skill**

`.dsh/skills/dsh-plugin-testbed-network/SKILL.md` 只在本地 testbed 构建/矩阵/调试时触发；默认 `china`，复现 GitHub/CI 时 `global`。按 writing-skills 要求，以无 skill 时代理选择不一致为 RED，并由 fresh agents 验证 GREEN。

- [ ] **Step 4（后续 Task 8/9）: 接入 matrix 与文档**

matrix 创建后接受 `--network` 且拒绝未知值；两种模式使用不同镜像/Compose project/日志标签。README 创建后给出本地 China 与 CI global 命令、镜像来源、代理边界和失败归因。本次只保留这些要求，不创建空壳文件。

- [x] **Step 5: 验证**

两份 `docker compose config`、全球配置无中国域、中国参数解析、stub Docker 入口与退出码、至少一次 China 实际 build（或保留明确网络 blocker 证据），再跑 global 配置解析以证明无泄漏。

本任务同样适用于 `dsh-llm-newapi`；quota 侧评审通过后，把同构配置与 skill 追加到 PR #5，不改变产品行为或 GitHub Actions。

---

## Self-Review 记录

- **Spec 覆盖**：spec 第 4 节（目录/挂载/网络/环境变量）→ Task 1；第 5 节六步 → Task 2/3/4/6；第 2 节目标 3/4（版本与组合矩阵）→ Task 6/7/8；第 7 节 L1（构建、产物新鲜度、双面脚本、可选 plugin-check）→ Task 3，L2（装配、启动、认证、首页、boot 图、`specs`、日志卫生）→ Task 4/6；第 9 节验收标准 → Task 9 Step 4，阴性对照落在 Task 6 Step 5 与 Task 7 Step 4，宿主零改动落在 Task 2 Step 5 与 Task 8 Step 1/2；第 10 节 `preserve` 风险 → Task 5；第 11 节承诺（只读挂载、不占 3080、不动 CI、不跑 `fetch-all`）→ Global Constraints 与 Task 1/2。
- **占位符扫描**：无 TBD / TODO；每个代码步骤都给出可直接写入的完整文件或完整函数体；唯一"待实测填写"的位置是 README 的 `preserve` 结论，由 Task 5 的实测结果填入，属预期的实测产物而非占位。Task 6 Step 5 的 `sed` 模式留有"以实际注册调用名为准"的条件说明——因为破坏点必须与源码实际写法一致，这是必要的实测约束而非含糊。
- **类型/命名一致性**：`STATE`、`TARBALL`、`COMPANION_TARBALL`、`GRID_LABEL`、`STEPS`、`CRED_COUNT`、`ROUTE`、`METHOD` 在全部任务中同名同义；`register_bundle_rows` 在 Task 4 定义为接受任意个包名（`"$@"`），Task 7 以 `"$COMPANION"` 调用；探针路径 `/usr/local/bin/probes/` 在 Task 5 的 `COPY probes` 建立（Task 1 不能 COPY，那时 `probes/` 还不存在）。
- **Self-Review 修正记录（4 处，均已就地修复）**：① Task 1 的 Dockerfile 曾同时 `COPY probes` 并对 `probes/*.sh` 设可执行位，但 `probes/` 在 Task 5 才存在、且 `*.sh` 当时无匹配会令 `chmod` 非零退出导致构建失败——已移除，改由 Task 5 添加 `COPY probes`；② `boot-probe.sh` 里提取 `ROUTE` 的 `node -e` 会输出两行（`trim()` 的返回值与 route），导致路径污染——已改为只打印 `route`；③④ Task 6/7 的阴性对照原本破坏 `/work/plugin/lib/*`，而 L2 启动的是 profile 里由 tarball 安装的副本，破坏不会生效、对照会假绿——已改为 `readlink -f` 解析 pnpm 符号链接后破坏 `$DSH_HOME/profiles/web/node_modules/…` 内的真实文件，并加入"替换是否生效"的自检（未生效则 `exit=2` 明确报"对照无效"，而不是当作通过）。
- **与 spec 的两处细化**（有意为之）：使用 `testbed/.empty/` 占位目录替代 spec 中的 `/dev/null`（Docker 不能把字符设备挂到目录）；`specs` 探针的路径取自 `lib/index.js` 的 `rpcRoutePath('specs')`，因此得到的是 `/api/dsh-quota-panel/specs`（与本仓库 CI 的 boot job 一致），而不是 spec 表格里简写的 `/dsh-quota-panel/specs`。
