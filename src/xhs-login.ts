import fs from 'node:fs/promises';
import { config } from './config.js';
import { XhsPublisher, isXhsBrowserBusy } from './xhs.js';

let publisher: XhsPublisher | null = null;
let expiresAt = 0;
let image: Buffer | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let state = { active: false, loggedIn: false, account: null as string | null, message: '尚未检查登录会话' };
let tail: Promise<unknown> = Promise.resolve();

export function xhsErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/profile appears to be in use|Singleton/i.test(message)) {
    return 'Chrome 登录会话目录被占用，请关闭其他登录窗口后重试';
  }
  if (/launchPersistentContext|SIGTRAP|crashpad|FD ownership/i.test(message)) {
    return 'Chrome 启动失败：NAS 容器浏览器异常，请稍后重试';
  }
  if (/小红书浏览器正在使用中|请先关闭小红书草稿操作窗口/.test(message)) return message;
  if (/net::ERR|page\.goto/i.test(message)) return '小红书页面连接失败，请检查 NAS 网络后重试';
  return '小红书登录页面尚未就绪，请稍后重新获取二维码';
}

function queue<T>(operation: () => Promise<T>): Promise<T> {
  const result = tail.then(operation);
  tail = result.catch(() => undefined);
  return result;
}

async function closeSession() {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  try { await publisher?.close(); }
  finally { publisher = null; image = null; state.active = false; }
}

async function switchAccountSession() {
  await closeSession();
  if (isXhsBrowserBusy()) throw new Error('请先关闭小红书草稿操作窗口，再切换账户');
  try {
    const backup = `${config.sessionDir}.backup-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
    await fs.rename(config.sessionDir, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(config.sessionDir, { recursive: true, mode: 0o700 });
  state = { active: false, loggedIn: false, account: null, message: '当前会话已切换，请登录新的小红书账户' };
  return { ...state, accountLabel: config.xhsAccount, expiresAt: null };
}

async function refreshState() {
  try {
  if (publisher) {
    if (Date.now() > expiresAt) { await closeSession(); state.message = '登录窗口已过期，请重新获取二维码'; }
    else {
      const result = await publisher.loginState();
      state = { ...result, active: !result.loggedIn, message: result.loggedIn ? '登录成功，会话已保存' : '请使用小红书 App 扫描下方二维码，并在手机上确认登录' };
      if (result.loggedIn) await closeSession();
      else image = await publisher.loginImage();
    }
  }
  return { ...state, accountLabel: config.xhsAccount, expiresAt: state.active ? new Date(expiresAt).toISOString() : null };
  } catch (error) {
    await closeSession();
    state = { active: false, loggedIn: false, account: null, message: xhsErrorMessage(error) };
    throw error;
  }
}

export const xhsLogin = {
  start: () => queue(async () => {
    if (publisher) return refreshState();
    publisher = new XhsPublisher();
    state = { ...state, active: true, loggedIn: false, message: '正在连接小红书' };
    expiresAt = Date.now() + 10 * 60000;
    try {
      await publisher.open(); await publisher.navigateLogin();
      expiryTimer = setTimeout(() => void queue(closeSession), 10 * 60000);
      return await refreshState();
    } catch (error) { await closeSession(); state.message = xhsErrorMessage(error); throw error; }
  }),
  status: () => queue(refreshState),
  image: () => image,
  cancel: () => queue(async () => { await closeSession(); state.message = '已关闭登录窗口'; return { ...state }; }),
  switchAccount: () => queue(switchAccountSession),
  check: () => queue(async () => {
    if (publisher) return refreshState();
    const checker = new XhsPublisher();
    try {
      await checker.open();
      const loggedIn = await checker.isLoggedIn();
      const details = await checker.loginState();
      state = { active: false, loggedIn, account: details.account, message: loggedIn ? '会话有效，已登录' : '未登录，请扫码登录' };
      return { ...state };
    } catch (error) {
      state = { active: false, loggedIn: false, account: null, message: xhsErrorMessage(error) };
      throw error;
    } finally { await checker.close(); }
  })
};
