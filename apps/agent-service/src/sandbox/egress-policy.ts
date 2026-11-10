import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { SandboxError } from './errors'

/**
 * Egress policy for E2B SDK 2.x network rules (docs: e2b.dev/docs/sandbox/internet-access).
 *
 * - Empty allowlist: `allowInternetAccess: false` (= denyOut 0.0.0.0/0). No outbound traffic.
 * - Non-empty: `denyOut: [0.0.0.0/0]`, `allowOut: <exact hostnames>`, `dnsServers: []`.
 *   E2B matches HTTP Host (port 80) and TLS SNI (port 443) by name and connects for us, so no
 *   DNS server is opened at all (a reachable resolver would be an exfiltration channel). Names
 *   resolve inside the sandbox through pinned /etc/hosts lines instead.
 * Wildcards, IP literals and CIDRs are refused: every allowed destination is an exact name a
 * reviewer can read. E2B allows at most 10 domains per sandbox.
 */
export const ALL_TRAFFIC = '0.0.0.0/0'
export const MAX_EGRESS_DOMAINS = 10
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function normalizeEgressAllowlist(domains: readonly string[]): string[] {
  const out = new Set<string>()
  for (const raw of domains) {
    const d = raw.trim().toLowerCase().replace(/\.$/, '')
    if (!d) continue
    if (d.includes('*') || isIP(d) || d.includes('/') || !HOSTNAME.test(d)) {
      throw new SandboxError('sandbox_egress_invalid', `not an exact hostname: ${JSON.stringify(raw.slice(0, 64))}`)
    }
    out.add(d)
  }
  if (out.size > MAX_EGRESS_DOMAINS) throw new SandboxError('sandbox_egress_invalid', `at most ${MAX_EGRESS_DOMAINS} domains`)
  return [...out].sort()
}

export type E2BNetworkCreate =
  | { allowInternetAccess: false }
  | { allowInternetAccess: true; network: { denyOut: string[]; allowOut: string[]; dnsServers: string[] } }

/** Options for Sandbox.create. */
export function networkCreateOptions(domains: string[]): E2BNetworkCreate {
  if (domains.length === 0) return { allowInternetAccess: false }
  return { allowInternetAccess: true, network: { denyOut: [ALL_TRAFFIC], allowOut: [...domains], dnsServers: [] } }
}

/** Payload for sandbox.updateNetwork (replaces every rule; omitted fields reset to defaults). */
export function networkUpdate(domains: string[]): { allowInternetAccess?: boolean; denyOut?: string[]; allowOut?: string[]; dnsServers?: string[] } {
  if (domains.length === 0) return { allowInternetAccess: false, denyOut: [ALL_TRAFFIC], dnsServers: [] }
  return { denyOut: [ALL_TRAFFIC], allowOut: [...domains], dnsServers: [] }
}

export interface NetworkInfoLike {
  allowInternetAccess?: boolean | null
  network?: { allowOut?: string[]; denyOut?: string[]; dnsServers?: string[] }
}

/**
 * Read-back check of what E2B reports for the running sandbox. Anything other than exactly the
 * requested policy (all traffic denied, only these names allowed, no DNS server) is a failure.
 */
export function networkMatches(info: NetworkInfoLike, domains: string[]): boolean {
  const deny = info.network?.denyOut ?? []
  const allow = [...(info.network?.allowOut ?? [])].map((d) => d.toLowerCase()).sort()
  if (domains.length === 0) {
    return (info.allowInternetAccess === false || deny.includes(ALL_TRAFFIC)) && allow.length === 0
  }
  const dns = info.network?.dnsServers
  return (
    deny.includes(ALL_TRAFFIC) &&
    allow.length === domains.length &&
    allow.every((d, i) => d === domains[i]) &&
    Array.isArray(dns) &&
    dns.length === 0
  )
}

const PRIVATE_V4: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
  [0xac100000, 12], [0xc0000000, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 3],
]
export function isPublicIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false
  const n = ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
  return !PRIVATE_V4.some(([base, bits]) => (n & (~0 << (32 - bits)) >>> 0) >>> 0 === base)
}

export type Resolver = (hostname: string) => Promise<string>

/** Control-plane resolution: one public IPv4 per allowed name, or a typed failure. */
export const resolvePublicIPv4: Resolver = async (hostname) => {
  let address: string
  try {
    ;({ address } = await lookup(hostname, { family: 4 }))
  } catch {
    throw new SandboxError('sandbox_egress_invalid', `cannot resolve ${hostname}`)
  }
  if (!isPublicIPv4(address)) throw new SandboxError('sandbox_egress_invalid', `${hostname} resolves to a non-public address`)
  return address
}

/** /etc/hosts lines for the allowed names. Inputs are already validated hostnames and IPs. */
export async function hostsBlock(domains: string[], resolve: Resolver): Promise<string> {
  const lines = ['# forge egress pins (E2B routes by Host/SNI; no DNS server is reachable)']
  for (const d of domains) lines.push(`${await resolve(d)} ${d}`)
  return `${lines.join('\n')}\n`
}

/**
 * Root shell script (fixed text, no interpolation) that restores the pristine hosts file,
 * appends the pin block staged at /tmp/forge-egress-hosts, and empties resolv.conf so blocked
 * lookups fail at once instead of waiting 20-40 s on the unreachable default resolver.
 */
export const APPLY_HOSTS_SCRIPT =
  "sh -c '[ -f /etc/hosts.forge-base ] || cp /etc/hosts /etc/hosts.forge-base; " +
  'cp /etc/hosts.forge-base /etc/hosts; ' +
  '[ -f /tmp/forge-egress-hosts ] && cat /tmp/forge-egress-hosts >> /etc/hosts; ' +
  "rm -f /tmp/forge-egress-hosts; : > /etc/resolv.conf'"
