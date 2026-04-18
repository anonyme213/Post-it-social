import { test, expect } from '@playwright/test';

test('homepage has title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Post-it Social/);
});

test('can access login page', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('h1')).toContainText('Connexion');
});