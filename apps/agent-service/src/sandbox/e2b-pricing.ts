import { NANO_PER_USD } from '../lib/file-spend-ledger'

/**
 * E2B usage rates, read 2026-11-10 from https://e2b.dev/pricing (published usage rates):
 * $0.000014 per vCPU-second and $0.0000045 per GiB-second, billed per second while running.
 * Kept as integer nano-dollars so ledger sums never drift. Changing them is a code review.
 */
export const E2B_NANO_USD_PER_VCPU_SECOND = 14_000
export const E2B_NANO_USD_PER_GIB_SECOND = 4_500
export const E2B_RATES_CHECKED = '2026-11-10'

/** Highest sandbox-time cap this service accepts from configuration. */
export const HARD_MAX_SANDBOX_CAP_USD = 10

export interface SandboxResources {
  cpuCount: number
  memoryMB: number
}

/** Nano-dollars per running second for a sandbox of this size (rounded up). */
export function nanoUsdPerSecond(r: SandboxResources): number {
  return r.cpuCount * E2B_NANO_USD_PER_VCPU_SECOND + Math.ceil((r.memoryMB * E2B_NANO_USD_PER_GIB_SECOND) / 1024)
}

/** Cost of `seconds` of runtime, rounded up to whole seconds (E2B bills per second). */
export function sandboxCostNanoUsd(r: SandboxResources, seconds: number): number {
  return nanoUsdPerSecond(r) * Math.max(0, Math.ceil(seconds))
}

export const nanoToUsd = (nano: number): number => nano / NANO_PER_USD
