const { test, expect } = require('@playwright/test');

test.describe('Import Feature', () => {
  
  test.beforeEach(async ({ page }) => {
    // Load the main app - use file:// for local testing without server
    await page.goto('file://' + process.cwd() + '/web/index.html');
    
    // Wait for app to initialize
    await page.waitForSelector('#app', { timeout: 5000 });
  });

  test('Import panel opens when clicking Import button', async ({ page }) => {
    console.log('[TEST] Clicking Import button...');
    
    // Find the import button and click it
    const btn = page.locator('button[id="btn-import"]');
    await expect(btn).toBeVisible();
    await btn.click();
    
    // Verify import panel appears (check for dialog or textarea)
    const panel = page.locator('#import-mermaid, #import-panel');
    await expect(panel).toBeVisible({ timeout: 5000 });
    console.log('[TEST] Import panel opened successfully');
  });

  test('Import button shows label', async ({ page }) => {
    const btn = page.locator('button[id="btn-import"]');
    const text = await btn.textContent();
    console.log('[TEST] Button text:', text);
    expect(text).toContain('Import');
  });

  test('Add diagram button is initially disabled', async ({ page }) => {
    // Open panel first
    await page.locator('button[id="btn-import"]').click();
    
    // Wait for panel to appear
    await new Promise(r => setTimeout(r, 500));
    
    const btnAdd = page.locator('button[id="import-add"]');
    // Should be disabled initially - check if button has certain styling
    await expect(btnAdd).toHaveAttribute('disabled', true);
    console.log('[TEST] Add button is initially disabled (as expected)');
  });

  test('Add diagram button enables when text is entered', async ({ page }) => {
    // Open panel
    await page.locator('button[id="btn-import"]').click();
    await new Promise(r => setTimeout(r, 500));
    
    // Enter some mermaid code
    const textarea = page.locator('#import-mermaid');
    await textarea.fill('graph TD; A-->B;');
    
    const btnAdd = page.locator('button[id="import-add"]');
    // Should now be enabled (no disabled attribute)
    await expect(btnAdd).not.toHaveAttribute('disabled');
    console.log('[TEST] Add button enabled after entering text');
  });

  test('Import panel closes when clicking X', async ({ page }) => {
    // Open panel
    await page.locator('button[id="btn-import"]').click();
    await new Promise(r => setTimeout(r, 500));
    
    console.log('[TEST] Clicking close button (X)...');
    // Close by clicking the close button (X)
    const closeBtn = page.locator('#import-close');
    await closeBtn.click();
    
    // Wait for panel to disappear - check if it's no longer visible
    const panel = page.locator('#import-mermaid, #import-panel');
    await expect(panel).not.toBeVisible({ timeout: 3000 });
    console.log('[TEST] Import panel closed successfully');
  });

  test('Import textarea has placeholder', async ({ page }) => {
    await page.locator('button[id="btn-import"]').click();
    await new Promise(r => setTimeout(r, 500));
    
    const textarea = page.locator('#import-mermaid');
    const placeholder = await textarea.getAttribute('placeholder');
    console.log('[TEST] Placeholder text:', placeholder);
    expect(placeholder).toBe('Paste mermaid code here...');
  });

  test('Import tip message is visible', async ({ page }) => {
    await page.locator('button[id="btn-import"]').click();
    await new Promise(r => setTimeout(r, 500));
    
    // Check for the tip message about markdown files
    const tip = page.locator('text:has(".md files in your project - they load automatically")');
    await expect(tip).toBeVisible({ timeout: 3000 });
    console.log('[TEST] Tip message is visible');
  });

});
