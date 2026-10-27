import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({
  open: vi.fn(), close: vi.fn(), navigateLogin: vi.fn(), isLoggedIn: vi.fn(),
  loginState: vi.fn(), loginImage: vi.fn()
}));

vi.mock('../src/xhs.js', () => ({
  XhsPublisher: class {
    open = browser.open;
    close = browser.close;
    navigateLogin = browser.navigateLogin;
    isLoggedIn = browser.isLoggedIn;
    loginState = browser.loginState;
    loginImage = browser.loginImage;
  }
}));

import { xhsLogin, xhsErrorMessage } from '../src/xhs-login.js';

beforeEach(() => {
  vi.resetAllMocks();
  browser.open.mockResolvedValue(undefined);
  browser.close.mockResolvedValue(undefined);
  browser.navigateLogin.mockResolvedValue(undefined);
  browser.isLoggedIn.mockResolvedValue(false);
  browser.loginState.mockResolvedValue({ loggedIn: false, account: null });
  browser.loginImage.mockResolvedValue(Buffer.from('login screenshot'));
});

afterEach(async () => { await xhsLogin.cancel(); });

describe('XHS login recovery', () => {
  it('releases a failed startup so the next attempt can obtain a QR image', async () => {
    const error = new Error('browserType.launchPersistentContext: chrome_crashpad_handler: --database is required');
    browser.open.mockRejectedValueOnce(error);
    await expect(xhsLogin.start()).rejects.toBe(error);
    expect(await xhsLogin.status()).toMatchObject({ active: false, loggedIn: false, message: expect.stringContaining('Chrome 启动失败') });
    expect(xhsLogin.image()).toBeNull();
    expect(await xhsLogin.start()).toMatchObject({ active: true, loggedIn: false });
    expect(xhsLogin.image()).not.toBeNull();
  });

  it('recovers after a screenshot failure while polling an active session', async () => {
    await xhsLogin.start();
    browser.loginImage.mockRejectedValueOnce(new Error('Target page, context or browser has been closed'));
    await expect(xhsLogin.status()).rejects.toThrow('has been closed');
    expect(xhsLogin.image()).toBeNull();
    expect(await xhsLogin.status()).toMatchObject({ active: false, loggedIn: false });
    expect(await xhsLogin.start()).toMatchObject({ active: true });
    expect(browser.open).toHaveBeenCalledTimes(2);
  });

  it('closes temporary browsers after a failed check and allows checking again', async () => {
    browser.isLoggedIn.mockRejectedValueOnce(new Error('page.goto: net::ERR_CONNECTION_RESET'));
    await expect(xhsLogin.check()).rejects.toThrow('ERR_CONNECTION_RESET');
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(await xhsLogin.status()).toMatchObject({ active: false, message: expect.stringContaining('网络') });
    expect(await xhsLogin.check()).toMatchObject({ active: false, loggedIn: false });
    expect(browser.close).toHaveBeenCalledTimes(2);
  });

  it('reuses an active login browser for concurrent start and check requests', async () => {
    const [first, second, check] = await Promise.all([xhsLogin.start(), xhsLogin.start(), xhsLogin.check()]);
    expect([first.active, second.active, check.active]).toEqual([true, true, true]);
    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(browser.isLoggedIn).not.toHaveBeenCalled();
  });

  it('saves a successful login and clears the QR image without clearing the account', async () => {
    await xhsLogin.start();
    browser.loginState.mockResolvedValueOnce({ loggedIn: true, account: '摄影账号' });
    expect(await xhsLogin.status()).toMatchObject({ active: false, loggedIn: true, account: '摄影账号' });
    expect(xhsLogin.image()).toBeNull();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('distinguishes startup errors from network errors without exposing browser logs', () => {
    const startup = xhsErrorMessage(new Error('browserType.launchPersistentContext: Timeout 30000ms exceeded. /private/profile'));
    expect(startup).toContain('Chrome 启动失败');
    expect(startup).not.toContain('/private/profile');
    expect(startup).not.toContain('占用');
    expect(xhsErrorMessage(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED'))).toContain('网络');
  });
});
