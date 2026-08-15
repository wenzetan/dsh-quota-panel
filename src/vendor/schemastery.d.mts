/**
 * Type surface for the vendored schemastery.mjs (MIT, shigma). The runtime
 * file sits next to this declaration and is copied into lib/vendor/ by
 * scripts/build.mjs; typing it as a loose schema factory keeps the host
 * bundle's types honest without re-declaring the whole library.
 */
declare const z: any;
export default z;