import './src/env.js';
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import { initBrowser, shutdownBrowser } from './src/browser/browser.js';
import apiRoutes from './src/api/routes.js';
import { getAvailableModelsFromFile, getApiKeys } from './src/api/chat.js';
import { loadTokens } from './src/api/tokenManager.js';
import { syncModels } from './scripts/core/sync_models.js';
import { addAccountInteractive } from './src/utils/accountSetup.js';
import { logHttpRequest, logInfo, logError, logWarn } from './src/logger/index.js';
import { prompt } from './src/utils/prompt.js';
import { FORGETMEAI_WATERMARK } from './src/utils/branding.js';
import { PORT, HOST } from './src/config.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const port = Number.parseInt(process.env.PORT ?? PORT, 10);
const host = process.env.HOST || HOST;

if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

function toBoolean(value) {
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

const skipAccountMenu = toBoolean(process.env.SKIP_ACCOUNT_MENU) || toBoolean(process.env.NON_INTERACTIVE);

function ensureNonInteractiveTokens() {
    const tokens = loadTokens();
    if (!tokens.length) {
        logError('No accounts found. Run the auth script before starting the server.');
        process.exit(1);
    }
    const now = Date.now();
    const validTokens = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);
    if (!validTokens.length) {
        // The short-lived token in the logged-in Qwen tab can still be usable
        // even when every stored account is marked invalid; let the browser
        // token path clear the flags instead of refusing to start.
        logWarn('All stored accounts are unavailable; relying on the Qwen tab token.');
        return;
    }
    logInfo(`Auto-start: detected ${tokens.length} accounts, ${validTokens.length} active.`);
}

app.use(logHttpRequest);
app.use(bodyParser.json({ limit: '150mb' }));
app.use(bodyParser.urlencoded({ limit: '150mb', extended: true }));

app.use((err, req, res, next) => {
    const isJsonSyntaxError = err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, 'body');

    if (isJsonSyntaxError) {
        logWarn(`Invalid JSON in request: ${err.message}`);
        return res.status(400).json({
            error: 'Invalid JSON',
            message: 'Check the request body: use valid JSON with double quotes.'
        });
    }

    return next(err);
});

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.get(['/', '/dashboard'], (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'dashboard', 'index.html'));
});

app.use('/api', apiRoutes);

app.use((req, res) => {
    logWarn(`404 Not Found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
    logError('Internal server error', err);
    res.status(500).json({ error: 'Internal server error' });
});

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
process.on('SIGHUP', handleShutdown);
process.on('uncaughtException', async (error) => {
    logError('Unhandled exception', error);
    await handleShutdown();
});

async function handleShutdown() {
    logInfo('\nShutdown signal received. Closing browser...');
    await shutdownBrowser();
    logInfo('Shutting down.');
    process.exit(0);
}

async function startServer() {
    console.log(`
███████ ██████  ███████ ███████  ██████  ██     ██ ███████ ███    ██  █████  ██████  ██ 
██      ██   ██ ██      ██      ██    ██ ██     ██ ██      ████   ██ ██   ██ ██   ██ ██ 
█████   ██████  █████   █████   ██    ██ ██  █  ██ █████   ██ ██  ██ ███████ ██████  ██ 
██      ██   ██ ██      ██      ██ ▄▄ ██ ██ ███ ██ ██      ██  ██ ██ ██   ██ ██      ██ 
██      ██   ██ ███████ ███████  ██████   ███ ███  ███████ ██   ████ ██   ██ ██      ██ 
                                    ▀▀                                                    
   Qwen API Proxy
   ${FORGETMEAI_WATERMARK}
`);

    logInfo('Starting server...');

    if (!skipAccountMenu) {
        while (true) {
            const tokens = loadTokens();
            console.log('\nAccount list:');
            if (!tokens.length) {
                console.log('  (empty)');
            } else {
                tokens.forEach((token, i) => {
                    const now = Date.now();
                    const isInvalid = token.invalid === true;
                    const isWaiting = Boolean(token.resetAt && new Date(token.resetAt).getTime() > now);
                    const statusLabel = isInvalid ? '❌ Invalid' : isWaiting ? '⏳ Waiting to reset' : '✅ OK';
                    const statusCode = isInvalid ? 0 : isWaiting ? 1 : 2;
                    console.log(`${String(i + 1).padStart(2, ' ')} | ${token.id} | ${statusLabel} (${statusCode})`);
                });
            }
            console.log('\n=== Menu ===');
            console.log(`ForgetMeAI: ${FORGETMEAI_WATERMARK}`);
            console.log('1 - Add new account');
            console.log('2 - Relogin account with expired token');
            console.log('3 - Start proxy (default)');
            console.log('4 - Remove account');

            let choice = await prompt('Your choice (Enter = 3): ');
            if (!choice) choice = '3';

            if (choice === '1') {
                await addAccountInteractive();
            } else if (choice === '2') {
                const { reloginAccountInteractive } = await import('./src/utils/accountSetup.js');
                await reloginAccountInteractive();
            } else if (choice === '3') {
                const hasValidToken = tokens.some(t => {
                    if (t.invalid) return false;
                    if (!t.resetAt) return true;
                    return new Date(t.resetAt).getTime() <= Date.now();
                });
                if (!tokens.length || !hasValidToken) {
                    console.log('At least one valid account is needed to start.');
                    continue;
                }
                break;
            } else if (choice === '4') {
                const { removeAccountInteractive } = await import('./src/utils/accountSetup.js');
                await removeAccountInteractive();
            }
        }
    } else {
        ensureNonInteractiveTokens();
    }

    // Qwen blocks headless automation (CDP evaluate hangs). Allow a headed run
    // via QWEN_VISIBLE=1 so the page renders normally and any one-time
    // verification can be passed; the session then persists.
    const visibleMode = ['1', 'true', 'yes', 'on'].includes(String(process.env.QWEN_VISIBLE || '').toLowerCase());
    const browserInitialized = await initBrowser(visibleMode);
    if (!browserInitialized) {
        logError('Failed to initialize browser. Shutting down.');
        process.exit(1);
    }

    // Refresh the current Qwen model list once per server start, using the
    // logged-in tab when available (the public API exposes fewer models).
    try {
        const models = await syncModels({ useBrowser: true });
        logInfo(`Model list refreshed at startup: ${models.merged} models (${models.discovered} found in Qwen Chat)`);
        if (models.added.length) logInfo(`New models: ${models.added.join(', ')}`);
    } catch (error) {
        logWarn(`Startup model sync failed: ${error.message}`);
    }

    try {
        app.listen(port, host, () => {
            const displayHost = host === '0.0.0.0' ? 'localhost' : host;
            logInfo(`Server started on ${host}:${port}`);
            logInfo(`API available at: http://${displayHost}:${port}/api`);
            logInfo('To check auth status: GET /api/status');
            logInfo('To send message: POST /api/chat');
            logInfo('To get model list: GET /api/models');
            logInfo('======================================================');
            logInfo('API v2 - Chat history is stored on Qwen servers');
            logInfo('Create new chat: POST /api/chats');
            logInfo('Send message: POST /api/chat (with chatId and parentId)');
            logInfo('======================================================');
            logInfo('Available Qwen models: 25 (via mapping system):');
            logInfo('- Standard: qwen-max, qwen-plus, qwen-turbo and their latest versions');
            logInfo('- Coder: qwen3-coder-plus, qwen2.5-coder-*b-instruct (0.5b - 32b)');
            logInfo('- Visual: qwen-vl-max, qwen-vl-plus and their latest versions');
            logInfo('- Qwen 3: qwen3, qwen3-max, qwen3-plus, qwen3-omni-flash');
            logInfo('- Qwen 3.5: qwen3.5-plus, qwen3.5-flash, qwen3.5-397b-a17b, qwen3.5-122b-a10b, qwen3.5-27b, qwen3.5-35b-a3b');
            logInfo('======================================================');
            logInfo('Chat request JSON format:');
            logInfo('{ "message": "message text", "model": "model name (optional)", "chatId": "chat ID (optional)", "parentId": "parent message ID (optional)" }');
            logInfo('First request example: { "message": "Hello, how are you?" }');
            logInfo('Second request example: { "message": "What do you know?", "chatId": "received_chat_id", "parentId": "received_parentId" }');
            logInfo('======================================================');
            logInfo('OpenAI-compatible API support: POST /api/chat/completions');
            logInfo('The response returns chatId and parentId to continue the dialogue');
            logInfo('======================================================');

            getApiKeys();
            getAvailableModelsFromFile();
        });
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            logError(`Port ${port} is already in use. The server may already be running.`);
            await shutdownBrowser();
            process.exit(1);
        }
        throw err;
    }
}

startServer().catch(async error => {
    logError('Error starting server', error);
    await shutdownBrowser();
    process.exit(1);
});
