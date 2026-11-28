#!/usr/bin/env node
// One-command launcher: real Chrome over CDP + the proxy.
//
//   npm run start:cdp
//
// Chrome uses a dedicated profile so the Qwen login persists across restarts.
// First run: log in to Qwen in the window that opens, then send requests.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CDP_PORT = process.env.QWEN_CDP_PORT || '9222';
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const PROFILE_DIR = path.join(os.tmpdir(), 'freeqwenapi-chrome-cdp');

const CHROME_PATHS = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function cdpReady() {
    try {
        const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

async function ensureChrome() {
    if (await cdpReady()) {
        console.log(`[start:cdp] Reusing Chrome at ${CDP_URL}`);
        return null;
    }

    const chrome = CHROME_PATHS.find(p => fs.existsSync(p));
    if (!chrome) throw new Error('Chrome not found. Set CHROME_PATH to chrome.exe.');

    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    console.log(`[start:cdp] Starting Chrome with profile: ${PROFILE_DIR}`);

    const child = spawn(chrome, [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        'https://chat.qwen.ai',
    ], { stdio: 'ignore' });

    for (let i = 0; i < 40; i++) {
        if (await cdpReady()) return child;
        await delay(500);
    }
    throw new Error(`Chrome did not expose CDP at ${CDP_URL}`);
}

async function main() {
    const chrome = await ensureChrome();

    const proxy = spawn(process.execPath, ['index.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            QWEN_CDP_URL: CDP_URL
        },
        stdio: 'inherit',
    });

    const shutdown = () => {
        if (!proxy.killed) proxy.kill();
        if (chrome && !chrome.killed) chrome.kill();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    proxy.on('exit', (code) => {
        if (chrome && !chrome.killed) chrome.kill();
        process.exit(code ?? 0);
    });
}

main().catch(err => {
    console.error(`[start:cdp] ${err.message}`);
    process.exit(1);
});
