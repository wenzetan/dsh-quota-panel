export declare const name = "quota-panel";
export declare const inject: string[];
/**
 * Connection channel that carries this plugin's RPC methods.
 *
 * DSH mounts every plugin HTTP surface inside the authenticated `/api`
 * channel, whose own route applies the trusted-host + browser-session fence
 * before dispatching. The dedicated prefix `/dsh-quota-panel` this plugin used
 * before DSH 0.1.5 is no longer reachable: `connection.rpc.handle` mounts its
 * route from the *Connection plugin's* fiber, which never holds `webServer`,
 * so `owner.webServer.register` throws and the channel silently disappears.
 */
export declare const RPC_CHANNEL = "/api";
/** Method namespace owned by this plugin under {@link RPC_CHANNEL}. */
export declare const RPC_METHOD_PREFIX = "dsh-quota-panel";
/** RPC endpoints served by the host half. */
export declare const RPC_ENDPOINTS: readonly ["specs", "fetch-all", "chatgpt-auth-status", "chatgpt-login-start", "chatgpt-login-cancel", "chatgpt-logout"];
/** Method name the browser half sends for one endpoint. */
export declare function rpcMethod(endpoint: string): string;
/** Exact Fetch route path Connection serves one endpoint on. */
export declare function rpcRoutePath(endpoint: string): string;
/**
 * Plugin config schema: structure and defaults live here so profile patches
 * can stay minimal; cross-field semantics (id uniqueness, tier ordering,
 * proxy references, catalog override keys) are checked in {@link apply}.
 */
export declare const Config: any;
/**
 * Apply the plugin: normalize config and mount the RPC routes.
 *
 * Route registrations belong to the caller fiber (disposed with it). They ride
 * Connection's exact Fetch registry rather than `connection.rpc.handle`: in DSH
 * 0.1.5+ that channel's disposer resolves `owner.webServer` against the
 * Connection plugin's own fiber, which never holds `webServer`, so a
 * third-party channel throws inside a child fiber and vanishes without a boot
 * error. The Fetch registry needs only `owner.effect`, and the `/api` route that
 * dispatches it already enforces the trusted-host + browser fence.
 * @param ctx - plugin context with connection and credentials services.
 * @param config - raw plugin config (schema-processed by the loader).
 */
export declare function apply(ctx: any, config?: Record<string, any>): void;
