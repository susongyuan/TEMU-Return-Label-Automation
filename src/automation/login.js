const { config } = require('../env');
const { clickByText, pageText, redact, sleep } = require('./common');

const loginSignals = {
  eccang: /登录|验证码|密码|手机号|用户中心|login/i,
  goodcang: /登录|验证码|密码|账号|login|GoodDeal/i,
  winit: /登录|验证码|密码|邮箱|login|万邑联/i
};

function isTransientFrameError(error) {
  return /detached frame|Execution context is not available|Cannot find context|Target closed|Frame was detached/i.test(error?.message || '');
}

async function waitForPageToSettle(page, delayMs = 700) {
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
    sleep(delayMs)
  ]);
}

async function retryTransientFrame(operation, page, retries = 4) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientFrameError(error) || attempt === retries) throw error;
      await waitForPageToSettle(page, 700 + attempt * 300);
    }
  }
  throw lastError;
}

function credentialFor(platform) {
  const credentials = config.credentials[platform];
  if (!credentials?.username || !credentials?.password) {
    throw new Error(`${platform} credentials are missing`);
  }
  return credentials;
}

async function looksLoggedIn(page, platform) {
  try {
    return await retryTransientFrame(async () => {
      const url = page.url();
      const text = await pageText(page);
      if (/\/login|User\/login|passport|signin/i.test(url)) return false;
      if (platform === 'eccang') return /订单|采购|仓储|报表|ERP|首页|设置/.test(text) && !/请输入密码/.test(text);
      if (platform === 'goodcang') return /首页|退货|订单|海外仓|库存|财务/.test(text) && !/请输入密码/.test(text);
      if (platform === 'winit') return /订单|仓储|退货|出库|财务|报表/.test(text) && !/请输入密码/.test(text);
      return !loginSignals[platform]?.test(text);
    }, page, 2);
  } catch (error) {
    if (isTransientFrameError(error)) return false;
    throw error;
  }
}

async function findLoginInputs(page) {
  return retryTransientFrame(() => page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).filter(input => {
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !input.disabled;
    });
    const describe = input => [
      input.type,
      input.placeholder,
      input.name,
      input.id,
      input.getAttribute('aria-label'),
      input.parentElement?.innerText
    ].filter(Boolean).join(' ');
    const password = inputs.find(input => input.type === 'password');
    const username = inputs.find(input => {
      if (input === password) return false;
      return /(账号|用户|手机|邮箱|email|phone|user|account|login)/i.test(describe(input));
    }) || inputs.find(input => input !== password && ['text', 'email', 'tel', ''].includes(input.type));
    return {
      usernameIndex: inputs.indexOf(username),
      passwordIndex: inputs.indexOf(password),
      count: inputs.length
    };
  }), page, 3);
}

async function waitForLoginInputs(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = { usernameIndex: -1, passwordIndex: -1, count: 0 };
  while (Date.now() < deadline) {
    try {
      last = await findLoginInputs(page);
    } catch (error) {
      if (!isTransientFrameError(error)) throw error;
      await waitForPageToSettle(page);
    }
    if (last.usernameIndex >= 0 && last.passwordIndex >= 0) return last;
    await sleep(500);
  }
  return last;
}

async function fillInputByIndex(page, index, value) {
  const handle = await retryTransientFrame(() => page.evaluateHandle(inputIndex => {
    const inputs = Array.from(document.querySelectorAll('input')).filter(input => {
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !input.disabled;
    });
    return inputs[inputIndex] || null;
  }, index), page, 3);
  const input = handle.asElement();
  if (!input) return false;
  await input.click({ clickCount: 3 }).catch(() => {});
  await input.press('Control+A').catch(() => {});
  await input.press('Backspace').catch(() => {});
  await input.type(value, { delay: 25 });
  return true;
}

async function detectCaptcha(page) {
  try {
    const text = await retryTransientFrame(() => pageText(page), page, 2);
    return /验证码|滑块|captcha|安全验证|人机验证|短信/.test(text);
  } catch (error) {
    if (isTransientFrameError(error)) return false;
    throw error;
  }
}

async function loginIfNeeded(page, platform) {
  if (await looksLoggedIn(page, platform)) {
    return { ok: true, alreadyLoggedIn: true };
  }

  const credentials = credentialFor(platform);
  const inputs = await waitForLoginInputs(page);
  if (inputs.usernameIndex < 0 || inputs.passwordIndex < 0) {
    if (await detectCaptcha(page)) {
      throw new Error(`${platform} requires manual captcha/security verification`);
    }
    throw new Error(`${platform} login inputs not found`);
  }

  await fillInputByIndex(page, inputs.usernameIndex, credentials.username);
  await fillInputByIndex(page, inputs.passwordIndex, credentials.password);
  await clickByText(page, [/登\s*录|Login|Sign in|进入/], { waitAfterMs: 1000 });
  await page.keyboard.press('Enter').catch(() => {});
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
    sleep(3000)
  ]);

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await looksLoggedIn(page, platform)) {
      return { ok: true, alreadyLoggedIn: false, username: redact(credentials.username) };
    }
    if (await detectCaptcha(page)) {
      throw new Error(`${platform} requires manual captcha/security verification`);
    }
    await sleep(1000);
  }
  throw new Error(`${platform} login did not complete`);
}

module.exports = {
  isTransientFrameError,
  loginIfNeeded,
  looksLoggedIn
};
