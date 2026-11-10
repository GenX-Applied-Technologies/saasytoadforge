import { test, expect, type Page } from '@playwright/test'

async function state(page: Page) {
  return page.evaluate(() => (window as unknown as {
    forgeGame: { snapshot(): { ready: boolean; x: number; y: number; score: number; remaining: number } }
  }).forgeGame?.snapshot())
}
async function moveUntil(page: Page, key: string, check: (s: Awaited<ReturnType<typeof state>>) => boolean) {
  await page.keyboard.down(key)
  try { await expect.poll(async () => check(await state(page)), { timeout: 5000, intervals: [25, 50] }).toBe(true) }
  finally { await page.keyboard.up(key) }
}

test('real canvas loads; keyboard moves/collects; obstacles and world bounds collide; restart restores score', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await expect(page.locator('canvas')).toBeVisible()
  await expect.poll(async () => (await state(page))?.ready).toBe(true)
  await expect(page.getByRole('status')).toHaveText('Score: 0 / 3')
  const initial = await state(page)
  await moveUntil(page, 'ArrowRight', s => s?.score === 1)
  expect((await state(page)).x).toBeGreaterThan(initial.x + 50)
  await expect(page.getByRole('status')).toHaveText('Score: 1 / 3')
  // Move below the seed row then right into the obstacle whose left edge is x=256.
  await moveUntil(page, 'ArrowDown', s => s?.y >= 140)
  await page.keyboard.down('ArrowRight')
  await expect.poll(async () => (await state(page)).x, { timeout: 5000 }).toBeGreaterThan(239)
  await page.waitForTimeout(300) // sustain pressure: real Arcade Physics must prevent crossing
  await page.keyboard.up('ArrowRight')
  expect((await state(page)).x).toBeLessThanOrEqual(243)
  // Back to top row, then past obstacle to collect second seed.
  await moveUntil(page, 'ArrowUp', s => s?.y <= 64)
  await moveUntil(page, 'ArrowRight', s => s?.score === 2)
  await moveUntil(page, 'ArrowRight', s => s?.x >= 555)
  await moveUntil(page, 'ArrowDown', s => s?.score === 3)
  await expect(page.getByRole('status')).toContainText('Garden complete!')
  await page.keyboard.down('ArrowRight')
  await expect.poll(async () => (await state(page)).x).toBeGreaterThan(625)
  await page.waitForTimeout(150)
  await page.keyboard.up('ArrowRight')
  expect((await state(page)).x).toBeLessThanOrEqual(626.1)
  await page.keyboard.press('r')
  await expect.poll(async () => (await state(page)).score).toBe(0)
  expect((await state(page)).remaining).toBe(3)
  expect(errors).toEqual([])
  await page.screenshot({ path: 'test-results/game/garden.png' })
})
