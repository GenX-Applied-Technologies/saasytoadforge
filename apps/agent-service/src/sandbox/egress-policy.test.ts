import { describe, expect, it } from 'vitest'
import {
  APPLY_HOSTS_SCRIPT, hostsBlock, isPublicIPv4, networkCreateOptions, networkMatches, networkUpdate, normalizeEgressAllowlist,
} from './egress-policy'
import { nanoUsdPerSecond, sandboxCostNanoUsd } from './e2b-pricing'
import { forgeTemplate, FORGE_TEMPLATE_VERSIONS } from './e2b-template'
import { Template } from 'e2b'

describe('egress allowlist validation', () => {
  it('normalizes case, trailing dots and duplicates, and sorts', () => {
    expect(normalizeEgressAllowlist([' Registry.NPMJS.org. ', 'registry.npmjs.org', 'a.example.com', ''])).toEqual(['a.example.com', 'registry.npmjs.org'])
  })
  it.each([['*.example.com'], ['*'], ['1.1.1.1'], ['::1'], ['10.0.0.0/8'], ['localhost'], ['exa mple.com'], ['-bad.com'], ['a..b.com'], ['x.123']])(
    'refuses %s', (bad) => expect(() => normalizeEgressAllowlist([bad])).toThrow(/egress allowlist is invalid/),
  )
  it('refuses more than 10 domains (E2B limit)', () => {
    expect(() => normalizeEgressAllowlist(Array.from({ length: 11 }, (_, i) => `h${i}.example.com`))).toThrow(/at most 10/)
  })
})

describe('E2B network options', () => {
  it('empty list means no internet at all', () => {
    expect(networkCreateOptions([])).toEqual({ allowInternetAccess: false })
    expect(networkUpdate([])).toEqual({ allowInternetAccess: false, denyOut: ['0.0.0.0/0'], dnsServers: [] })
  })
  it('a list means deny all, allow exact names, no DNS server', () => {
    expect(networkCreateOptions(['registry.npmjs.org'])).toEqual({
      allowInternetAccess: true, network: { denyOut: ['0.0.0.0/0'], allowOut: ['registry.npmjs.org'], dnsServers: [] },
    })
    expect(networkUpdate(['registry.npmjs.org'])).toEqual({ denyOut: ['0.0.0.0/0'], allowOut: ['registry.npmjs.org'], dnsServers: [] })
  })
  it('read-back check accepts only the exact policy', () => {
    const d = ['registry.npmjs.org']
    expect(networkMatches({ network: { allowOut: d, denyOut: ['0.0.0.0/0'], dnsServers: [] } }, d)).toBe(true)
    expect(networkMatches({ network: { allowOut: d, denyOut: ['0.0.0.0/0'] } }, d)).toBe(false) // dns unknown -> default 8.8.8.8
    expect(networkMatches({ network: { allowOut: d, denyOut: ['0.0.0.0/0'], dnsServers: ['8.8.8.8'] } }, d)).toBe(false)
    expect(networkMatches({ network: { allowOut: d, denyOut: [], dnsServers: [] } }, d)).toBe(false)
    expect(networkMatches({ network: { allowOut: [...d, 'x.com'], denyOut: ['0.0.0.0/0'], dnsServers: [] } }, d)).toBe(false)
    expect(networkMatches({ allowInternetAccess: false }, [])).toBe(true)
    expect(networkMatches({ allowInternetAccess: true, network: { denyOut: ['0.0.0.0/0'] } }, [])).toBe(true)
    expect(networkMatches({ allowInternetAccess: true }, [])).toBe(false)
    expect(networkMatches({ allowInternetAccess: false, network: { allowOut: ['x.com'] } }, [])).toBe(false)
  })
})

describe('hosts pinning', () => {
  it('only public IPv4 counts', () => {
    for (const ip of ['104.16.0.35', '93.184.215.14', '8.8.8.8']) expect(isPublicIPv4(ip)).toBe(true)
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', 'x'])
      expect(isPublicIPv4(ip)).toBe(false)
  })
  it('builds one line per allowed name', async () => {
    const block = await hostsBlock(['a.example.com', 'b.example.com'], async (h) => (h.startsWith('a') ? '1.2.3.4' : '5.6.7.8'))
    expect(block).toContain('1.2.3.4 a.example.com\n')
    expect(block).toContain('5.6.7.8 b.example.com\n')
  })
  it('the root script restores the base file, appends pins and empties resolv.conf', () => {
    expect(APPLY_HOSTS_SCRIPT).toContain('cp /etc/hosts.forge-base /etc/hosts')
    expect(APPLY_HOSTS_SCRIPT).toContain(': > /etc/resolv.conf')
  })
})

describe('E2B pricing', () => {
  it('2 vCPU / 4 GiB = $0.000046 per second ($0.0276 per 10-minute sandbox)', () => {
    expect(nanoUsdPerSecond({ cpuCount: 2, memoryMB: 4096 })).toBe(46_000)
    expect(sandboxCostNanoUsd({ cpuCount: 2, memoryMB: 4096 }, 600)).toBe(27_600_000)
    expect(sandboxCostNanoUsd({ cpuCount: 2, memoryMB: 4096 }, 0.2)).toBe(46_000) // rounds up to whole seconds
  })
})

describe('Forge E2B template', () => {
  it('renders offline to a pinned Dockerfile with the toolchain', () => {
    const df = Template.toDockerfile(forgeTemplate())
    expect(df).toContain(`FROM node:${FORGE_TEMPLATE_VERSIONS.node}`)
    expect(df).toContain(`pnpm@${FORGE_TEMPLATE_VERSIONS.pnpm}`)
    expect(df).toContain('playwright install --with-deps chromium')
    expect(df).toContain('PLAYWRIGHT_BROWSERS_PATH=/ms-playwright')
    expect(df).toContain(`phaser@${FORGE_TEMPLATE_VERSIONS.phaser}`)
    expect(df).toContain(`esbuild@${FORGE_TEMPLATE_VERSIONS.esbuild}`)
    expect(df).toContain('onlyBuiltDependencies')
  })
})
