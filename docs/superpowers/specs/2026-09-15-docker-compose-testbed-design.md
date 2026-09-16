# Docker Compose 测试环境（testbed）设计

- 日期：2026-09-15
- 状态：待评审（Draft for review）
- 适用仓库：`dsh-quota-panel`（本文件）
- 姊妹文档：`dsh-llm-newapi/docs/superpowers/specs/2026-09-15-docker-compose-testbed-design.md`（同构，按该仓库定制断言）
- 前置约定：本设计不修改现有 CI 的 `check` / `boot` / `tag` / `release` 任务

---

## 1. 问题

当前验证层级有两条腿，各有明确缺口：

| 层 | 现状 | 缺口 |
| --- | --- | --- |
| 双面脚本 | `npm test` → `node scripts/test-page-script.mjs`（单个约 77 KB 的文件：Part A 用替身与真实本地 HTTP server 验宿主半边，Part B 在 `vm` 沙箱里验浏览器半边） | 只能跑在开发者本机的那一个宿主版本上；浏览器半边是 `vm` 模拟，不是真实宿主装配 |
| 真实启动 | CI 的 `boot` job：隔离 `DSH_HOME` + 装 tarball + 种子凭据 + 真实 `dsh web` + `specs` 端点真实调用 | 只在 GitHub runner 上、只覆盖单一宿主版本、单进程、不覆盖插件共存 |

另有 `scripts/verify.mjs`：一个 CDP 脚本，但 Chrome 路径与用户数据目录**硬编码为 Windows 路径**（`C:/Program Files/...`、`D:/deepseek/...`），在本机 Linux 与 CI 上都无法运行。本设计**不替代**它——真实浏览器 E2E 是本轮的非目标（见第 2 节），该脚本继续作为 Windows 开发机上的手工工具存在。

在开发机上补这两条腿会污染宿主环境，原因已实测（见第 3 节）：`dsh` 每次启动都写 `$DSH_HOME`，宿主 `3080` 端口被正在运行的 GUI 占用，宿主 npm cache 目录只读。

目标是把这两条腿搬进容器：**宿主零改动**、可覆盖多个宿主版本、可覆盖插件组合、本地可复现。

---

## 2. 目标与非目标

### 目标

1. 本仓库自带 `testbed/`，`docker compose run --rm testbed` 即可跑完双面脚本层与真实宿主启动层校验。
2. 宿主配置通过**只读**挂载进入容器（整份 `$DSH_HOME`），容器内所有写入落在容器可写层与命名卷。
3. 宿主版本矩阵支持"支持线 + 滚动跟随 npm `latest`"，默认集合为 `latest` + `next` 去重。
4. 插件组合支持"单插件默认 + 可选叠加对端插件"（默认对端即 `dsh-llm-newapi`）。
5. 失败可定位：每格独立日志、明确判红关键词、非零退出码与汇总表。

### 非目标

1. **不做**真实浏览器 E2E（headless Chrome 驱动真实 GUI）；`scripts/verify.mjs` 的 CDP 路线不在本轮范围内。
2. **不做**真实上游调用（`fetch-all` 真取余额、真实 provider 端点）：本轮显式排除。`specs` 端点是离线语义（只解析凭据引用），可安全作为探针。
3. **不接 CI**：本轮只服务本地开发调试。现有 CI 任务一律不动。
4. **不承诺安全隔离**：见第 11 节。

---

## 3. 关键事实（全部为实测，构成本设计的硬约束）

| 事实 | 证据 | 对设计的影响 |
| --- | --- | --- |
| `dsh` 启动即写 `$DSH_HOME` | `dsh web --help` 在宿主失败：`EROFS: read-only file system, open '/root/.dsh/profiles/web/cordis.yml'`（`prepareProfile`） | `DSH_HOME` 必须可写，因此必须隔离；挂载的宿主 `$DSH_HOME` 只能只读 + 容器内复制 |
| 宿主 `$DSH_HOME` 共 976 MB，配置部分约 15 MB | `du -sh`：`profiles` 9M、`sessions` 90M、`browser-sessions` 339M、`dsh-browser` 487M、`change-ledger` 50M | 白名单复制可行；会话/浏览器数据不进容器 |
| 宿主 web profile 的 `node_modules` 内绝对路径符号链接数为 0 | `find ... -type l -lname '/*' \| wc -l` → 0 | profile 可跨机复制而不断链（`preserve` 模式的前提） |
| 宿主 `127.0.0.1:3080` 已被占用 | `ss -ltnp` | 容器端口映射必须换端口（默认 `13080`） |
| 宿主 dsh 版本 `0.1.5-rc.1`；本仓库 CI 安装 `@deepseek-ai/dsh` 的浮动最新（`latest` 当前 = `0.1.5-rc.1`） | 全局包 `package.json`；CI `npm install -g --registry=… @deepseek-ai/dsh pnpm` | 矩阵锚点：`latest` 与 `next`，外加显式回归版本 |
| npm dist-tags：`latest` = `0.1.5-rc.1`，`next` = `0.1.5-rc.2` | `npm view @deepseek-ai/dsh dist-tags` | "滚动跟随 latest" 的解析基准 |
| 宿主 `~/.npm/_cacache` 只读 | `npm view` 失败：`EROFS ... /root/.npm/_cacache/tmp/***` | 容器内用命名卷做 npm cache 是附带收益 |
| 本机 60 个镜像中无任何 node 镜像 | `docker images` | 首次构建需拉 `node:24-bookworm-slim` |
| `dsh plugin ...` 是转发给 **pnpm** | `dsh --help`：`manage a profile's plugins by forwarding the remaining arguments to pnpm` | 镜像必须包含 pnpm；`preserve` 模式存在 npm/pnpm 布局混用风险（第 10 节） |
| 凭据文件权限是硬门禁 | 本仓库 CI `boot` job 注释：`credentials-local` 拒绝 owner 之外可读的文件（默认 umask 给 644），权限过宽会导致**整棵插件树加载失败** | 复制宿主凭据后必须 `chmod 600`，否则 L2 全红且原因隐蔽 |
| `specs` 是离线端点 | CI `boot` job 注释：`specs only resolves refs — offline` | 可作为不消耗配额、不依赖上游的 L2 探针 |
| 插件端点路径 / 方法由插件自身导出 | `scripts/test-page-script.mjs` 使用 `plugin.rpcRoutePath(...)` / `plugin.rpcMethod(...)` | 探针应动态读取导出，而不是硬编码字符串（防恒绿） |
| 历史事故形态 | 本仓库 `docs/superpowers/plans/2026-09-03-dsh-0.1.5-compat.md`：`connection.rpc.handle()` 抛 `cannot get property "webServer" without inject` 被吞掉 → 浏览器遇 405（SPA 回退） | 判红关键词与"405 即通道缺失"的判据固定下来 |

---

## 4. 架构

### 4.1 目录结构（本仓库新增，除 `.gitignore` 外不改动现有文件）

```
dsh-quota-panel/
├─ testbed/
│  ├─ Dockerfile          # node:24-bookworm-slim + ARG DSH_VERSION + pnpm + dsh
│  ├─ compose.yaml        # 单 service 模板，全部行为由 env 驱动
│  ├─ .env.example        # DSH_HOME_HOST 等宿主侧变量示例（Linux 与 Windows 各一份注释）
│  ├─ entrypoint.sh       # 第 5 节的六步
│  ├─ matrix.mjs          # 版本/组合遍历 + 汇总表（第 6 节）
│  ├─ probes/
│  │  ├─ boot-probe.sh    # 认证 + 首页 + boot 图 + RPC + 日志关键词断言
│  │  └─ expectations.json
│  ├─ README.md           # 英文用法
│  ├─ README.zh.md        # 中文用法（与本仓库双语 README 传统一致）
│  └─ .out/               # 运行产物，gitignore
└─ .gitignore             # 追加 testbed/.out/
```

### 4.2 compose 服务（单 service 模板）

```yaml
services:
  testbed:
    build:
      context: .
      args: { DSH_VERSION: "${DSH_VERSION:-0.1.5-rc.1}" }
    environment:
      DSH_VERSION: "${DSH_VERSION:-0.1.5-rc.1}"
      PROFILE_MODE: "${PROFILE_MODE:-minimal}"      # minimal | preserve
      COMPANION: "${COMPANION:-}"                   # 叠加的对端插件名，空 = 单插件
      GRID_LABEL: "${GRID_LABEL:-local}"            # 日志与产物命名
      PLUGIN_CHECK_DEPS: "${PLUGIN_CHECK_DEPS:-}"   # 可选：含 dsh-plugin-check 的目录
    volumes:
      - "${DSH_HOME_HOST:-/root/.dsh}:/host-dsh-home:ro"
      - "..:/plugin-src:ro"
      - "${COMPANION_HOST_DIR:-/dev/null}:/companion-src:ro"
      - "npm-cache:/root/.npm"
      - "pnpm-store:/root/.local/share/pnpm/store"
    ports:
      - "127.0.0.1:${HOST_PORT:-13080}:3080"
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  npm-cache:
  pnpm-store:
```

### 4.3 环境变量契约

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `DSH_VERSION` | `0.1.5-rc.1`（= 当前 `latest`，亦为本机宿主版本） | 容器内安装的宿主版本；同时是镜像构建参数 |
| `PROFILE_MODE` | `minimal` | `minimal`：空 profile + 装本仓库 tarball（与现有 CI `boot` 同路）；`preserve`：先还原宿主 profile 的 `dsh.profile.bundles` 行，再用本仓库 tarball 覆盖被测行 |
| `COMPANION` | 空 | 需要叠加的插件包名（如 `dsh-llm-newapi`）；非空时必须同时提供 `COMPANION_HOST_DIR` |
| `COMPANION_HOST_DIR` | `/dev/null` | 对端插件源码目录的宿主绝对路径（只读挂载到 `/companion-src`） |
| `DSH_HOME_HOST` | `/root/.dsh` | 宿主 `$DSH_HOME` 绝对路径；Windows 示例 `C:/Users/<you>/.dsh` |
| `HOST_PORT` | `13080` | 容器 `3080` 映射到的宿主端口 |
| `GRID_LABEL` | `local` | 该格在日志与 `testbed/.out/` 中的标识 |
| `PLUGIN_CHECK_DEPS` | 空 | 可选：提供含 `@deepseek-ai/dsh-plugin-check` 的目录时，追加运行 `scripts/plugin-check.mjs`（diagnostic） |

### 4.4 网络

- 容器 → 宿主服务：通过 `host.docker.internal`（`host-gateway`）。
- 容器 → 公网（`npm ci`、`npm pack`、`pnpm install`）：默认 bridge 出网；无网络时 L1/L2 无法完成，脚本以明确错误退出而非静默跳过。
- 宿主 → 容器：仅 `127.0.0.1:${HOST_PORT}` 一个端口，且只绑回环。
- 注意：`specs` 探针是离线的；本设计不触发 `fetch-all`，因此 L2 不会消耗配额。

---

## 5. entrypoint 执行流程（六步）

1. **断言只读**：确认 `/host-dsh-home` 与 `/plugin-src` 所在挂载点不可写；不可写性不成立则立即失败（防止"测试"污染宿主）。
2. **播种 `$DSH_HOME`**：容器内 `DSH_HOME=/work/dsh-home`；从 `/host-dsh-home` 白名单复制 `settings.yaml`、`.credentials.yaml`、`skills/`、`storages/`（仅用于复现宿主持久化状态，不含会话历史）、`pet.json`；**`chmod 600 .credentials.yaml`**（本仓库 CI 已记录该门禁：权限过宽会让整棵插件树加载失败）。不复制 `sessions/`、`attachments/`、`browser-*`、`change-ledger/`、`profiles/*/node_modules`。
3. **暂存源码**：`cp -a /plugin-src/. /work/plugin/`（排除 `node_modules`、`.git`、`.tmp-*`）；`COMPANION` 非空时同样暂存 `/companion-src` 到 `/work/companion`；随后 `npm ci`。
4. **构造 profile**：按 `PROFILE_MODE` 执行（见 4.3）。被测插件一律以 **`npm pack` 产物**安装（`prepack` 会构建，等价于用户真实安装路径）。装完补写 `dsh.profile.bundles` 行并打印实际行列表。
5. **L1（源码层）**：见第 7 节。
6. **L2（真实宿主层）**：`dsh web` 后台启动 → 从日志抓一次性 token 换会话 cookie → 执行 `probes/boot-probe.sh` → 无论成败都 dump 日志尾部到 `testbed/.out/${GRID_LABEL}.log` → 以该格结论退出。

任一步失败：立即停止该格后续步骤，输出带前缀的失败摘要，退出码非 0。

---

## 6. 矩阵语义（`matrix.mjs`）

- **版本解析**：`--versions` 可显式给出；默认 `latest,next` 经 `npm view @deepseek-ai/dsh dist-tags` 解析后**去重**（当前结果：`0.1.5-rc.1`、`0.1.5-rc.2`）。支持线通过 `--versions 0.1.5-rc.1,0.1.5-rc.2` 显式固定，用于回归。
- **组合解析**：`--combos self,self+companion`；`self` 恒在，`self+companion` 需要 `COMPANION_HOST_DIR`。
- **执行**：每格 `docker compose run --rm --build`（`--build` 保证 `DSH_VERSION` 变更时镜像层同步）。
- **产物**：`testbed/.out/<version>-<combo>.log`，逐格 tee。
- **汇总**：末尾打印 `版本 × 组合` 的 PASS/FAIL 表格、失败格日志路径、总耗时；存在失败格时退出码 1。
- **并发**：默认串行（宿主端口与内存有限）；`--jobs N` 时为每格分配递增 `HOST_PORT`。

---

## 7. 本仓库的 L1 / L2 断言

### L1（源码层）

| 步骤 | 命令 | 判红 |
| --- | --- | --- |
| 构建 | `npm run build`（`scripts/build.mjs`：tsc → `lib/` + vendored runtime 复制） | 非零退出 |
| 产物新鲜度 | 构建前后对 `lib/` 做 sha256 清单比对（**不使用 `git diff`**：容器内源码副本刻意不含 `.git`） | 构建后 `lib/` 发生变化 = 提交的产物过期，与 CI 的"committed `lib/` matches a fresh build"等价 |
| 双面脚本 | `node scripts/test-page-script.mjs` | 进程非零退出，或输出出现任何 `FAIL:` 行 |
| 插件规范（可选） | `PLUGIN_CHECK_DEPS` 提供时运行 `node scripts/plugin-check.mjs` | 出现 ERROR；WARNING 按该脚本既有严格策略处理（diagnostic，不判红本格） |
| 打包自包含（可选） | `npm pack` 后校验宿主 bundle 仅 import `node:` 内建与相对路径、客户端 bundle 仅 import `react` | 出现其它外部 import（diagnostic） |

### L2（真实宿主层，`probes/boot-probe.sh`）

| 断言 | 内容 | 判红 |
| --- | --- | --- |
| 装配 | `dsh --dump-config` 组合树包含本插件行，且 patch 层生效 | 缺行 |
| 启动 | `dsh web` 进程存活至探针结束 | 提前退出 |
| 认证 | 日志中的 `token=` 换到会话 cookie（0.1.5 起强制） | 拿不到 cookie |
| 首页 | `GET /` → 200（带 cookie） | 非 200 |
| 浏览器半边 | boot 图（`window.__DSH_BOOT__` 所在页面）中出现 `dsh-quota-panel/client.js` 引用 | 引用缺失 |
| RPC 通道 | 对 `specs` 端点发真实调用：路径与方法**从容器内 `lib/index.js` 的导出（`rpcRoutePath` / `rpcMethod`）动态取得**，请求体 `{"type":"client-request","rpcId":…,"method":…,"payload":{}}`；断言 HTTP 200、`type==="server-response"`、结果含显式配置行与 catalog 行 | HTTP 405（SPA 回退 = 通道静默缺失）、非 200、或结果形状不符 |
| 日志卫生 | `dsh web` 日志不含 `plugin tree failed to load`、`without inject` | 出现即红（历史事故形态） |

### 组合格（`COMPANION=dsh-llm-newapi`）追加断言

| 断言 | 判红 |
| --- | --- |
| boot 图中同时出现两个插件的 `client.js` | 缺任一 |
| 两个 RPC 通道各自可应答，互不覆盖 | 任一非 200 或返回到另一个通道 |
| 日志无 slot / service 重复注册警告 | 出现 |

断言分 `required`（判红）与 `diagnostic`（仅记录）。`fetch-all`、真实 provider 端点、真实浏览器渲染均不在本轮断言内。

---

## 8. 跨仓库共享契约（两个仓库必须逐字一致）

| 项 | 约定 |
| --- | --- |
| 目录 | `testbed/`，位于仓库根 |
| service 名 | `testbed` |
| 文件 | `Dockerfile`、`compose.yaml`、`.env.example`、`entrypoint.sh`、`matrix.mjs`、`probes/`、README（双语） |
| 基础镜像 | `node:24-bookworm-slim`（与 CI 的 node 24 对齐） |
| profile 模式 | `PROFILE_MODE=minimal\|preserve`，默认 `minimal` |
| 宿主版本默认值 | 各仓库跟自己的 CI 锚点一致（本仓库 `latest`，当前 `0.1.5-rc.1`）；矩阵运行总是显式覆盖该值 |
| 对端叠加 | `COMPANION` + `COMPANION_HOST_DIR` |
| 端口 | 默认 `HOST_PORT=13080`，`--jobs` 时递增 |
| 产物 | `testbed/.out/<version>-<combo>.log`，且 `.gitignore` 忽略 `testbed/.out/` |
| 日志前缀 | `[testbed][<version>][<combo>][<step>]` |
| 退出码 | 0 = 该格全绿；非零 = 该格失败 |
| 矩阵退出码 | 0 = 全部格绿；1 = 存在失败格 |

契约只约束**命名与语义**，不共享代码：两个仓库各自实现，避免引入第三个真源。

---

## 9. 验收标准

1. `docker compose run --rm testbed` 在本仓库跑通 L1 + L2，且**宿主零改动**：运行前后 `git status` 干净、宿主 `$DSH_HOME` 无新增/修改文件、宿主 `3080` 上的 GUI 不受影响。
2. `node testbed/matrix.mjs` 在当前版本集合（`0.1.5-rc.1`、`0.1.5-rc.2`）× `self` 上输出汇总表并全绿。
3. `COMPANION_HOST_DIR=../dsh-llm-newapi COMPANION=dsh-llm-newapi` 时，`self+companion` 格跑通并通过追加断言。
4. **阴性对照（必做）**：人为注入一个缺陷后矩阵必须变红。至少验证两种：
   - 客户端半边：临时改坏客户端构建入口/产物名，`L2 · 浏览器半边` 断言必须红；
   - RPC 通道：临时移除 `connection.fetch` 通道注册调用，`L2 · RPC 通道` 断言必须红（复现历史上的 405 形态）。
   对照实验结束后必须还原工作区，且还原后矩阵回到全绿。
5. `testbed/README.md`（英）与 `testbed/README.zh.md`（中）覆盖：前置条件、首次构建、四个常用命令（单格、指定版本、叠加对端、全矩阵）、宿主机零改动的验证方法、故障排查（端口占用、镜像拉取、凭据权限门禁）。
6. 插件运行时依赖零增长：`package.json` 的 `dependencies` / `peerDependencies` 不变（本插件刻意保持零依赖）；`matrix.mjs` 只用 Node 内建模块。

---

## 10. 风险与回退

| 风险 | 影响 | 缓解 / 回退 |
| --- | --- | --- |
| `preserve` 模式在 npm 布局的宿主 profile 上跑 pnpm（`dsh plugin` 转发 pnpm） | 可能导致 profile 依赖树混乱或安装失败 | 实施第一步先做这项实测；失败则该模式标记为 experimental 并保持默认 `minimal`（与现有 CI 同路，已验证） |
| 首次构建需拉 `node:24-bookworm-slim` | 无网络或 registry 不可达时无法启动 | 镜像预拉步骤写进 README；失败时给出明确错误与替代（`docker load` 离线导入） |
| 容器内 `npm ci` / `pnpm install` 依赖网络 | 断网环境下 L1/L2 不可用 | 明确报错；命名卷缓存降低重复开销；不静默跳过 |
| 复制宿主 `.credentials.yaml` 的真实凭据进容器 | 容器内被测插件可见真实凭据；catalog 探测的真实行会出现在 `specs` 结果里 | 第 11 节明示取舍；探针不使用 `fetch-all`，不主动外呼 |
| Windows（Docker Desktop）路径与权限 | 绑定挂载路径写法不同；`chmod 600` 语义不同 | `.env.example` 给出 Windows 示例；`chmod` 失败降级为警告并记录，README 说明此时可能触发凭据权限门禁 |
| 端口 `13080` 在本机被占用 | 容器起不来 | `HOST_PORT` 可覆盖；启动前检测并给出明确提示 |
| 版本集合随上游漂移 | 矩阵含义变化 | `matrix.mjs` 每次运行打印解析到的真实版本与解析来源（dist-tag / 显式） |

---

## 11. 明确承诺与明确不承诺

**承诺**：

- 宿主 `$DSH_HOME` 与仓库源码均以只读方式进入容器；所有写入发生在容器可写层与命名卷。
- 不占用宿主 `3080`；不动宿主任何配置文件。
- 不改动现有 CI 任务。
- 不运行 `fetch-all`，不触发真实 provider 请求，因此不消耗任何配额。

**不承诺**：

- 这不是安全沙箱。容器内会执行本仓库与对端插件的源码，且能读到只读挂载进来的真实凭据。它解决的是**环境污染与版本矩阵**问题，不是**不可信代码隔离**问题。不要用它运行来源不明的插件。

---

## 12. 全球 / 中国双网络配置（2026-09 补充，已批准）

本地开发与 GitHub Actions 必须使用两套显式网络配置，不能互相污染：

1. `testbed/compose.yaml` 是**全球基线**：官方 `node:24-bookworm-slim`、npmjs、Debian 官方 apt；GitHub Actions 与发布验证只加载这份文件。
2. `testbed/compose.china.yaml` 是**中国本地覆盖层**：放在基线之后加载，默认 DaoCloud Node、npmmirror npm，并覆盖可配置的 `APT_MIRROR` 及可选 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`。slim 基础层尚未安装 CA，apt 默认用 HTTP 引导（仍由 apt 校验仓库签名）；有 CA 的自定义基础镜像可覆盖为 HTTPS。中国配置不得改写全球基线。
3. 两种模式使用不同镜像标签 / Compose project 标识，避免中国镜像缓存冒充全球配置，反之亦然。
4. registry 配置必须同时传入 Docker build、镜像运行期与容器内 `npm ci` / `npm pack` / `dsh plugin` 使用的 pnpm；apt mirror 只在安装层临时替换完整 sources 目录，结束时恢复官方 sources 并清理 apt lists。代理只来自环境变量，不把值固化进镜像或仓库。
5. 仓库内 Node 启动器统一生成正确的 `docker compose -f …` 参数：`--network global|china`；直接本地运行缺省 `china`，CI/GitHub reproduction 显式 `global`。启动器在 `DOCKER_CONFIG` 未设置时使用已忽略的 `testbed/.docker-config`，显式值优先。`matrix.mjs` 当前尚不存在，本子项目不伪造；未来实现矩阵时须接受同名参数，并把网络模式与解析后的 build inputs 写入格标签、日志与新鲜度指纹。
6. 两仓库各自提供 `.dsh/skills/dsh-plugin-testbed-network/SKILL.md`。对本地 testbed 的明确请求，该 skill 默认选择 `china`；复现 CI / GitHub Actions 时显式使用 `global`。skill 不修改 CI、不存储 registry 凭据。
7. 验证包括：两份 `docker compose config`、全球配置无中国域名、中国配置解析到预期镜像 / npm / apt、容器内 registry 值、至少一次中国配置真实 build，以及项目 skill 的 RED/GREEN 场景。

## 13. 未决问题

无。第 10 节的 `preserve` 模式风险以实际装配结果记录；双网络配置的具体镜像站与 digest 由测试证据和 README 维护，不将第三方源写入全球基线。
