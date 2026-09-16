# testbed 镜像：node 24（与 CI 一致）+ pnpm（dsh plugin 转发 pnpm）+ 指定版本的 dsh。
# 不写 Dockerfile frontend syntax 行，避免构建前额外解析 frontend 镜像。
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG DSH_VERSION=0.1.5-rc.1
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG APT_MIRROR=
ARG APT_SECURITY_MIRROR=

ENV DSH_VERSION=${DSH_VERSION} \
    DSH_HOME=/work/dsh-home \
    DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_REGISTRY=${NPM_REGISTRY}

# curl 供探针使用；ca-certificates 供 HTTPS；git 供 pnpm 解析 git 依赖。
# 两个 apt mirror 必须同时为空或同时非空；非空时完整替换 sources 目录，分别绑定主仓与 security 仓。
# 安装结束（包括失败退出）都会恢复原目录，镜像层中只保留安装结果并清除 apt lists。
RUN set -eu; \
    if { [ -n "${APT_MIRROR}" ] && [ -z "${APT_SECURITY_MIRROR}" ]; } || \
       { [ -z "${APT_MIRROR}" ] && [ -n "${APT_SECURITY_MIRROR}" ]; }; then \
      echo >&2 'APT_MIRROR and APT_SECURITY_MIRROR must be configured together'; \
      exit 2; \
    fi; \
    restore_apt_sources() { \
      if [ -n "${APT_MIRROR}" ]; then \
        rm -rf /etc/apt/sources.list.d; \
        if [ -d /tmp/testbed-sources.list.d ]; then \
          mv /tmp/testbed-sources.list.d /etc/apt/sources.list.d; \
        else \
          mkdir -p /etc/apt/sources.list.d; \
        fi; \
        rm -f /etc/apt/sources.list; \
        if [ -f /tmp/testbed-sources.list ]; then \
          mv /tmp/testbed-sources.list /etc/apt/sources.list; \
        fi; \
      fi; \
    }; \
    if [ -n "${APT_MIRROR}" ]; then \
      if [ -d /etc/apt/sources.list.d ]; then \
        mv /etc/apt/sources.list.d /tmp/testbed-sources.list.d; \
      fi; \
      mkdir -p /etc/apt/sources.list.d; \
      if [ -f /etc/apt/sources.list ]; then \
        mv /etc/apt/sources.list /tmp/testbed-sources.list; \
      fi; \
      printf 'deb %s bookworm main\ndeb %s bookworm-updates main\ndeb %s bookworm-security main\n' \
        "${APT_MIRROR}" "${APT_MIRROR}" "${APT_SECURITY_MIRROR}" \
        > /etc/apt/sources.list.d/testbed-mirror.list; \
      trap restore_apt_sources EXIT HUP INT TERM; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git; \
    rm -rf /var/lib/apt/lists/*; \
    restore_apt_sources; \
    trap - EXIT HUP INT TERM

RUN npm install -g --no-audit --no-fund --registry="${NPM_REGISTRY}" \
      pnpm "@deepseek-ai/dsh@${DSH_VERSION}" \
 && dsh --version \
 && pnpm --version

WORKDIR /work
COPY entrypoint.sh /usr/local/bin/testbed-entrypoint
COPY probes /usr/local/bin/probes
# 对照测试与 fixture 一起进镜像：测试要 source 真正安装的 entrypoint，不能在容器里另写一份。
COPY tests /usr/local/lib/testbed-tests
RUN chmod +x /usr/local/bin/testbed-entrypoint /usr/local/lib/testbed-tests/test-dump-profile.sh \
 && ln -s /usr/local/lib/testbed-tests/test-dump-profile.sh /usr/local/bin/testbed-test-dump-profile

ENTRYPOINT ["/usr/local/bin/testbed-entrypoint"]
