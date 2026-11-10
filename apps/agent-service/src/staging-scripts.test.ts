import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Tests for the staging secret scripts. `fly` is replaced by a recording stub on PATH here,
// and ONLY here; the real deploy is a paid step (docs/verification/step0.md).
const scripts = resolve(__dirname, '../scripts/staging')
let root: string, secrets: string, bin: string, record: string, localToken: string

const VALUES: Record<string, string> = {
  AGENT_SERVICE_SECRET: 'a'.repeat(48),
  ALLOWED_ORIGINS: 'https://saasytoadforge-web-git-staging.vercel.app',
  GENX_ROUTER_URL: 'https://genx-router-os-git-forge.vercel.app',
  GENX_ROUTER_FORGE_TOKEN: 'n'.repeat(64),
  E2B_API_KEY: 'e2b_test_placeholder_value',
}

function writeSecret(name: string, value: string, mode = 0o600) {
  const f = join(secrets, name)
  writeFileSync(f, value)
  chmodSync(f, mode)
}

function run(script: string, args: string[] = []) {
  return spawnSync('bash', [join(scripts, script), ...args], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FORGE_STAGING_SECRETS_DIR: secrets, FORGE_LOCAL_TOKEN_FILE: localToken, FLY_RECORD: record },
    encoding: 'utf8',
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-staging-'))
  secrets = join(root, 'secrets'); bin = join(root, 'bin'); record = join(root, 'record')
  mkdirSync(secrets, { mode: 0o700 }); mkdirSync(bin); mkdirSync(record)
  localToken = join(root, 'local-token'); writeFileSync(localToken, 'l'.repeat(64))
  // Recording stub: argv to argv.txt, stdin to stdin.txt.
  writeFileSync(join(bin, 'fly'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$FLY_RECORD/argv.txt"\ncat > "$FLY_RECORD/stdin.txt"\n')
  chmodSync(join(bin, 'fly'), 0o755)
  for (const [k, v] of Object.entries(VALUES)) writeSecret(k, v)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('import-fly-secrets.sh', () => {
  it('sends values only over stdin and prints names with fingerprints only', () => {
    const r = run('import-fly-secrets.sh')
    expect(r.status, r.stderr).toBe(0)
    const argv = readFileSync(join(record, 'argv.txt'), 'utf8')
    const stdin = readFileSync(join(record, 'stdin.txt'), 'utf8')
    expect(argv.split('\n')).toEqual(['secrets', 'import', '--stage', '--app', 'saasytoad-forge-agent-staging', ''])
    for (const [k, v] of Object.entries(VALUES)) {
      expect(stdin).toContain(`${k}=${v}\n`)
      expect(argv).not.toContain(v)
      expect(r.stdout + r.stderr).not.toContain(v)
    }
    expect(r.stdout).toMatch(/GENX_ROUTER_FORGE_TOKEN \([0-9a-f]{12}\)/)
  })
  it('refuses the local step-1 token (rotation guard) and calls nothing', () => {
    writeSecret('GENX_ROUTER_FORGE_TOKEN', 'l'.repeat(64))
    const r = run('import-fly-secrets.sh')
    expect(r.status).not.toBe(0); expect(r.stderr).toContain('local proof token')
    expect(existsSync(join(record, 'argv.txt'))).toBe(false)
  })
  it.each([
    ['a world-readable secret file', () => writeSecret('E2B_API_KEY', 'x'.repeat(20), 0o644), 'mode 600'],
    ['a missing required secret', () => rmSync(join(secrets, 'E2B_API_KEY')), 'missing'],
    ['a multi-line secret', () => writeSecret('AGENT_SERVICE_SECRET', `${'a'.repeat(40)}\nextra`), 'single line'],
    ['a direct provider key', () => writeSecret('ANTHROPIC_API_KEY', 'sk-test'), 'must not be provided'],
    ['the Router operator token', () => writeSecret('ROUTER_OS_OPERATOR_TOKEN', 'o'.repeat(40)), 'must not be provided'],
    ['a short app token', () => writeSecret('GENX_ROUTER_FORGE_TOKEN', 'short'), '32+'],
    ['a non-HTTPS Router URL', () => writeSecret('GENX_ROUTER_URL', 'http://router.example'), 'https'],
    ['an open secrets dir', () => chmodSync(secrets, 0o755), 'mode 700'],
  ])('refuses %s and calls nothing', (_name, mutate, reason) => {
    mutate()
    const r = run('import-fly-secrets.sh')
    expect(r.status).not.toBe(0); expect(r.stderr).toContain(reason)
    expect(existsSync(join(record, 'argv.txt'))).toBe(false)
  })
})

describe('new-secret.sh', () => {
  it('writes a 64-char mode-600 secret and prints only a fingerprint', () => {
    const out = join(root, 'fresh', 'TOKEN')
    const r = run('new-secret.sh', [out])
    expect(r.status, r.stderr).toBe(0)
    const value = readFileSync(out, 'utf8')
    expect(value).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(statSync(out).mode & 0o777).toBe(0o600)
    expect(r.stdout).not.toContain(value)
    expect(r.stdout).toMatch(/fingerprint [0-9a-f]{12}/)
  })
  it('never overwrites an existing secret', () => {
    const r = run('new-secret.sh', [localToken])
    expect(r.status).not.toBe(0); expect(readFileSync(localToken, 'utf8')).toBe('l'.repeat(64))
  })
})

describe('deploy.sh', () => {
  it('refuses to run without the explicit approval flag', () => {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const r = run('deploy.sh')
    expect(r.status).not.toBe(0); expect(r.stderr).toContain('FORGE_STAGING_APPROVED')
    expect(existsSync(join(record, 'argv.txt'))).toBe(false)
  })
})
