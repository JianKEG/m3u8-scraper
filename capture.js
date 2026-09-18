require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || '';
const BROWSER_EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH || '';
const MAX_CAPTURE_HISTORY = 20;

const TARGET_COUNT = Number(process.env.TARGET_COUNT || 0);
const TARGETS = Array.from({ length: TARGET_COUNT }, (_, index) => ({
  name: process.env[`TARGET_${index + 1}_NAME`],
  url: process.env[`TARGET_${index + 1}_URL`]
}));

const PATTERNS = ['.m3u8'];
const REFRESH_INTERVAL_MS = 4 * 60 * 1000;
const CAPTURE_RETRY_DELAY_MS = 30000;
const CAPTURE_TIMEOUT_MS = 30000;
const VALIDATION_TIMEOUT_MS = 15000;

if (TARGETS.length === 0 || TARGETS.length > 10) {
  throw new Error('Configure between 1 and 10 targets.');
}

const targetNames = new Set(TARGETS.map(target => target.name));
if (targetNames.size !== TARGETS.length || TARGETS.some(target => !target.name || !target.url)) {
  throw new Error('Each target must have a unique name and a URL.');
}

const states = Object.fromEntries(TARGETS.map(target => [target.name, {
  name: target.name,
  url: null,
  allCaptured: [],
  status: 'idle', // 'idle' | 'valid' | 'switching'
  nextRefreshAt: 0,
}]));

const captureLocks = new Map();
let browser = null;
let browserContext = null;

const app = express();
app.use(cors({
  origin: true,
  methods: ['GET', 'OPTIONS'],
  credentials: true,
}));

async function validateStreamUrl(url) {
  if (!url) return false;

  try {
    const ctx = await ensureBrowserContext();
    const page = await ctx.newPage();

    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: VALIDATION_TIMEOUT_MS,
      });

      if (!response) return false;
      if (response.status() >= 400) return false;

      const text = await response.text();
      const cleaned = typeof text === 'string' ? text.trim() : '';

      if (!cleaned || cleaned.includes('Content unavailable') || cleaned.includes('Forbidden')) {
        return false;
      }

      return cleaned.startsWith('#EXTM3U');
    } finally {
      await page.close();
    }
  } catch (error) {
    return false;
  }
}

async function ensureBrowserContext() {
  if (browserContext) return browserContext;

  const launchOptions = {
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions'
    ]
  };

  if (BROWSER_CHANNEL) launchOptions.channel = BROWSER_CHANNEL;
  if (BROWSER_EXECUTABLE_PATH) launchOptions.executablePath = BROWSER_EXECUTABLE_PATH;

  browser = await chromium.launch(launchOptions);
  browserContext = await browser.newContext();

  await browserContext.route('**/*', route => {
    const resourceType = route.request().resourceType();
    if (
      resourceType === 'image' ||
      resourceType === 'font' ||
      resourceType === 'stylesheet' ||
      resourceType === 'media'
    ) {
      return route.abort();
    }
    return route.continue();
  });

  return browserContext;
}

async function captureOneTarget(name) {
  const target = TARGETS.find(item => item.name === name);
  const state = states[name];
  if (!target || !state) {
    return null;
  }

  if (state.url) {
    const isHealthy = await validateStreamUrl(state.url);
    if (isHealthy) {
      state.status = 'valid';
      state.nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
      return state.url;
    }
  }

  const lock = captureLocks.get(name);
  if (lock) {
    return lock;
  }

  const runCapture = async () => {
    const ctx = await ensureBrowserContext();
    const page = await ctx.newPage();
    let foundThisRun = null;
    let resolveCapture;
    const captureFound = new Promise(resolve => { resolveCapture = resolve; });

    page.on('request', req => {
      const requestUrl = req.url().toLowerCase();
      if (PATTERNS.some(pattern => requestUrl.includes(pattern))) {
        foundThisRun = req.url();
        resolveCapture();
      }
    });
    page.on('response', response => {
      const responseUrl = response.url().toLowerCase();
      if (!foundThisRun && PATTERNS.some(pattern => responseUrl.includes(pattern))) {
        foundThisRun = response.url();
        resolveCapture();
      }
    });

    try {
      console.log(`[${name}] Capturing URL on demand...`);
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await Promise.race([
        captureFound,
        new Promise(resolve => setTimeout(resolve, CAPTURE_TIMEOUT_MS))
      ]);
    } finally {
      await page.close();
    }

    if (foundThisRun && foundThisRun !== state.url) {
      state.url = foundThisRun;
      state.allCaptured.push(foundThisRun);
      if (state.allCaptured.length > MAX_CAPTURE_HISTORY) {
        state.allCaptured.shift();
      }
      state.status = 'valid';
      state.nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
      console.log(`[${name}] Captured URL:`, foundThisRun);
      return foundThisRun;
    }

    if (foundThisRun) {
      state.status = 'valid';
      state.nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
      return foundThisRun;
    }

    state.status = 'idle';
    state.nextRefreshAt = Date.now() + CAPTURE_RETRY_DELAY_MS;
    return null;
  };

  const promise = runCapture();
  captureLocks.set(name, promise);
  try {
    return await promise;
  } finally {
    captureLocks.delete(name);
  }
}

app.get('/latest-url', async (req, res) => {
  const name = req.query.name || TARGETS[0].name;
  const state = states[name];
  if (!state) {
    return res.status(404).json({ error: `Unknown target: ${name}` });
  }

  if (!state.url) {
    const freshUrl = await captureOneTarget(name);
    if (!freshUrl) {
      return res.status(503).json({ error: `Stream URL is not ready for ${name}`, ...state });
    }
    state.url = freshUrl;
    return res.json(state);
  }

  const currentUrlIsValid = await validateStreamUrl(state.url);
  if (!currentUrlIsValid) {
    const freshUrl = await captureOneTarget(name);
    if (!freshUrl) {
      return res.status(503).json({ error: `Stream URL is not ready for ${name}`, ...state });
    }
    state.url = freshUrl;
  }

  res.json(state);
});

app.get('/latest-urls', (req, res) => {
  res.json(Object.values(states));
});

app.listen(PORT, HOST, () => console.log(`API running on http://${HOST}:${PORT}`));
