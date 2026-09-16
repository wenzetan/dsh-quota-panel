#!/usr/bin/env bash
# 用例：真实 dump 样本。桩 dsh 直接把 fixture 原文写 stdout（= 真实 --dump-config 的 stdout），
# 不经过任何二次加工，因此正例校验的就是真实样本本身。
set -uo pipefail
cat "${FIXTURE:?FIXTURE 未设置}"
