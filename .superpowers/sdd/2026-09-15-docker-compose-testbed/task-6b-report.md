# Task 6b 报告：真实 L2 shell 编排与路由缺失阴性对照

## 结论

状态：**DONE**。

在 `testbed/docker-compose-testbed`、开工 HEAD/BASE `bb08beea9e3ee0352a432b3bc043d83e2ec8cf34` 上完成真实 L2 编排：强制启动 token + session cookie、认证首页、从真实 boot JSON 提取 revisioned quota client URL 并实际 GET 200、动态导出 specs route/method、调用既有 RPC contract helper 校验响应、失败日志经 `redactLog`、所有 curl 均有连接/总超时、总流程有 deadline，并用 trap `kill` + `wait` 回收 `dsh web`。

真实 GLOBAL minimal / DSH `0.1.5-rc.1` 正例通过；容器内仅变异 profile 安装副本的路由注册后，认证、首页、client 仍通过，而 specs 明确以 HTTP 404 判红；恢复 hash 后再次跑真实正例通过。

## 变更文件

- `testbed/probes/boot-probe.sh`（新增）：真实 L2 shell 编排；不实现第二套 JSON 校验。
- `testbed/tests/boot-probe-flow.test.mjs`（新增）：stub `dsh`/`curl`/contract helper 的快速流程测试。
- `testbed/probes/rpc-contract.mjs`：为现有 helper 添加安全 CLI；支持 DSH 0.1.5-rc.1 的真实 `globalThis["__DSH_BOOT__"] = ...` boot 形状。
- `testbed/tests/rpc-contract.test.mjs`：新增真实 boot 左值回归测试；CLI 的 contract/client/validate/redact 四种模式由 flow test 覆盖。
- `testbed/entrypoint.sh`：接入 `run_l2` 和 `STEPS=l2`。
- `.superpowers/sdd/2026-09-15-docker-compose-testbed/task-6b-report.md`（本报告）。

未修改 `testbed/Dockerfile`（现有 `COPY probes`/`COPY tests` 已足够，shell 由 `bash` 调用）、任何 Compose/双网络文件、`network-config.test.mjs`、`src/`、`lib/`、`scripts/`、`package.json`、`.github/`、宿主生产配置或 `dsh-llm-newapi`。

## TDD：初始 RED 与 GREEN

### 初始 RED

命令：

```bash
node --test testbed/tests/boot-probe-flow.test.mjs 2>&1 \
  | tee testbed/.out/logs/task6b-red.log
```

结果：`RED_EXIT=1`；9 个测试均失败。核心正确失败原因包括：

- `testbed/probes/boot-probe.sh` 尚不存在（shell flow exit 127）；
- `rpc-contract.mjs` 尚无 CLI，`contract` 命令无输出，JSON parse 失败。

这证明测试在生产实现之前能够检测缺失能力。

### 最小实现后的 GREEN

命令：

```bash
node --test testbed/tests/boot-probe-flow.test.mjs \
  testbed/tests/rpc-contract.test.mjs testbed/tests/preserve.test.mjs
bash testbed/tests/test-dump-profile.sh
```

结果（首次 GREEN 记录）：Node `71/71` pass、dump profile `PASS=10 FAIL=0`、`GREEN_EXIT=0`。之后加入真实 boot 形状回归，最终快速集见“最终验证”。

### 真实运行发现的 303 回归：RED → GREEN

首次真实正例日志 `testbed/.out/logs/task6b-global-positive.log` 在 token 换 cookie 阶段得到 HTTP 303，正确失败；没有把 303 当成功。

根因：认证端点用 303 跳回首页；CI 的已知工作模式使用 `curl -L`，原 shell 未跟随重定向。先把 curl stub 改为：不带 `--location/-L` 就返回 303 且不写 cookie，只有跟随后才返回最终 200 并写 cookie。

RED 命令：

```bash
node --test --test-name-pattern='real shell flow|missing specs route' \
  testbed/tests/boot-probe-flow.test.mjs \
  | tee testbed/.out/logs/task6b-auth-redirect-red.log
```

结果：`AUTH_RED_EXIT=1`；正例明确失败为 `token 换 cookie 返回 HTTP 303`，阴性流程也因认证未完成而不能抵达 route 阶段。

最小修复：仅认证 curl 增加 `--location`，仍要求最终 HTTP 200 且 cookie jar 非空。

GREEN 同命令结果：2 pass、5 skipped、`AUTH_GREEN_EXIT=0`；日志 `testbed/.out/logs/task6b-auth-redirect-green.log`。

### 真实 boot 形状回归：RED → GREEN

认证修复后的真实运行进入首页 200，但 helper 因只支持 `window.__DSH_BOOT__` 而拒绝真实 payload。仅做布尔/计数形状诊断（未输出 HTML 正文）确认唯一 `__DSH_BOOT__`、quota id/client 均存在；读取镜像内 DSH 静态 webserver 实现确认实际注入为：

```js
globalThis["__DSH_BOOT__"] = <JSON>
```

先增加 `clientUrlFromBootHtml parses the real DSH globalThis bracket boot assignment` 测试。

RED：

```bash
node --test --test-name-pattern='real DSH globalThis' \
  testbed/tests/rpc-contract.test.mjs
```

结果：`REAL_BOOT_SHAPE_RED_EXIT=1`，错误为 `boot HTML must advertise a revisioned dsh-quota-panel client URL`。

最小修复：同一 JSON 提取器增加 `globalThis["__DSH_BOOT__"]`/单引号 bracket 左值，不增加 URL 正则 fallback。GREEN：1 pass、44 skipped、exit 0。

## 快速流程覆盖

`boot-probe-flow.test.mjs` 使用真实 `boot-probe.sh`，仅 stub 外部边界，覆盖：

1. `dsh web --no-open` 参数精确传递；
2. token 必需；cookie 必需；认证必须跟随 303 并取得最终 200 + cookie；
3. 每次 curl 都含 `--connect-timeout` 与 `--max-time`；连接失败 rc 7、总超时 rc 28 均不能 PASS；
4. 从代表性真实 boot JSON 提取 revisioned URL，并对该精确 URL 实际 GET；
5. specs route/method 来自动态 contract CLI，HTTP POST 后由既有 `validateSpecsResponse` 校验；坏 JSON shape/rpcId/`ok:false` 由 helper 拒绝且不回显响应 marker；
6. route missing 前严格验证 auth → home → client → specs 的调用顺序；
7. 失败日志通过 `redact-log` CLI，synthetic token 与响应 marker 不泄漏；
8. 成功和失败路径均验证后台 `dsh` 收到终止信号且 trap 等待其完成（reaped marker）。

shell 不包含 RPC/boot JSON 的第二套语义校验；`node -e` 仅安全构造请求 JSON及读取 helper 输出的 route/method 两个字符串。

## 真实 GLOBAL L2 正例

约束：GLOBAL compose 单文件、minimal profile、DSH `0.1.5-rc.1`、仓库内 `DOCKER_CONFIG=$PWD/testbed/.docker-config`、宿主 `DSH_HOME` 只读挂载。未调用 `fetch-all`，未启动浏览器，未主动发真实上游请求。

最终构建正例命令：

```bash
export DOCKER_CONFIG="$PWD/testbed/.docker-config"
export DSH_HOME_HOST="${DSH_HOME:-/root/.dsh}"
DSH_VERSION=0.1.5-rc.1 PROFILE_MODE=minimal \
GRID_LABEL=task6b-global STEPS=all \
node testbed/run.mjs --network global run --rm --build testbed
```

日志：`testbed/.out/logs/task6b-global-positive-final.log`（ignored local evidence，不提交）。

退出：`GLOBAL_L2_FINAL_EXIT=0`。

关键摘要：

- 宿主挂载确认为只读；
- `dsh web --no-open`；
- 启动 token 与 session cookie 均取得；
- 认证首页 HTTP 200；
- boot 广告的 revisioned quota client 实际 GET 200；
- `specs rows=3 refreshMs=60000`，helper 语义通过；
- 日志卫生通过，L2 全部通过。

`refreshMs=60000` 仅是预期配置值，不独立证明工作区包身份；包身份由本地 staged source → fresh build hash → tarball → minimal profile 安装链与日志记录共同绑定。本探针是 HTTP/host L2，不是浏览器 E2E。

## 容器内路由缺失阴性对照

命令结构（完整执行命令保存在会话记录；关键步骤如下）：

```bash
DSH_VERSION=0.1.5-rc.1 PROFILE_MODE=minimal \
GRID_LABEL=task6b-route-negative \
node testbed/run.mjs --network global run --rm --entrypoint bash testbed -lc '
  STEPS=assert,seed,stage,l1,pack,profile /usr/local/bin/testbed-entrypoint
  target="$(readlink -f "$DSH_HOME/profiles/web/node_modules/dsh-quota-panel/lib/index.js")"
  # 校验 target 位于隔离 profile，唯一命中注册；备份/hash
  # 精确替换 ctx.connection.fetch.register( → ((_route) => undefined)(
  # node --check；STEPS=l2；捕获 probe rc；恢复并校验 hash
'
```

日志：`testbed/.out/logs/task6b-route-negative-strict.log`（ignored local evidence，不提交）。严格 harness 以机器断言要求 auth/home/client 三阶段成功标志、probe exit 1、route 404/405，并拒绝认证/连接/进程崩溃类别。

证据：

- 安装副本实路径：`/work/dsh-home/profiles/web/node_modules/dsh-quota-panel/lib/index.js`；
- `ctx.connection.fetch.register(` 变异前唯一命中数：`1`；
- 变异前 SHA-256：`dc53e0c9e0e42fe0e7720fb1627c4e063567f964afd8fc82eeef21c53ce04b80`；
- 变异后 SHA-256：`67d1dd6ffc404062437637cc5369a52a48f44622ab80c34358854af8574106bc`；
- 变异后原 needle 命中数 `0`，`node --check`：valid；
- token + cookie 成功，认证首页 HTTP 200，revisioned client 实际 GET 200；
- specs 明确失败：`specs 路由缺失（HTTP 404）`；不是 401/403、连接失败或进程崩溃；
- `NEGATIVE_PROBE_EXIT=1`：这是被期待、被观测到的探针红灯；
- `ROUTE_NEGATIVE_STRICT_HARNESS_EXIT=0`：这是严格控制 harness 成功证明预期红灯及正确失败类别的退出码，不能与 probe exit 混同；
- trap 恢复后 `NEGATIVE_RESTORED_HASH_MATCH=yes`；容器结束，不改宿主。

## 恢复后真实正例

不能只依赖 hash，因此恢复后再次执行真实 GLOBAL positive：

```bash
export DOCKER_CONFIG="$PWD/testbed/.docker-config"
export DSH_HOME_HOST="${DSH_HOME:-/root/.dsh}"
DSH_VERSION=0.1.5-rc.1 PROFILE_MODE=minimal \
GRID_LABEL=task6b-restored-positive STEPS=all \
node testbed/run.mjs --network global run --rm testbed
```

日志：`testbed/.out/logs/task6b-restored-positive.log`。结果：`RESTORED_POSITIVE_EXIT=0`，认证/首页/client/specs/log hygiene/L2 全部再次通过。

## 最终验证

快速 Node 集：

```bash
node --test testbed/tests/boot-probe-flow.test.mjs \
  testbed/tests/rpc-contract.test.mjs testbed/tests/preserve.test.mjs
```

聚焦集结果：`72/72 pass`、`FAST_STABLE_EXIT=0`；日志 `testbed/.out/logs/task6b-fast-stable.log`。

随后执行包含 network-config 在内的全部 testbed Node 测试与静态检查：

```bash
node --test testbed/tests/*.test.mjs
bash testbed/tests/test-dump-profile.sh
bash -n testbed/probes/boot-probe.sh testbed/entrypoint.sh
node --check testbed/probes/rpc-contract.mjs
node --check testbed/tests/boot-probe-flow.test.mjs
git diff --check -- testbed
```

结果：全部 Node `82/82 pass`、dump profile `PASS=10 FAIL=0`、shell/Node 语法与 diff whitespace 检查均通过，`FINAL_FAST_VERIFY_EXIT=0`；日志 `testbed/.out/logs/task6b-final-fast-verification.log`。

## 自审

- [x] 严格先写流程测试并记录正确 RED，再实现 production shell/CLI。
- [x] 真实运行发现的 303 与真实 boot 左值均补了独立 RED，再做最小修复。
- [x] token 与 cookie 都是硬门槛；没有旧版匿名 fallback。
- [x] 303 必须真实跟随到最终 200，不能把 303 本身视为成功。
- [x] 所有 curl 有 connect/max time，总流程有 deadline；连接/总超时不能 PASS。
- [x] `dsh web --no-open`。
- [x] 从真实 boot JSON 提取 revisioned client URL 并实际 GET 200。
- [x] specs contract 动态取自插件导出；响应复用既有 helper，无 shell 第二套 JSON 语义实现。
- [x] 失败日志经 `redactLog`，不输出响应全文、token、cookie 或凭据值。
- [x] trap 同时 kill + wait。
- [x] 阴性只改容器隔离安装副本，唯一命中、前后 hash、语法、失败分类、恢复均有证据。
- [x] 未调用 `fetch-all`、未作真实上游请求、未启动浏览器。
- [x] 未夸称 specs “完全无副作用”，未夸称 L2 是浏览器 E2E。
- [x] 未修改 Dockerfile/Compose/network tests/生产源码/配置/newapi；未派子代理或 reviewer。

## 边界与 concerns

- specs 自身按当前插件实现不主动请求上游，但可能读取 credential refs，完整 profile 中其它插件的启动副作用不在本任务证明范围；本次为 minimal profile。
- L2 验证 HTTP 认证、boot/client 静态服务与 RPC 语义，不执行浏览器 bundle。
- 真实日志只保留脱敏摘要；`.out/` 与 `.docker-config/` 均由 testbed `.gitignore` 忽略。
- 无已知未解决 concern。
