#!/usr/bin/env bash
# 真实 L2 探针：只编排 dsh/curl；boot 与 RPC JSON 语义统一委托 rpc-contract.mjs。
set -euo pipefail
umask 077

PORT="${PORT:-3080}"
WORK_DIR="${WORK_DIR:-/work}"
LOG="${LOG:-$WORK_DIR/dsh-web.log}"
COOKIE="${COOKIE:-$WORK_DIR/dsh-cookies.txt}"
AUTH_BODY="${AUTH_BODY:-$WORK_DIR/auth-body.txt}"
BOOT_HTML="${BOOT_HTML:-$WORK_DIR/boot.html}"
CLIENT_BODY="${CLIENT_BODY:-$WORK_DIR/quota-client.js}"
SPECS_BODY="${SPECS_BODY:-$WORK_DIR/specs-body.json}"
CONTRACT_JSON="${CONTRACT_JSON:-$WORK_DIR/rpc-contract.json}"
PLUGIN_DIR="${PLUGIN_DIR:-/work/plugin}"
CONTRACT_HELPER="${CONTRACT_HELPER:-/usr/local/bin/probes/rpc-contract.mjs}"
RPC_ID="${RPC_ID:-testbed-probe}"
EXPECTED_REFRESH_MS="${EXPECTED_REFRESH_MS:-60000}"
L2_DEADLINE_SECONDS="${L2_DEADLINE_SECONDS:-90}"
L2_POLL_SECONDS="${L2_POLL_SECONDS:-1}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-2}"
CURL_MAX_TIME="${CURL_MAX_TIME:-5}"
FAIL_LOG_LINES="${FAIL_LOG_LINES:-40}"
TAG="[testbed][${DSH_VERSION:-unknown}][${GRID_LABEL:-local}][l2]"
WEB_PID=""
LAST_CODE="none"
LAST_CURL_RC=0
SECONDS=0
DEADLINE="$L2_DEADLINE_SECONDS"

say() { printf '%s %s\n' "$TAG" "$1"; }

cleanup() {
	local rc="$1"
	trap - EXIT HUP INT TERM
	if [ -n "$WEB_PID" ] && kill -0 "$WEB_PID" 2>/dev/null; then
		kill "$WEB_PID" 2>/dev/null || true
	fi
	if [ -n "$WEB_PID" ]; then
		# Teardown has a fixed 0.5s grace after the work deadline; it never waits unbounded.
		for _ in $(seq 1 10); do
			kill -0 "$WEB_PID" 2>/dev/null || break
			sleep 0.05
		done
		if kill -0 "$WEB_PID" 2>/dev/null; then
			kill -KILL "$WEB_PID" 2>/dev/null || true
		fi
		wait "$WEB_PID" 2>/dev/null || true
	fi
	rm -f "$COOKIE" "$AUTH_BODY" "$BOOT_HTML" "$CLIENT_BODY" "$SPECS_BODY" "$CONTRACT_JSON"
	exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'cleanup 129' HUP
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

redacted_log_tail() {
	local remaining
	[ -f "$LOG" ] || return 0
	remaining="$(remaining_seconds 2>/dev/null || true)"
	[ -n "$remaining" ] || remaining=1
	tail -n "$FAIL_LOG_LINES" "$LOG" | timeout --signal=KILL "${remaining}s" node "$CONTRACT_HELPER" redact-log - || true
}

die() {
	say "[fail] $1"
	redacted_log_tail
	exit 1
}

remaining_seconds() {
	local remaining=$(( DEADLINE - SECONDS ))
	[ "$remaining" -gt 0 ] || return 1
	printf '%s\n' "$remaining"
}

run_with_budget() {
	local remaining
	remaining="$(remaining_seconds)" || return 124
	timeout --foreground --signal=TERM --kill-after=2 "${remaining}s" "$@"
}

curl_code() {
	local output rc remaining max_time
	remaining="$(remaining_seconds)" || { LAST_CURL_RC=124; LAST_CODE=000; return 1; }
	max_time="$CURL_MAX_TIME"
	if awk -v configured="$CURL_MAX_TIME" -v remaining="$remaining" 'BEGIN { exit !(configured > remaining) }'; then
		max_time="$remaining"
	fi
	set +e
	output="$(curl --silent --show-error \
		--connect-timeout "$CURL_CONNECT_TIMEOUT" \
		--max-time "$max_time" \
		--output "$1" --write-out '%{http_code}' "${@:2}" 2>/dev/null)"
	rc=$?
	set -e
	LAST_CURL_RC=$rc
	LAST_CODE="${output:-000}"
	[ "$rc" -eq 0 ]
}

expired() { [ "$SECONDS" -ge "$1" ]; }
web_alive() { kill -0 "$WEB_PID" 2>/dev/null; }
budget_sleep() {
	local remaining
	remaining="$(remaining_seconds)" || return 124
	awk -v pause="$L2_POLL_SECONDS" -v remaining="$remaining" 'BEGIN { exit !(pause >= remaining) }' && return 124
	sleep "$L2_POLL_SECONDS"
}
has_cookie_record() {
	awk -F '\t' '
		/^#HttpOnly_/ { if (NF >= 7) found = 1; next }
		!/^#/ && NF >= 7 { found = 1 }
		END { exit found ? 0 : 1 }
	' "$1"
}

mkdir -p "$WORK_DIR"
rm -f "$COOKIE" "$AUTH_BODY" "$BOOT_HTML" "$CLIENT_BODY" "$SPECS_BODY" "$CONTRACT_JSON"

set +e
run_with_budget node "$CONTRACT_HELPER" contract "$PLUGIN_DIR" > "$CONTRACT_JSON"
contract_rc=$?
set -e
case "$contract_rc" in
	0) ;;
	124) die "全流程截止时间耗尽（dynamic contract）" ;;
	*) die "无法从插件导出动态 specs 契约" ;;
esac
set +e
ROUTE="$(run_with_budget node -e '
	const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
	if (typeof value.route !== "string" || typeof value.method !== "string") process.exit(1)
	process.stdout.write(value.route)
' "$CONTRACT_JSON")"
route_rc=$?
set -e
case "$route_rc" in
	0) ;;
	124) die "全流程截止时间耗尽（读取 specs route）" ;;
	*) die "动态 specs route 无效" ;;
esac
set +e
METHOD="$(run_with_budget node -e '
	const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
	if (typeof value.route !== "string" || typeof value.method !== "string") process.exit(1)
	process.stdout.write(value.method)
' "$CONTRACT_JSON")"
method_rc=$?
set -e
case "$method_rc" in
	0) ;;
	124) die "全流程截止时间耗尽（读取 specs method）" ;;
	*) die "动态 specs method 无效" ;;
esac
[ "$ROUTE" = '/api/dsh-quota-panel/specs' ] && [ "$METHOD" = 'dsh-quota-panel/specs' ] \
	|| die "动态 specs contract 不符"
say "动态 specs 契约已加载"

dsh web --no-open > "$LOG" 2>&1 &
WEB_PID=$!

TOKEN=""
while ! expired "$DEADLINE"; do
	web_alive || die "dsh web 启动过程中退出"
	TOKEN="$(grep -oE 'token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | head -1 | cut -d= -f2 || true)"
	[ -z "$TOKEN" ] || break
	budget_sleep || die "全流程截止时间耗尽（等待启动 token）"
done
[ -n "$TOKEN" ] || die "截止时间内未取得启动 token"

if ! curl_code "$AUTH_BODY" --location --cookie-jar "$COOKIE" --cookie "$COOKIE" \
	--write-out $'%{http_code}\t%{url_effective}' \
	"http://127.0.0.1:${PORT}/?token=${TOKEN}"; then
	die "token 换 cookie 的 curl 失败（rc=$LAST_CURL_RC，HTTP ${LAST_CODE%%$'\t'*}）"
fi
AUTH_CODE="${LAST_CODE%%$'\t'*}"
AUTH_EFFECTIVE="${LAST_CODE#*$'\t'}"
[ "$AUTH_CODE" = 200 ] || die "token 换 cookie 返回 HTTP $AUTH_CODE"
[ "$AUTH_EFFECTIVE" = "http://127.0.0.1:${PORT}/" ] || die "认证重定向目标不符"
[ -s "$COOKIE" ] && has_cookie_record "$COOKIE" || die "启动 token 未建立 session cookie record"
unset TOKEN
say "启动 token 与 session cookie 均已取得"

while ! expired "$DEADLINE"; do
	web_alive || die "dsh web 在首页就绪前退出"
	if curl_code "$BOOT_HTML" --cookie "$COOKIE" "http://127.0.0.1:${PORT}/"; then
		[ "$LAST_CODE" = 200 ] && break
	elif [ "$LAST_CURL_RC" -eq 7 ]; then
		:
	elif [ "$LAST_CURL_RC" -eq 28 ]; then
		die "首页 curl 总超时（rc=28）"
	else
		die "首页 curl 失败（rc=$LAST_CURL_RC，HTTP $LAST_CODE）"
	fi
	budget_sleep || die "全流程截止时间耗尽（等待首页）"
done
if [ "$LAST_CURL_RC" -ne 0 ]; then
	die "首页连接失败（curl rc=$LAST_CURL_RC，HTTP $LAST_CODE）"
fi
case "$LAST_CODE" in
	200) ;;
	401|403) die "首页认证被拒绝（HTTP $LAST_CODE）" ;;
	*) die "首页未就绪（最后 HTTP $LAST_CODE）" ;;
esac
say "认证首页 HTTP 200"
web_alive || die "dsh web 在客户端阶段前退出"

set +e
CLIENT_URL="$(run_with_budget node "$CONTRACT_HELPER" client-url "$BOOT_HTML")"
client_helper_rc=$?
set -e
case "$client_helper_rc" in
	0) ;;
	124) die "全流程截止时间耗尽（解析 boot client URL）" ;;
	*) die "真实 boot payload 未广告 revisioned quota client URL" ;;
esac
web_alive || die "dsh web 在客户端 GET 前退出"
if ! curl_code "$CLIENT_BODY" --cookie "$COOKIE" "http://127.0.0.1:${PORT}${CLIENT_URL}"; then
	die "客户端 bundle curl 失败（rc=$LAST_CURL_RC，HTTP $LAST_CODE）"
fi
web_alive || die "dsh web 在客户端 GET 后退出"
case "$LAST_CODE" in
	200) ;;
	401|403) die "客户端 bundle 认证被拒绝（HTTP $LAST_CODE）" ;;
	*) die "boot 广告的客户端 bundle 非 200（HTTP $LAST_CODE）" ;;
esac
say "boot 广告的 revisioned quota client 已实际 GET 200"
web_alive || die "dsh web 在 specs 阶段前退出"

set +e
REQUEST_BODY="$(run_with_budget node -e '
	process.stdout.write(JSON.stringify({
		type: "client-request",
		rpcId: process.argv[1],
		method: process.argv[2],
		payload: null,
	}))
' "$RPC_ID" "$METHOD")"
request_rc=$?
set -e
case "$request_rc" in
	0) ;;
	124) die "全流程截止时间耗尽（构造 specs 请求）" ;;
	*) die "无法构造 specs 请求" ;;
esac
web_alive || die "dsh web 在 specs POST 前退出"
if ! curl_code "$SPECS_BODY" --cookie "$COOKIE" --request POST \
	--header 'content-type: application/json' --data "$REQUEST_BODY" \
	"http://127.0.0.1:${PORT}${ROUTE}"; then
	die "specs curl 失败（rc=$LAST_CURL_RC，HTTP $LAST_CODE）"
fi
web_alive || die "dsh web 在 specs 响应后退出"
case "$LAST_CODE" in
	200) ;;
	404|405) web_alive || die "dsh web 在 specs 路由缺失分类前退出"; die "specs 路由缺失（HTTP $LAST_CODE）" ;;
	401|403) die "specs /api 会话认证被拒绝（HTTP $LAST_CODE）" ;;
	*) die "specs RPC 非预期 HTTP $LAST_CODE" ;;
esac
set +e
SUMMARY="$(run_with_budget node "$CONTRACT_HELPER" validate-specs "$SPECS_BODY" "$RPC_ID" "$EXPECTED_REFRESH_MS")"
validate_rc=$?
set -e
case "$validate_rc" in
	0) ;;
	124) die "全流程截止时间耗尽（校验 specs 响应）" ;;
	*) die "specs 响应未通过现有契约 helper 校验" ;;
esac
web_alive || die "dsh web 在 specs 契约校验后退出"
say "$SUMMARY"

if grep -qE 'plugin tree failed to load|without inject' "$LOG"; then
	die "日志出现插件加载失败特征"
fi
say "日志卫生通过"
say "L2 全部通过"
