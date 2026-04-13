// ==========================================================================
// Guardian Protocol — Structured Logger
// ==========================================================================
//
// A lightweight structured logger that outputs JSON lines. Agents and
// observability tools (Datadog, Grafana, etc.) can parse these directly.
//
// Log levels are controlled by the GUARDIAN_LOG_LEVEL env var:
//   debug | info | warn | error
//
// WHY JSON LOGGING:
// When Guardian Protocol runs inside an agent loop, structured logs let
// the orchestrating agent (or a human operator) filter by analyzer name,
// token address, or evaluation ID — impossible with plain text logs.
// ==========================================================================

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Resolves the configured minimum log level from environment.
 */
function getMinLevel(): LogLevel {
  const env = process.env["GUARDIAN_LOG_LEVEL"]?.toLowerCase();
  if (env && env in LOG_LEVEL_PRIORITY) return env as LogLevel;
  return "info"; // sensible default
}

/**
 * Emits a structured JSON log line to stdout/stderr.
 */
function emit(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  const minLevel = getMinLevel();
  if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[minLevel]) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: "guardian-protocol",
    message,
    ...data,
  };

  const line = JSON.stringify(entry);

  // ALL logs go to stderr so stdout stays clean for machine-readable output.
  // This is critical for the CLI: agents pipe stdout into JSON.parse().
  process.stderr.write(line + "\n");
}

/**
 * Public logger interface used throughout Guardian Protocol.
 */
export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) =>
    emit("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) =>
    emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) =>
    emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) =>
    emit("error", msg, data),
};
