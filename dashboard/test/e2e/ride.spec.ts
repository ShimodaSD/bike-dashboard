// A demo ride from start to finish in a real browser, against the real logger (--demo).
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

const WORKOUTS = join(import.meta.dirname, '../../../workouts');

// The logger keeps its ride between tests: each test starts from an empty dashboard.
test.beforeEach(async ({ page, request }) => {
  await request.post('/finish');
  await request.post('/clear');
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Demo/ })).toBeVisible();        // simulated trainer is up
  await openPage(page, 'Live');                       // first start may show Devices instead
});

// A tab in the page bar under the header.
async function openPage(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: new RegExp(`^${name}`) }).click();
}

const rideTime = (page: Page) => page.locator('.tile.time .value');
const strip = (page: Page) => page.locator('.strip');

async function finish(page: Page) {
  await page.getByRole('button', { name: /^Finish/ }).click();
  await page.waitForTimeout(600);                      // a second press within 0.5 s is a double tap
  await page.getByRole('button', { name: /again to finish/ }).click();
}

test('preview shows live numbers but saves nothing', async ({ page }) => {
  await expect(strip(page)).toContainText('Nothing is saved until you press Start');
  await expect(page.locator('.tile.power .value')).not.toHaveText('–W');
  await expect(rideTime(page)).toHaveText('0:00');
});

test('start, lap, finish, download the .FIT, resume', async ({ page, request }) => {
  await page.getByRole('button', { name: /^Start(?! FTP)/ }).click();
  await expect(strip(page)).toContainText('Recording ride');
  await expect(rideTime(page)).toHaveText(/0:0[3-9]/, { timeout: 8000 });

  await page.getByRole('button', { name: /^Lap/ }).click();
  await expect(page.getByText(/Lap 2 started/)).toBeVisible();
  await expect(page.getByLabel('Current lap')).toContainText('Lap 2');
  await expect(page.getByRole('img', { name: /^Power over/ })).toHaveAttribute('aria-label', /now \d+ W/);
  await page.waitForTimeout(2500);

  await finish(page);
  await expect(strip(page)).toContainText('Saved on this computer');
  await expect(page.getByText('Avg power · ride')).toBeVisible();
  const laps = page.locator('.laps tbody tr');
  await expect(laps).toHaveCount(2);

  const fit = await request.get('/ride.fit');
  expect(fit.ok()).toBeTruthy();
  const body = await fit.body();
  expect(body.subarray(8, 12).toString()).toBe('.FIT');
  expect(fit.headers()['content-disposition']).toMatch(/attachment; filename="ride_\d{8}_\d{6}\.fit"/);

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download .FIT' }).click();
  expect((await download).suggestedFilename()).toMatch(/^ride_\d{8}_\d{6}\.fit$/);
  await expect(page.getByRole('link', { name: 'Download .FIT (done)' })).toBeVisible();

  const before = await rideTime(page).textContent();
  await page.getByRole('button', { name: 'Resume ride' }).click();
  await expect(strip(page)).toContainText('Recording ride');
  await expect(rideTime(page)).not.toHaveText(before!, { timeout: 5000 });
  await finish(page);
  await expect(strip(page)).toContainText('Saved on this computer');
});

test('a double tap on Finish does not end the ride', async ({ page }) => {
  await page.getByRole('button', { name: /^Start(?! FTP)/ }).click();
  await expect(rideTime(page)).toHaveText(/0:0[1-9]/, { timeout: 5000 });
  await page.getByRole('button', { name: /^Finish/ }).dblclick();
  await expect(strip(page)).toContainText('Recording ride');
  await page.waitForTimeout(4200);                     // disarms by itself
  await expect(page.getByRole('button', { name: /^Finish/ })).toBeVisible();
  await finish(page);
});

test('keyboard: S, L, F F', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard shortcuts are for a computer');
  await page.keyboard.press('s');
  await expect(strip(page)).toContainText('Recording ride');
  await expect(rideTime(page)).toHaveText(/0:0[2-9]/, { timeout: 6000 });
  await page.keyboard.press('l');
  await expect(page.getByText(/Lap 2 started/)).toBeVisible();
  await page.keyboard.press('f');
  await page.waitForTimeout(600);
  await page.keyboard.press('f');
  await expect(strip(page)).toContainText('Saved on this computer');
});

test('workout: load in Training, the band follows the ride', async ({ page }) => {
  await openPage(page, 'Training');
  await page.getByLabel('Load workout').setInputFiles(join(WORKOUTS, 'power-sweet-spot.zwo'));
  await expect(page.getByText('Power test · Sweet spot 3x3').first()).toBeVisible();
  await openPage(page, 'Live');
  const band = page.getByRole('region', { name: 'Workout' });
  await expect(band).toContainText('Starts when you press Start');
  await page.getByRole('button', { name: /^Start(?! FTP)/ }).click();
  await expect(band).toContainText('Step 1/8 · Warm-up');
  await expect(band).toContainText(/left/);
  await expect(page.getByRole('img', { name: /^Power over/ })).toBeVisible();
  await openPage(page, 'Training');                   // the ride keeps going on another page
  await expect(page.getByRole('link', { name: /^Live/ })).toContainText(/\d:\d\d/);
  await page.keyboard.press('l');
  await expect(page.getByRole('button', { name: /^Finish/ })).toBeVisible();
  await finish(page);
  await page.getByRole('button', { name: 'Remove' }).click();
});

test('FTP test: start from the strip, the band counts down, stop keeps the ride', async ({ page }) => {
  await strip(page).getByRole('button', { name: 'Start FTP test' }).click();
  await expect(strip(page)).toContainText('Recording FTP test');
  const band = page.getByRole('region', { name: 'FTP test' });
  await expect(band).toContainText(/The 20 minutes start in 2[45]:\d\d/);
  await expect(band).toContainText('Fan on, bottle in reach');
  await band.getByRole('button', { name: 'Hide FTP numbers' }).click();
  await expect(band.getByRole('button', { name: 'Show FTP numbers' })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('region', { name: 'FTP test' }).getByRole('button', { name: 'Show FTP numbers' })).toBeVisible();
  await page.getByRole('region', { name: 'FTP test' }).getByRole('button', { name: 'Show FTP numbers' }).click();
  await expect(page.getByRole('region', { name: 'Workout' })).toContainText('Step 1/5 · Warm-up');
  await band.getByRole('button', { name: 'Stop test' }).click();
  await page.waitForTimeout(600);
  await band.getByRole('button', { name: /again to stop the test/ }).click();
  await expect(band).toHaveCount(0);
  await expect(strip(page)).toContainText('Recording ride');
  await finish(page);
});

test('FTP test: Training has the start button and a guide for the rider', async ({ page }) => {
  await openPage(page, 'Training');
  const settings = page.getByRole('region', { name: 'FTP test' });
  await expect(settings.getByRole('button', { name: 'Start FTP test' })).toBeEnabled();
  await expect(settings.getByText('A fan on you')).toBeHidden();
  await settings.getByText('How to get a good test').click();
  await expect(settings.getByText(/A fan on you/)).toBeVisible();
  await expect(settings.getByText(/Start a little conservative, near your current FTP/)).toBeVisible();
  await expect(settings.getByText(/about 35 to 50 minutes/)).toBeVisible();
  await expect(settings.getByText(/Every 4 to 8 weeks/)).toBeVisible();
});

test('trainer control: climb in demo', async ({ page }) => {
  const band = page.getByRole('region', { name: 'Trainer control' });
  await band.getByRole('switch', { name: 'Trainer control' }).click();
  await expect(band.getByText('On', { exact: true })).toBeVisible();
  await band.getByRole('button', { name: '6 %' }).click();
  await expect(band.getByRole('status', { name: 'Grade' })).toHaveText('6.0%');
  await band.getByRole('switch', { name: 'Trainer control' }).click();
  await expect(band.getByText('Off', { exact: true })).toBeVisible();
});

test('devices page lists the demo devices', async ({ page }) => {
  await page.getByRole('link', { name: /Open Devices/ }).click();
  const panel = page.getByRole('region', { name: 'Devices' });
  await expect(panel.getByText('Forerunner 165 (demo)').first()).toBeVisible({ timeout: 8000 });
  await expect(panel.getByRole('button', { name: /Show other devices/ })).toBeVisible();
  await openPage(page, 'Live');
  await expect(panel).toBeHidden();
});

test('the layout fits the screen', async ({ page }) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.locator('.tile.power')).toBeInViewport();
});

test('every page fits the screen, with all its tabs in view', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Pages' });
  for (const name of ['Training', 'Past rides', 'Devices', 'Settings', 'Live']) {
    await openPage(page, name);
    await expect(nav.getByRole('link', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-current', 'page');
    for (const tab of await nav.getByRole('link').all()) await expect(tab).toBeInViewport({ ratio: 1 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

test('other websites cannot drive the logger', async ({ request }) => {
  const res = await request.post('/start', { headers: { Origin: 'https://evil.example' } });
  expect(res.status()).toBe(403);
});
