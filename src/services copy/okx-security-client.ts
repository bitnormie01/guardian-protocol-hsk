// ==========================================================================
// Guardian Protocol — BACKWARD COMPATIBILITY SHIM
// ==========================================================================
//
// This file re-exports the GoPlusSecurityClient so that existing imports
// throughout the codebase continue to work.
//
// The canonical module is now ./goplus-security-client.ts.
// ==========================================================================

export { GoPlusSecurityClient } from "./goplus-security-client.js";
