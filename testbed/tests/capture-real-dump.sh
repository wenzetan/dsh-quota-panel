#!/usr/bin/env bash
# 重新生成 tests/fixtures/real-dump-sample.txt：把本插件真实装进 minimal profile，
# 再从 `dsh --profile web --dump-config` 的 stdout 取尾部（含插件行）。
#
# 需要 Docker 与 compose（会重跑 l1+pack+profile，约 1-2 分钟）。默认只打印，
# 用 `> tests/fixtures/real-dump-sample.txt` 覆盖样本文件：
#
#   tests/capture-real-dump.sh > tests/fixtures/real-dump-sample.txt
#
# 采样范围 470-545 是 dsh 0.1.5-rc.1 上该 dump 的尾部（共 545 行，插件行在 540-545）；
# 换 dsh 版本后行号会漂移，脚本会按实际行数取"最后 10 行必含插件行"的窗口。
set -euo pipefail

cd "$(dirname "$0")/.."
export DOCKER_CONFIG="$PWD/.docker-config"

docker compose run --rm --build --entrypoint bash testbed -lc '
set -e
STEPS=assert,seed,stage,l1,pack,profile /usr/local/bin/testbed-entrypoint >/dev/null 2>&1
total=$(wc -l < /work/dump-config.txt)
start=$((total - 75))
printf "%s\n" \
  "# 真实样本：dsh ${DSH_VERSION} + dsh-quota-panel 装入 minimal profile 后 --dump-config 的第 ${start}-${total} 行" \
  "# 重新生成：tests/capture-real-dump.sh（会重跑 pack+profile）"
sed -n "${start},${total}p" /work/dump-config.txt
' 2>/dev/null
