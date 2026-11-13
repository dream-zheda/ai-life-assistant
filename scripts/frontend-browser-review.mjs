import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '../packages/db/generated/client/index.js';
const runtime = createRequire(process.env.PLAYWRIGHT_MODULE_PATH || path.join(process.cwd(), 'package.json'));
const { chromium } = runtime('playwright');
if (process.env.FRONTEND_REVIEW_CONFIRM !== 'isolated' || !/review|test/i.test(new URL(process.env.DATABASE_URL || '').pathname)) throw new Error('Use an isolated review/test database and set FRONTEND_REVIEW_CONFIRM=isolated');
const db = new PrismaClient();
const base = 'http://127.0.0.1:3110';
const root = process.cwd();
const out = path.join(root, 'tmp', 'frontend-review');
mkdirSync(out, { recursive: true });
const checks = [];
const errors = [];
const record = (name) => { checks.push(name); console.log(`PASS ${name}`); };
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', '3110', 'apps/web'], { cwd: root, env: { ...process.env, APP_BASE_URL: base, BETTER_AUTH_SECRET: 'review-only-isolated-browser-secret-2026', AUTH_RATE_LIMIT: 'off', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let logs = '';
server.stdout.on('data', data => { logs += data.toString(); });
server.stderr.on('data', data => { logs += data.toString(); });
let browser;
let activePage;
try {
  // 仅清理本脚本在隔离测试库创建的演示账号，便于失败后重跑。
  await db.invite.deleteMany({ where: { createdBy: { email: { startsWith: 'review-ui-' } } } });
  await db.user.deleteMany({ where: { email: { startsWith: 'review-ui-' } } });
  for (let n = 0; n < 60; n++) { try { const response = await fetch(`${base}/sign-in`); if (response.ok) break; } catch {} if (n === 59) throw new Error('Server not ready'); await sleep(500); }
  browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, baseURL: base });
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', error => errors.push(error.message));

  page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') console.log('REQUEST FAILED', request.url(), request.failure()?.errorText); });
  const goto = page.goto.bind(page);
  page.goto = (url, options) => goto(url, { waitUntil: 'networkidle', ...options });
  await page.goto('/sign-up');
  await page.getByLabel('怎么称呼你').fill('小林');
  await page.getByLabel('邮箱', { exact: true }).fill(`review-ui-${Date.now()}@example.test`);
  const email = await page.getByLabel('邮箱', { exact: true }).inputValue();
  await page.getByLabel('密码（至少 8 位）').fill('review-demo-password-2026');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.waitForURL('**/setup/model');
  record('真实浏览器注册、会话与页面导航');
  await page.goto('/today');
  assert.match(await page.locator('main').innerText(), /今天还没有计划/);
  assert.equal(await page.getByRole('button', { name: /生成今天的计划/ }).first().isDisabled(), true);
  await page.screenshot({ path: path.join(out, 'today-empty-desktop.png'), fullPage: true });
  record('无模型、无计划状态与生成按钮防误操作');
  await page.goto('/connect/qq');
  assert.match(await page.locator('main').innerText(), /添加提醒助手为好友/);
  assert.equal(await page.getByRole('button', { name: '领取绑定码' }).isDisabled(), true);
  record('QQ 连接页面显示统一机器人流程，离线时阻止领取绑定码');
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await db.profile.create({ data: { userId: user.id, rawInput: '我是一名学生，希望平衡英语学习、运动和休息。晚上留一点时间娱乐。' } });
  await db.goal.createMany({ data: [{ userId: user.id, title: '让英语成为日常习惯', description: '每天练习听力，积累常用表达。', priority: 1 }, { userId: user.id, title: '规律运动，保持好状态', priority: 2 }] });
  const active = await db.planVersion.create({ data: { userId: user.id, localDate: day, timeZone: 'Asia/Shanghai', version: 1, state: 'ACTIVE', basis: { assumptions: ['演示安排：学习与休息之间留有缓冲。'], unresolvedQuestions: [] } } });
  const entries = [['09:00', '09:30', '英语听力与跟读', '用一小段专注时间，保持每天的积累。'], ['14:30', '15:15', '整理课程笔记', '先处理今天最重要的学习任务。'], ['21:45', '22:05', '轻松散步，换换心情', '从屏幕前离开一会儿，给身体一点活动。'], ['22:15', '22:45', '留给自己的休闲时间', '休息也是计划的一部分。']];
  const items = [];
  for (const [start, end, title, reason] of entries) {
    const startsAt = new Date(`${day}T${start}:00+08:00`), endsAt = new Date(`${day}T${end}:00+08:00`);
    items.push(await db.planItem.create({ data: { userId: user.id, planVersionId: active.id, title, reason, startsAt, endsAt, minutes: (endsAt - startsAt) / 60000 } }));
  }
  await db.progressEvent.create({ data: { userId: user.id, planItemId: items[0].id, state: 'DONE', ratio: 1 } });
  await db.progressEvent.create({ data: { userId: user.id, planItemId: items[1].id, state: 'PARTIALLY_DONE', ratio: .5 } });
  await db.notification.create({ data: { userId: user.id, planVersionId: active.id, kind: 'START', dedupeKey: `review-ui-${user.id}`, content: '今天也记得给自己一点休息时间。散步二十分钟，再回到想做的事情。', scheduledAt: new Date(`${day}T21:35:00+08:00`), state: 'FALLBACK_REQUIRED' } });
  await page.goto('/today');
  await page.screenshot({ path: path.join(out, 'today-desktop.png'), fullPage: true });
  record('首页真实数据库渲染、统计、时间安排与站内提醒');
  const doneCard = page.locator('.timeline-card').filter({ hasText: '英语听力与跟读' });
  assert.equal(await doneCard.getByRole('button').count(), 0);
  const partialCard = page.locator('.timeline-card').filter({ hasText: '整理课程笔记' });
  await partialCard.getByRole('button', { name: '完成', exact: true }).click();
  await page.waitForURL('**/today?saved=1');
  assert.match(await partialCard.innerText(), /已完成/);
  record('网页完成反馈写库、完成后收起回退按钮');
  await db.planVersion.create({ data: { userId: user.id, localDate: day, timeZone: 'Asia/Shanghai', version: 2, state: 'DRAFT', items: { create: { title: '待采纳的新安排', startsAt: new Date(`${day}T23:00:00+08:00`), endsAt: new Date(`${day}T23:15:00+08:00`), minutes: 15 } } } });
  await page.goto('/today');
  assert.equal(await page.getByText('待采纳的新安排', { exact: true }).count(), 1);
  assert.equal(await page.locator('.timeline-card').count(), 4);
  record('新草稿与生效计划同时可见');
  await page.screenshot({ path: path.join(out, 'today-with-draft.png'), fullPage: true });
  for (const route of ['/today?error=100%25%E6%B5%8B%E8%AF%95', '/setup/model?test=fail&msg=100%25%E6%B5%8B%E8%AF%95', '/settings?test=fail&msg=100%25%E6%B5%8B%E8%AF%95', '/onboarding?test=fail&msg=100%25%E6%B5%8B%E8%AF%95']) {
    const response = await page.goto(route); assert.equal(response.status(), 200); assert.match(await page.locator('main').innerText(), /100%测试/);
  }
  record('错误消息包含百分号时四个页面正常渲染');
  await page.goto('/setup/model');
  await page.getByLabel('接口地址', { exact: true }).fill('https://api.deepseek.com/v1');
  await page.getByLabel('API Key', { exact: false }).fill('sk-browser-dummy-key-not-real');
  await page.getByLabel('模型服务商').selectOption('openai');
  assert.equal(await page.getByLabel('接口地址', { exact: true }).inputValue(), 'https://api.openai.com/v1');
  assert.equal(await page.getByLabel('API Key', { exact: false }).inputValue(), '');
  await page.getByLabel('模型服务商').selectOption('custom');
  assert.equal(await page.getByLabel('接口地址', { exact: true }).inputValue(), '');
  await page.screenshot({ path: path.join(out, 'model-desktop.png'), fullPage: true });
  record('模型服务商切换同步更新地址并清空输入密钥');
  await page.goto('/goals');
  await page.locator('#new-title').fill('每周读完一章书');
  await page.locator('#new-description').fill('不赶进度，享受阅读。');
  await page.getByRole('button', { name: '添加目标', exact: true }).click();
  await page.waitForURL('**/goals?saved=1');
  await sleep(800);
  await page.getByRole('heading', { name: '我的目标', exact: true }).waitFor({ state: 'visible' });
  const goalCard = page.locator('.goal-card').filter({ has: page.getByRole('heading', { name: '每周读完一章书' }) });
  await goalCard.locator('summary').click();
  await goalCard.getByLabel('目标状态').selectOption('PAUSED');
  await goalCard.getByRole('button', { name: '保存目标' }).click();
  await page.waitForLoadState('networkidle');
  await sleep(800);
  await page.getByRole('heading', { name: '我的目标', exact: true }).waitFor({ state: 'visible' });
  assert.match(await goalCard.innerText(), /已暂停/);
  await page.screenshot({ path: path.join(out, 'goals-desktop.png'), fullPage: true });
  record('目标新增、编辑与暂停通过真实表单提交');
  await page.goto('/settings');
  await page.getByLabel('暂停所有提醒，保留我的计划').check();
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.waitForURL('**/settings?saved=1');
  await page.goto('/today'); assert.match(await page.locator('main').innerText(), /提醒已暂停/);
  record('暂停提醒设置保存后在首页可见');
  await page.goto('/admin/invites');
  await page.getByRole('button', { name: '生成邀请码', exact: true }).click();
  await page.waitForURL(/\/admin\/invites\?created=/);
  assert.match(await page.locator('main').innerText(), /邀请码已生成/);
  record('邀请码生成成功，不再误报跳转异常');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['/today', '/onboarding', '/goals', '/setup/model', '/settings', '/connect/qq']) {
      await page.goto(route);
      await page.locator('main h1').waitFor({ state: 'visible' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, `${route} horizontal overflow at ${width}`);
      if (width === 390) await page.screenshot({ path: path.join(out, `${route.replaceAll('/', '-')}-mobile.png`), fullPage: true });
      if (width === 1440 && route === '/goals') await page.screenshot({ path: path.join(out, 'goals-stable-desktop.png'), fullPage: true });
    }
    record(`${width}px 六个核心页面无横向溢出`);
  }
  assert.deepEqual(errors, []);
  record('浏览器无未处理的页面异常');
  writeFileSync(path.join(out, 'browser-checks.json'), JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  if (activePage) {
    console.log('Failure URL:', activePage.url());
    console.log('Page errors:', errors);
    console.log('Goal database:', await db.goal.findMany({ where: { title: '每周读完一章书' }, select: { title: true, state: true } }));
    console.log('Failure page:', (await activePage.locator('body').innerText()).slice(-4500));
    await activePage.screenshot({ path: path.join(out, 'failure.png'), fullPage: true });
  }
  throw error;
} finally {
  if (browser) await browser.close();
  await db.$disconnect();
  server.kill();
  writeFileSync(path.join(out, 'browser-server.log'), logs);
}
