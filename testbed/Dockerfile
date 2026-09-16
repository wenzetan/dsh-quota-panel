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
