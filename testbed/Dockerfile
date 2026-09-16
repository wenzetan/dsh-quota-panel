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
# 对照测试与 fixture 一起进镜像：测试要 source 真正安装的 entrypoint，不能在容器里另写一份。
COPY tests /usr/local/lib/testbed-tests
RUN chmod +x /usr/local/bin/testbed-entrypoint /usr/local/lib/testbed-tests/test-dump-profile.sh \
 && ln -s /usr/local/lib/testbed-tests/test-dump-profile.sh /usr/local/bin/testbed-test-dump-profile

ENTRYPOINT ["/usr/local/bin/testbed-entrypoint"]
