// ==========================================================================
// Guardian Protocol — Custom Error Classes
// ==========================================================================
//
// Structured errors with machine-readable codes allow calling agents to
// programmatically handle failures. An agent receiving CONFIG_MISSING
// knows to check its keyring; an agent receiving TOKEN_NOT_FOUND knows
// the contract address might be wrong — without parsing error messages.
// ==========================================================================

/**
 * Machine-readable error codes for Guardian Protocol.
 * Calling agents can switch on these to decide recovery strategies.
 */
export enum ErrorCode {
  // Configuration / credential errors
  CONFIG_MISSING = "GUARDIAN_CONFIG_MISSING",

  // OKX API errors
  OKX_API_ERROR = "OKX_API_ERROR",
  OKX_API_TIMEOUT = "OKX_API_TIMEOUT",

  // Analysis errors
  TOKEN_NOT_FOUND = "TOKEN_NOT_FOUND",
  SIMULATION_FAILED = "SIMULATION_FAILED",
  ANALYZER_ERROR = "ANALYZER_ERROR",

  // Scoring errors
  SCORING_ERROR = "SCORING_ERROR",

  // General
  UNEXPECTED_ERROR = "UNEXPECTED_ERROR",
}

/**
 * Base error class for all Guardian Protocol errors.
 *
 * Every error carries:
 *   - `code`    — a machine-readable enum for programmatic handling
 *   - `message` — a human-readable explanation
 *   - `context` — optional structured metadata for debugging
 */
export class GuardianError extends Error {
  public readonly code: ErrorCode;
  public readonly context?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GuardianError";
    this.code = code;
    this.context = context;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Serialize to a JSON-safe object for structured logging
   * or for inclusion in the Guardian API response.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}
