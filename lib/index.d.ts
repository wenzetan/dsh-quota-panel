export declare const name = "quota-panel";
export declare const inject: string[];
/** Loopback-only Connection RPC channel this plugin owns. */
export declare const RPC_CHANNEL = "/dsh-quota-panel";
/**
 * Plugin config schema: structure and defaults live here so profile patches
 * can stay minimal; cross-field semantics (id uniqueness, tier ordering,
 * proxy references, catalog override keys) are checked in {@link apply}.
 */
export declare const Config: any;
/**
 * Apply the plugin: normalize config and own the loopback RPC channel.
 * Channel registrations belong to the caller fiber (disposed with it), so no
 * explicit effect wrapper is needed.
 * @param ctx - plugin context with connection and credentials services.
 * @param config - raw plugin config (schema-processed by the loader).
 */
export declare function apply(ctx: any, config?: Record<string, any>): void;
