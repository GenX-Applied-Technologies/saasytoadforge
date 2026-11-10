import { Template, type TemplateClass } from 'e2b'

/**
 * The Forge E2B template: what a sandbox has installed before the agent touches it, so the
 * agent never needs the open internet to build, test or screenshot a game. Pattern follows
 * e2b-dev/fragments (Apache-2.0): a Node base image plus pre-installed toolchains.
 *
 * Versions are pinned so a rebuild is reproducible; bump them here (and rebuild) on purpose.
 * Building is a PAID step (scripts/e2b-build-template.ts refuses to run without approval).
 */
export const FORGE_TEMPLATE_NAME = 'forge-node22-phaser'
export const FORGE_TEMPLATE_VERSIONS = {
  node: '22',
  pnpm: '10.20.0',
  playwright: '1.56.1',
  phaser: '3.90.0',
  vite: '7.1.12',
  typescript: '5.9.3',
} as const

/** Packages fetched once at build time into the pnpm store so installs work offline. */
export const PREFETCH_PACKAGES = [
  `phaser@${FORGE_TEMPLATE_VERSIONS.phaser}`,
  `vite@${FORGE_TEMPLATE_VERSIONS.vite}`,
  `typescript@${FORGE_TEMPLATE_VERSIONS.typescript}`,
  `@playwright/test@${FORGE_TEMPLATE_VERSIONS.playwright}`,
] as const

export function forgeTemplate(): TemplateClass {
  const v = FORGE_TEMPLATE_VERSIONS
  return Template()
    .fromNodeImage(v.node)
    .setUser('root')
    // Shared browser path so the unprivileged 'user' finds the Chromium root installed.
    .setEnvs({ PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' })
    .aptInstall(['git', 'ca-certificates', 'curl'])
    .runCmd([
      `npm install -g pnpm@${v.pnpm} playwright@${v.playwright}`,
      // Browser + its system libraries for screenshots / real-browser checks inside the sandbox.
      'playwright install --with-deps chromium',
      'chmod -R a+rX /ms-playwright',
      'mkdir -p /opt/forge-store && chmod 0777 /opt/forge-store',
    ])
    .setUser('user')
    .setWorkdir('/home/user')
    .runCmd([
      'pnpm config set store-dir /opt/forge-store',
      `mkdir -p /tmp/forge-prefetch && cd /tmp/forge-prefetch && printf '{"name":"prefetch","private":true}' > package.json && pnpm add ${PREFETCH_PACKAGES.join(' ')} && cd / && rm -rf /tmp/forge-prefetch`,
      'pnpm config set prefer-offline true',
    ])
}
