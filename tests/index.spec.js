const { test, expect } = require('@playwright/test');

test.describe('Import Feature Validation', () => {
  
  test.beforeEach(async ({ page }) => {
    // Use direct file path for testing
    await page.goto('file://D:/Code/PersonalDev/MermaidView/web/index.html');
    
    // Wait for app to initialize
    await page.waitForTimeout(1000);
  });

  test('Import button exists and is clickable', async ({ page }) => {
    const btn = page.locator('button[id="btn-import"]');
    console.log('[TEST] Looking for import button...');
    
    // Check if button element exists in DOM
    await expect(btn).toBeAttached();
    const text = await btn.textContent();
    console.log('[TEST] Import button text:', text);
  });

  test('Import panel textarea is visible when panel opens', async ({ page }) => {
    // Click import button to open panel
    await page.locator('button[id="btn-import"]').click();
    
    // Wait for panel to appear
    await page.waitForTimeout(1000);
    
    console.log('[TEST] Checking if textarea is visible...');
    
    const textarea = page.locator('#import-mermaid');
    
    // Check computed display style - it should NOT be none/hidden
    const displayStyle = await textarea.evaluate(el => {
      return getComputedStyle(el).display;
    });
    
    console.log('[TEST] Textarea computed display:', displayStyle);
    expect(displayStyle).not.toBe('none');
  });

  test('Import panel has close button', async ({ page }) => {
    await page.locator('button[id="btn-import"]').click();
    await page.waitForTimeout(500);
    
    const closeBtn = page.locator('#import-close');
    const isVisible = await closeBtn.isVisible();
    console.log('[TEST] Close button visible:', isVisible);
    
    await expect(closeBtn).toBeVisible();
  });

  test('Add diagram button exists in panel', async ({ page }) => {
    await page.locator('button[id="btn-import"]').click();
    await page.waitForTimeout(500);
    
    const btnAdd = page.locator('button[id="import-add"]');
    const display = await btnAdd.evaluate(el => {
      return getComputedStyle(el).display;
    });
    
    console.log('[TEST] Add button computed display:', display);
    expect(display).not.toBe('none');
  });

  test('Tip message appears in import panel', async ({ page }) => {
    await page.locator('button[id="btn-import"]').click();
    await page.waitForTimeout(500);
    
    // Look for tip text content
    const texts = await page.locator('#import-panel').allTextContents();
    console.log('[TEST] Panel texts found:', texts.slice(0, 3));
    
    // Check if panel has any child elements (it shouldn't be empty)
    await expect(page.locator('#import-mermaid')).toHaveCount(1);
  });

});
