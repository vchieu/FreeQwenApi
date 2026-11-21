import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { initBrowser, shutdownBrowser, getBrowserContext } from '../browser/browser.js';
import { extractAuthToken } from '../api/chat.js';
import { loadTokens, saveTokens, markValid, removeToken } from '../api/tokenManager.js';
import { loadAuthToken } from '../browser/session.js';
import { logInfo, logError, logWarn } from '../logger/index.js';
import { prompt } from './prompt.js';
import { formatForgetMeAiWatermark } from './branding.js';
import { SESSION_DIR, ACCOUNTS_DIR } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ensureAccountDir(id) {
    const accountDir = path.resolve(__dirname, '..', '..', SESSION_DIR, ACCOUNTS_DIR, id);
    if (!fs.existsSync(accountDir)) fs.mkdirSync(accountDir, { recursive: true });
    return accountDir;
}

export async function addAccountInteractive() {
    logInfo('======================================================');
    logInfo('Adding new Qwen account');
    logInfo(formatForgetMeAiWatermark());
    logInfo('Browser will open, log in, then return to console.');
    logInfo('======================================================');

    const ok = await initBrowser(true, true);
    if (!ok) {
        logError('Failed to start browser.');
        return null;
    }

    const ctx = getBrowserContext();
    let token = await extractAuthToken(ctx, true);

    if (!token) {
        token = loadAuthToken();
        if (token) logInfo('Token received from saved file.');
    }

    if (!token) {
        logError('Token was not received. Account not added.');
        await shutdownBrowser();
        return null;
    }

    await shutdownBrowser();

    const id = 'acc_' + Date.now();
    ensureAccountDir(id);
    fs.writeFileSync(path.resolve(__dirname, '..', '..', SESSION_DIR, ACCOUNTS_DIR, id, 'token.txt'), token, 'utf8');

    const list = loadTokens();
    list.push({ id, token, resetAt: null });
    saveTokens(list);

    logInfo(`Account '${id}' added. Total accounts: ${list.length}`);
    logInfo('======================================================');
    return id;
}

export async function interactiveAccountMenu() {
    while (true) {
        console.log('\n=== Account management menu ===');
        console.log(formatForgetMeAiWatermark());
        console.log('1 - Add new account');
        console.log('2 - Finish');
        const choice = await prompt('Your choice (1/2): ');
        if (choice === '1') await addAccountInteractive();
        else if (choice === '2') break;
        else console.log('Invalid choice.');
    }
}

export async function reloginAccountInteractive() {
    const tokens = loadTokens();
    const invalids = tokens.filter(t => t.invalid);
    if (!invalids.length) {
        console.log('No accounts require re-login.');
        await prompt('Press ENTER to return to menu...');
        return;
    }

    console.log('\nAccounts with expired token:');
    invalids.forEach((t, idx) => console.log(`${idx + 1} - ${t.id}`));
    const choice = await prompt('Enter account number to re-login: ');
    const num = parseInt(choice, 10);
    if (isNaN(num) || num < 1 || num > invalids.length) {
        console.log('Invalid choice.');
        return;
    }
    const account = invalids[num - 1];

    logInfo(`Re-authorization for ${account.id}`);
    logInfo(formatForgetMeAiWatermark());
    const ok = await initBrowser(true, true);
    if (!ok) { logError('Failed to start browser.'); return; }

    const token = await extractAuthToken(getBrowserContext(), true);
    await shutdownBrowser();

    if (!token) { logError('Failed to extract token.'); return; }

    markValid(account.id, token);
    fs.writeFileSync(path.resolve(__dirname, '..', '..', SESSION_DIR, ACCOUNTS_DIR, account.id, 'token.txt'), token, 'utf8');
    logInfo(`Token updated for ${account.id}`);
}

export async function removeAccountInteractive() {
    const tokens = loadTokens();
    if (!tokens.length) {
        console.log('No saved accounts.');
        await prompt('Press ENTER to return...');
        return;
    }

    console.log('\nAvailable accounts:');
    tokens.forEach((t, idx) => console.log(`${idx + 1} - ${t.id}`));
    const choice = await prompt('Account number to remove (or ENTER to cancel): ');
    if (!choice) return;
    const num = parseInt(choice, 10);
    if (isNaN(num) || num < 1 || num > tokens.length) {
        console.log('Invalid choice.');
        await prompt('Press ENTER to return...');
        return;
    }

    const acc = tokens[num - 1];
    const confirm = await prompt(`Delete ${acc.id} definitively? (y/N): `);
    if (confirm.toLowerCase() !== 'y') return;

    removeToken(acc.id);
    const dir = path.resolve(__dirname, '..', '..', SESSION_DIR, ACCOUNTS_DIR, acc.id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

    logInfo(`Account ${acc.id} removed.`);
    await prompt('Press ENTER to return...');
}
