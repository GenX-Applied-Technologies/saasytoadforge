import { test, expect } from '@playwright/test'

/**
 * Production smoke test: the critical path, end to end. Run against a deployment by
 * overriding the Playwright baseURL (the deployed web URL, whose build points at the
 * deployed agent service). Self-contained - signs up through the UI.
 */
test('smoke: pricing loads, sign up, create workspace, run a task to green', async ({ page }) => {
  await page.goto('/pricing')
  await expect(page.getByText('Simple, flat pricing')).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Pro Builder')).toBeVisible()
  await page.screenshot({ path: 'test-results/pricing.png' })

  await page.goto('/workspaces')
  await page.getByRole('button', { name: 'New here? Create an account' }).click()
  await page.getByPlaceholder('you@example.com').fill(`smoke-${Date.now()}@forge.dev`)
  await page.getByPlaceholder('password (8+ characters)').fill('password123')
  await page.getByRole('button', { name: 'Sign up' }).click()
  await page.waitForURL(/\/workspaces$/)

  await page.getByRole('button', { name: 'New workspace' }).click()
  await page.waitForURL(/\/workspaces\/.+/)
  await expect(page.getByText('ready')).toBeVisible({ timeout: 15000 })

  await page
    .getByPlaceholder('Describe a task')
    .fill('add an endpoint that returns the current time and a test for it')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('exit 0')).toBeVisible({ timeout: 20000 })
})
