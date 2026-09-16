#!/usr/bin/env bash
# 真实 L2 探针：只编排 dsh/curl；boot 与 RPC JSON 语义统一委托 rpc-contract.mjs。
set -euo pipefail

PORT="${PORT:-3080}"
WORK_DIR="${WORK_DIR:-/work}"
LOG="${LOG:-$WORK_DIR/dsh-web.log}"
COOKIE="${COOKIE:-$WORK_DIR/dsh-cookies.txt}"
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

say() { printf '%s %s\n' "$TAG" "$1"; }

cleanup() {
	local rc=$?
	trap - EXIT HUP INT TERM
	if [ -n "$WEB_PID" ] && kill -0 "$WEB_PID" 2>/dev/null; then
		kill "$WEB_PID" 2>/dev/null || true
	fi
	if [ -n "$WEB_PID" ]; then
		wait "$WEB_PID" 2>/dev/null || true
	fi
	exit "$rc"
}
trap cleanup EXIT HUP INT TERM

redacted_log_tail() {
	[ -f "$LOG" ] || return 0
	tail -n "$FAIL_LOG_LINES" "$LOG" | node "$CONTRACT_HELPER" redact-log - || true
}

die() {
	say "[fail] $1"
	redacted_log_tail
	exit 1
}

curl_code() {
	local output rc
	set +e
	output="$(curl --silent --show-error \
		--connect-timeout "$CURL_CONNECT_TIMEOUT" \
		--max-time "$CURL_MAX_TIME" \
		--output "$1" --write-out '%{http_code}' "${@:2}" 2>/dev/null)"
	rc=$?
	set -e
	LAST_CURL_RC=$rc
	LAST_CODE="${output:-000}"
	[ "$rc" -eq 0 ]
}

now_seconds() { date +%s; }
expired() { [ "$(now_seconds)" -ge "$1" ]; }
web_alive() { kill -0 "$WEB_PID" 2>/dev/null; }

mkdir -p "$WORK_DIR"
rm -f "$COOKIE" "$BOOT_HTML" "$CLIENT_BODY" "$SPECS_BODY" "$CONTRACT_JSON"

node "$CONTRACT_HELPER" contract "$PLUGIN_DIR" > "$CONTRACT_JSON" \
	|| die "无法从插件导出动态 specs 契约"
ROUTE="$(node -e '
	const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
	if (typeof value.route !== "string" || typeof value.method !== "string") process.exit(1)
	process.stdout.write(value.route)
' "$CONTRACT_JSON")" || die "动态 specs route 无效"
METHOD="$(node -e '
	const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
	if (typeof value.route !== "string" || typeof value.method !== "string") process.exit(1)
	process.stdout.write(value.method)
' "$CONTRACT_JSON")" || die "动态 specs method 无效"
say "动态 specs 契约已加载"

dsh web --no-open > "$LOG" 2>&1 &
WEB_PID=$!
DEADLINE=$(( $(now_seconds) + L2_DEADLINE_SECONDS ))

TOKEN=""
while ! expired "$DEADLINE"; do
	web_alive || die "dsh web 启动过程中退出"
	TOKEN="$(grep -oE 'token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | head -1 | cut -d= -f2 || true)"
	[ -z "$TOKEN" ] || break
	sleep "$L2_POLL_SECONDS"
done
[ -n "$TOKEN" ] || die "截止时间内未取得启动 token"

AUTH_BODY="$WORK_DIR/auth-body.txt"
if ! curl_code "$AUTH_BODY" --location --cookie-jar "$COOKIE" --cookie "$COOKIE" \
	"http://127.0.0.1:${PORT}/?token=${TOKEN}"; then
	die "token 换 cookie 的 curl 失败（rc=$LAST_CURL_RC，HTTP $LAST_CODE）"
fi
[ "$LAST_CODE" = 200 ] || die "token 换 cookie 返回 HTTP $LAST_CODE"
[ -s "$COOKIE" ] || die "启动 token 未建立 session cookie"
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
	sleep "$L2_POLL_SECONDS"
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

CLIENT_URL="$(node "$CONTRACT_HELPER" client-url "$BOOT_HTML")" \
	|| die "真实 boot payload 未广告 revisioned quota client URL"
if ! curl_code "$CLIENT_BODY" --cookie "$COOKIE" "http://127.0.0.1:${PORT}${CLIENT_URL}"; then
	die "客户端 bundle curl 失败（rc=$LAST_CURL_RC，HTTP $LAST_CODE）"
fi
case "$LAST_CODE" in
	200) ;;
	401|403) die "客户端 bundle 认证被拒绝（HTTP $LAST_CODE）" ;;
	*) die "boot 广告的客户端 bundle 非 200（HTTP $LAST_CODE）" ;;
esac
say "boot 广告的 revisioned quota client 已实际 GET 200"

REQUEST_BODY="$(node -e '
	process.stdout.write(JSON.stringify({
		type: "client-request",
		rpcId: process.argv[1],
		method: process.argv[2],
		payload: null,
	}))
' "$RPC_ID" "$METHOD")"
if ! curl_code "$SPECS_BODY" --cookie "$COOKIE" --request POST \
	--header 'content-type: application/json' --data "$REQUEST_BODY" \
	"http://127.0.0.1:${PORT}${ROUTE}"; then
	die "specs curl 失败（rc=$LAST_CURL_RC，HTTP $LAST_CODE）"
fi
case "$LAST_CODE" in
	200) ;;
	404|405) die "specs 路由缺失（HTTP $LAST_CODE）" ;;
	401|403) die "specs /api 会话认证被拒绝（HTTP $LAST_CODE）" ;;
	*) die "specs RPC 非预期 HTTP $LAST_CODE" ;;
esac
if ! SUMMARY="$(node "$CONTRACT_HELPER" validate-specs "$SPECS_BODY" "$RPC_ID" "$EXPECTED_REFRESH_MS")"; then
	die "specs 响应未通过现有契约 helper 校验"
fi
say "$SUMMARY"

if grep -qE 'plugin tree failed to load|without inject' "$LOG"; then
	die "日志出现插件加载失败特征"
fi
say "日志卫生通过"
say "L2 全部通过"
