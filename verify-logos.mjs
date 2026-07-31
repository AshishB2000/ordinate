import { chromium } from 'playwright-core';
import * as path from 'path';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Load the hub HTML directly as a file
await page.goto('file:///Users/ashishb/Projects/screenchart/renderer/hub/index.html');
await page.waitForTimeout(500);

// Click settings to open the panel  
await page.evaluate(() => {
  document.querySelector('#settings-btn')?.click();
});
await page.waitForTimeout(500);

await page.screenshot({ path: '/tmp/shots/settings-logos.png' });
console.log('screenshot: /tmp/shots/settings-logos.png');
await browser.close();
