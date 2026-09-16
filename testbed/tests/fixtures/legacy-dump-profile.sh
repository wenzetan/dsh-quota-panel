#!/usr/bin/env bash
# 红例对照入口（只为测试服务，不是产品实现）：拿到真实 entrypoint 的全部定义，
# 再把 dump_profile 换成 HEAD=5c95069 的旧实现（`2>&1` 混流 + 明文子串 grep），
# 用来在宿主快速证明"旧写法会假阳性、新写法不会"，不必起 Docker。
set -uo pipefail
eval "$(bash "$(dirname "${BASH_SOURCE[0]}")/legacy-dump-profile.body.sh")"
