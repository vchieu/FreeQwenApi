import { saveSession } from './session.js';
import { setAuthenticationStatus, getAuthenticationStatus, restartBrowserInHeadlessMode } from './browser.js';
import { extractAuthToken } from '../api/chat.js';
import { logInfo, logError, logWarn } from '../logger/index.js';
import { CHAT_PAGE_URL, AUTH_SIGNIN_URL, PAGE_TIMEOUT, RETRY_DELAY } from '../config.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isPlaywright(context) {
    return context && typeof context.newPage === 'function';
}

async function getPage(context) {
    if (context && typeof context.goto === 'function') return context;
    if (context && typeof context.newPage === 'function') return await context.newPage();
    throw new Error('Invalid context: not a Puppeteer instance, not a Playwright context');
}

async function promptUser(question) {
    return new Promise(resolve => {
        process.stdout.write(question);
        const onData = (data) => {
            process.stdin.removeListener('data', onData);
            process.stdin.pause();
            resolve(data.toString().trim());
        };
        process.stdin.resume();
        process.stdin.once('data', onData);
    });
}

async function countLoginContainers(page, isPW) {
    if (isPW) return page.locator('.login-container').count();
    return (await page.$$('.login-container')).length;
}

export async function checkAuthentication(context) {
    try {
        if (getAuthenticationStatus()) return true;

        const page = await getPage(context);
        const isPW = isPlaywright(context);

        logInfo('Checking authentication...');

        try {
            await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            if (isPW) await page.waitForLoadState('domcontentloaded');
            await delay(RETRY_DELAY);

            const pageTitle = await page.title();
            if (pageTitle.includes('Verification')) {
                logWarn('Verification stage detected. Please pass the verification in the browser.');
                await promptUser('After passing verification, press ENTER to continue...');
                logInfo('Verification confirmed by user.');
            }

            const loginCount = await countLoginContainers(page, isPW);

            if (loginCount === 0) {
                logInfo('Authentication detected');
                setAuthenticationStatus(true);
                try {
                    await extractAuthToken(context, true);
                    await saveSession(context);
                    logInfo('Session updated');
                } catch (e) { logError('Failed to update session', e); }
                if (isPW) await page.close();
                return true;
            }

            console.log('------------------------------------------------------');
            console.log('               MANUAL AUTHENTICATION REQUIRED');
            console.log('------------------------------------------------------');
            console.log('1. Log in to the system via GitHub or another method in the opened browser');
            console.log('2. Wait for the authentication process to complete');
            console.log('3. Press ENTER in this console');
            console.log('------------------------------------------------------');

            await promptUser('After successful authentication, press ENTER to continue...');
            logInfo('User confirmed authentication completion.');

            await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            await delay(3000);

            const loginCountAfter = await countLoginContainers(page, isPW);

            if (loginCountAfter === 0) {
                logInfo('Authentication confirmed.');
                setAuthenticationStatus(true);
                await saveSession(context);
                await extractAuthToken(context, true);
                if (isPW) await page.close();
                return true;
            }

            logWarn('Authentication not detected.');
            setAuthenticationStatus(false);
            return false;
        } catch (error) {
            if (isPW) await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Error checking authentication', error);
        setAuthenticationStatus(false);
        return false;
    }
}

export async function startManualAuthentication(context, skipRestart = false) {
    try {
        const page = await getPage(context);
        const isPW = isPlaywright(context);

        logInfo('Opening page for manual authentication...');

        try {
            await page.goto(AUTH_SIGNIN_URL, { waitUntil: 'load', timeout: PAGE_TIMEOUT });

            console.log('------------------------------------------------------');
            console.log('               MANUAL AUTHENTICATION REQUIRED');
            console.log('------------------------------------------------------');
            console.log('1. Log in to the system in the opened browser');
            console.log('2. Wait for the authentication process to complete');
            console.log('3. Press ENTER in this console');
            console.log('------------------------------------------------------');

            await promptUser('After successful authentication, press ENTER to continue...');

            await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            await delay(RETRY_DELAY);

            const loginCount = await countLoginContainers(page, isPW);

            if (loginCount === 0) {
                logInfo('Authentication confirmed.');
                setAuthenticationStatus(true);
                await saveSession(context);
                await extractAuthToken(context, true);
                logInfo('Session saved successfully!');
                if (isPW) await page.close();
                if (!skipRestart) await restartBrowserInHeadlessMode();
                return true;
            }

            logWarn('Authentication failed.');
            setAuthenticationStatus(false);
            return false;
        } catch (error) {
            if (isPW) await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Error during manual authentication', error);
        setAuthenticationStatus(false);
        return false;
    }
}

export async function checkVerification(page) {
    try {
        const pageTitle = await page.title();
        if (pageTitle.includes('Verification')) {
            logWarn('Verification stage detected');
            await promptUser('Please pass the verification and press ENTER...');
            return true;
        }
        return false;
    } catch { return false; }
}
