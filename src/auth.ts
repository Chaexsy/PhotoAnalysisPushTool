import fs from 'node:fs';
import { chromium } from 'playwright';
import { config } from './config.js';

fs.mkdirSync(config.sessionDir, { recursive: true });
const context = await chromium.launchPersistentContext(config.sessionDir, {
  headless: false,
  args: ['--no-sandbox'],
  viewport: { width: 1440, height: 1000 }
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto(config.XHS_CREATOR_URL, { waitUntil: 'domcontentloaded' });
console.log('请在打开的浏览器中完成小红书登录；完成后回到终端按 Enter 保存会话。');
process.stdin.setEncoding('utf8');
process.stdin.once('data', async () => { await context.close(); console.log(`会话已保存到 ${config.sessionDir}`); process.exit(0); });
