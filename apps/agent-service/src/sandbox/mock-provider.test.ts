import { describe, it, expect } from 'vitest'
import { parseServerEnv } from '@forge/shared'
import { MockSandboxProvider, E2BSandboxProvider, createSandboxProvider } from './index'

async function freshSandbox() {
  const provider = new MockSandboxProvider()
  const sandbox = await provider.create({ template: 'node', envAllowlist: [] })
  return { provider, sandbox }
}

describe('MockSandboxProvider', () => {
  it('creates a sandbox with id, template, and timestamp', async () => {
    const { sandbox } = await freshSandbox()
    expect(sandbox.id).toMatch(/^mock_/)
    expect(sandbox.template).toBe('node')
    expect(() => new Date(sandbox.createdAt).toISOString()).not.toThrow()
  })

  it('round-trips a file write -> read', async () => {
    const { provider, sandbox } = await freshSandbox()
    await provider.writeFile(sandbox.id, 'src/index.ts', 'export const x = 1\n')
    expect(await provider.readFile(sandbox.id, 'src/index.ts')).toBe('export const x = 1\n')
  })

  it('normalizes leading ./ and / on paths', async () => {
    const { provider, sandbox } = await freshSandbox()
    await provider.writeFile(sandbox.id, './a.txt', 'A')
    expect(await provider.readFile(sandbox.id, '/a.txt')).toBe('A')
  })

  it('throws reading a missing file', async () => {
    const { provider, sandbox } = await freshSandbox()
    await expect(provider.readFile(sandbox.id, 'nope.txt')).rejects.toThrow(/no such file/)
  })

  it('execs echo and cat, and reports unknown commands honestly', async () => {
    const { provider, sandbox } = await freshSandbox()
    const echo = await provider.exec(sandbox.id, 'echo hello world')
    expect(echo.exitCode).toBe(0)
    expect(echo.stdout).toBe('hello world\n')

    await provider.writeFile(sandbox.id, 'readme.md', '# hi')
    const cat = await provider.exec(sandbox.id, 'cat readme.md')
    expect(cat.stdout).toBe('# hi')

    const bad = await provider.exec(sandbox.id, 'rm -rf /')
    expect(bad.exitCode).toBe(127)
    expect(bad.stderr).toMatch(/not executable in the mock provider/)
  })

  it('lists immediate children as files and dirs', async () => {
    const { provider, sandbox } = await freshSandbox()
    await provider.writeFile(sandbox.id, 'package.json', '{}')
    await provider.writeFile(sandbox.id, 'src/index.ts', '')
    await provider.writeFile(sandbox.id, 'src/lib/util.ts', '')

    const root = await provider.listFiles(sandbox.id, '')
    expect(root.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:src', 'file:package.json'])

    const src = await provider.listFiles(sandbox.id, 'src')
    expect(src.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:lib', 'file:index.ts'])
  })

  it('echoes input, runs the line on Enter (CR), and reprompts', async () => {
    const { provider, sandbox } = await freshSandbox()
    const shell = provider.openShell(sandbox.id)
    const iterator = shell.output[Symbol.asyncIterator]()

    const firstPrompt = await iterator.next()
    expect(firstPrompt.value).toContain('$')

    // xterm sends CR on Enter. Read through to the reprompt.
    await shell.write('echo streamed\r')

    let transcript = ''
    for (let i = 0; i < 120 && !transcript.includes('streamed\r\nforge:/workspace$'); i++) {
      const { value } = await iterator.next()
      transcript += value ?? ''
    }

    // Input was echoed, the command ran (CRLF output line), and a new prompt followed.
    expect(transcript).toContain('echo streamed') // echo of keystrokes
    expect(transcript).toContain('streamed\r\n') // command output, CRLF for the terminal
    expect(transcript.split('forge:/workspace$').length).toBeGreaterThanOrEqual(2)

    await shell.close()
  })

  it('treats CRLF as a single Enter and runs the command once', async () => {
    const { provider, sandbox } = await freshSandbox()
    const shell = provider.openShell(sandbox.id)
    const iterator = shell.output[Symbol.asyncIterator]()
    await iterator.next() // initial prompt

    await shell.write('pwd\r\n')
    let transcript = ''
    for (let i = 0; i < 120 && !transcript.includes('/workspace\r\n'); i++) {
      const { value } = await iterator.next()
      transcript += value ?? ''
    }
    expect(transcript).toContain('pwd') // echoed
    expect(transcript).toContain('/workspace\r\n') // command ran (the trailing LF did not error)
    await shell.close()
  })

  it('enforces default-deny egress and honors the allowlist', async () => {
    const { provider, sandbox } = await freshSandbox()
    // Default: empty allowlist blocks everything.
    expect((await provider.exec(sandbox.id, 'curl https://evil.example.com')).exitCode).not.toBe(0)

    await provider.setEgressAllowlist(sandbox.id, ['registry.npmjs.org'])
    const allowed = await provider.exec(sandbox.id, 'curl https://registry.npmjs.org/pkg')
    expect(allowed.exitCode).toBe(0)
    const blocked = await provider.exec(sandbox.id, 'curl https://evil.example.com')
    expect(blocked.exitCode).not.toBe(0)
    expect(blocked.stderr).toMatch(/egress blocked/)
  })

  it('stores the egress allowlist and clears state on destroy', async () => {
    const { provider, sandbox } = await freshSandbox()
    await provider.setEgressAllowlist(sandbox.id, ['registry.npmjs.org', 'pypi.org'])
    expect(provider.getEgressAllowlist(sandbox.id)).toEqual(['registry.npmjs.org', 'pypi.org'])

    await provider.destroy(sandbox.id)
    await expect(provider.readFile(sandbox.id, 'x')).rejects.toThrow(/unknown sandbox/)
  })

  it('checkpoints and restores the filesystem', async () => {
    const { provider, sandbox } = await freshSandbox()
    await provider.writeFile(sandbox.id, 'a.txt', 'one')
    const ref = await provider.checkpoint(sandbox.id)

    // Change the world after the checkpoint: edit a file and add a new one.
    await provider.writeFile(sandbox.id, 'a.txt', 'two')
    await provider.writeFile(sandbox.id, 'b.txt', 'new')
    expect(await provider.readFile(sandbox.id, 'a.txt')).toBe('two')

    await provider.restore(sandbox.id, ref)
    expect(await provider.readFile(sandbox.id, 'a.txt')).toBe('one') // edit rolled back
    await expect(provider.readFile(sandbox.id, 'b.txt')).rejects.toThrow(/no such file/) // added file gone
  })

  it('rejects restoring an unknown checkpoint ref', async () => {
    const { provider, sandbox } = await freshSandbox()
    await expect(provider.restore(sandbox.id, 'nope')).rejects.toThrow(/unknown checkpoint/)
  })
})

describe('createSandboxProvider', () => {
  it('returns the mock provider by default', () => {
    const provider = createSandboxProvider(parseServerEnv({}))
    expect(provider).toBeInstanceOf(MockSandboxProvider)
  })

  it('refuses e2b without its key, spend cap and data dir (no silent mock fallback)', () => {
    const env = parseServerEnv({ SANDBOX_PROVIDER: 'e2b' } as NodeJS.ProcessEnv)
    expect(() => createSandboxProvider(env)).toThrow(
      'SANDBOX_PROVIDER=e2b refused: missing E2B_API_KEY, FORGE_SANDBOX_SPEND_CAP_USD, FORGE_DATA_DIR.',
    )
  })

  it('never auto-upgrades the mock to E2B just because a key is present', () => {
    const env = parseServerEnv({ E2B_API_KEY: 'e2b-test-key' } as NodeJS.ProcessEnv)
    expect(createSandboxProvider(env)).toBeInstanceOf(MockSandboxProvider)
  })

  it('builds the real E2B provider when fully configured (no network call at construction)', () => {
    const env = parseServerEnv({
      SANDBOX_PROVIDER: 'e2b', E2B_API_KEY: 'e2b-test-key', FORGE_SANDBOX_SPEND_CAP_USD: '3', FORGE_DATA_DIR: '/tmp/forge-test-data',
    } as NodeJS.ProcessEnv)
    expect(createSandboxProvider(env)).toBeInstanceOf(E2BSandboxProvider)
  })

  it('refuses the mock provider when NODE_ENV=production', () => {
    const env = parseServerEnv({ NODE_ENV: 'production', AGENT_SERVICE_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv)
    expect(() => createSandboxProvider(env)).toThrow('SANDBOX_PROVIDER=mock is refused when NODE_ENV=production')
  })

  it('rejects the removed daytona provider and out-of-range sandbox caps at parse time', () => {
    expect(() => parseServerEnv({ SANDBOX_PROVIDER: 'daytona' } as NodeJS.ProcessEnv)).toThrow()
    expect(() => parseServerEnv({ FORGE_SANDBOX_SPEND_CAP_USD: '11' } as NodeJS.ProcessEnv)).toThrow()
    expect(() => parseServerEnv({ FORGE_SANDBOX_SPEND_CAP_USD: '0' } as NodeJS.ProcessEnv)).toThrow()
    expect(() => parseServerEnv({ FORGE_DATA_DIR: 'relative/dir' } as NodeJS.ProcessEnv)).toThrow()
  })
})
