/**
 * Typed sandbox failures. Messages are fixed and user-safe: no provider text, keys or URLs.
 * `code` is what the API and UI show; the walkthrough checks these exact codes.
 */
export type SandboxErrorCode =
  | 'sandbox_spend_cap_reached'
  | 'sandbox_spend_ledger_unavailable'
  | 'sandbox_limit_reached'
  | 'sandbox_create_failed'
  | 'sandbox_create_timeout'
  | 'sandbox_egress_invalid'
  | 'sandbox_egress_unverified'
  | 'sandbox_resources_exceeded'
  | 'sandbox_command_timeout'
  | 'sandbox_gone'
  | 'sandbox_unknown'

const MESSAGES: Record<SandboxErrorCode, string> = {
  sandbox_spend_cap_reached: 'Sandbox spend cap reached; no sandbox was started.',
  sandbox_spend_ledger_unavailable: 'Sandbox spend ledger is unavailable; no sandbox was started.',
  sandbox_limit_reached: 'Too many sandboxes are running; close one and try again.',
  sandbox_create_failed: 'The sandbox could not be started.',
  sandbox_create_timeout: 'The sandbox did not start in time.',
  sandbox_egress_invalid: 'The egress allowlist is invalid.',
  sandbox_egress_unverified: 'The sandbox network policy could not be verified; the sandbox was stopped.',
  sandbox_resources_exceeded: 'The sandbox is larger than the configured size; it was stopped.',
  sandbox_command_timeout: 'The command did not finish in time.',
  sandbox_gone: 'The sandbox has stopped (timed out or was removed).',
  sandbox_unknown: 'Unknown sandbox.',
}

/** HTTP status the API answers with for each code. */
export const SANDBOX_ERROR_STATUS: Record<SandboxErrorCode, number> = {
  sandbox_spend_cap_reached: 402,
  sandbox_spend_ledger_unavailable: 503,
  sandbox_limit_reached: 429,
  sandbox_create_failed: 503,
  sandbox_create_timeout: 504,
  sandbox_egress_invalid: 400,
  sandbox_egress_unverified: 503,
  sandbox_resources_exceeded: 503,
  sandbox_command_timeout: 504,
  sandbox_gone: 410,
  sandbox_unknown: 404,
}

export class SandboxError extends Error {
  constructor(readonly code: SandboxErrorCode, readonly detail?: string) {
    super(detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code])
    this.name = 'SandboxError'
  }
}
