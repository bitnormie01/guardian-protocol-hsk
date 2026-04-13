// ==========================================================================
// Guardian Protocol — Hex / ABI Encoding Helpers
// ==========================================================================
//
// Utility functions for working with hex-encoded data.
// Used by several modules for tx data manipulation.
// ==========================================================================

import type { HexString } from "../types/input.js";

/**
 * Validates that a string is a valid hex-encoded string (0x-prefixed).
 */
export function isValidHex(value: string): value is HexString {
  return /^0x[0-9a-fA-F]*$/.test(value);
}

/**
 * Extracts the 4-byte function selector from calldata.
 * Returns null if the data is too short.
 */
export function extractFunctionSelector(data: HexString): HexString | null {
  // Minimum: 0x + 8 hex chars (4 bytes)
  if (data.length < 10) return null;
  return data.slice(0, 10) as HexString;
}

/**
 * Pads a hex value to a given byte length (left-padded with zeros).
 */
export function padHex(value: string, byteLength: number): HexString {
  const stripped = value.startsWith("0x") ? value.slice(2) : value;
  const padded = stripped.padStart(byteLength * 2, "0");
  return `0x${padded}` as HexString;
}

/**
 * Validates that a string looks like an Ethereum address.
 */
export function isValidAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
