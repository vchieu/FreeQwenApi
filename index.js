import './src/env.js';
import express from 'express';
import bodyParser from 'body-parser';

import { initBrowser, shutdownBrowser } from './src/browser/browser.js';
import apiRoutes from './src/api/routes.js';
import { getAvailableModelsFromFile, getApiKeys } from './src/api/chat.js';
import { syncModels } from './scripts/core/sync_models.js';
import { logHttpRequest, logInfo, logError, logWarn } from './src/logger/index.js';
import { FORGETMEAI_WATERMARK } from './src/utils/branding.js';
import { PORT, HOST } from './src/config.js';

const app = express();

const port = Number.parseInt(process.env.PORT ?? PORT, 10);
const host = process.env.HOST || HOST;

if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
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
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Qwen-Sync');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Single-account mode: no dashboard UI. The root just points at the API.
app.get(['/', '/dashboard'], (req, res) => {
    res.json({
        service: 'FreeQwenApi',
        watermark: FORGETMEAI_WATERMARK,
        api: '/api',
        health: '/api/health',
        status: '/api/status'
    });
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
██      ██   ██ ██      ██      ██    ██ ██ ███ ██ ██      ██  ██ ██ ██   ██ ██   ██ ██ 
██      ██   ██ ███████ ███████  ██████   ███ ███  ███████ ██   ████ ██   ██ ██      ██ 
                                    ▀▀                                                    
   Qwen API Proxy
   ${FORGETMEAI_WATERMARK}
`);

    logInfo('Starting server (single-account mode)...');

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
