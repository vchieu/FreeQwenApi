#!/usr/bin/env node

import { loadTokens } from '../../src/api/tokenManager.js';
import { addAccountInteractive, reloginAccountInteractive, removeAccountInteractive } from '../../src/utils/accountSetup.js';
import { formatForgetMeAiWatermark } from '../../src/utils/branding.js';
import { prompt } from '../../src/utils/prompt.js';

function printDivider() {
    console.log('======================================================');
}

const STATUS_CODES = {
    INVALID: 0,
    WAIT: 1,
    OK: 2
};

function formatStatus(token) {
    const now = Date.now();
    if (token.invalid) {
        return { code: STATUS_CODES.INVALID, label: '❌ Invalid' };
    }
    if (token.resetAt && new Date(token.resetAt).getTime() > now) {
        return { code: STATUS_CODES.WAIT, label: '⏳ Waiting for reset' };
    }
    return { code: STATUS_CODES.OK, label: '✅ OK' };
}

function printAccounts(tokens) {
    console.log('\nAccount list:');
    if (!tokens.length) {
        console.log('  (empty)');
        return;
    }

    tokens.forEach((token, index) => {
        const status = formatStatus(token);
        console.log(`${String(index + 1).padStart(2, ' ')} | ${token.id} | ${status.label} (${status.code})`);
    });
}

function handleList(tokens) {
    console.log(formatForgetMeAiWatermark());
    printAccounts(tokens);
    const active = tokens.filter(t => formatStatus(t).code === STATUS_CODES.OK);
    console.log(`\nActive accounts: ${active.length} of ${tokens.length}`);
}

function parseArgs(argv) {
    const args = new Set(argv.slice(2));
    if (args.has('--help') || args.has('-h')) return 'help';
    if (args.has('--list')) return 'list';
    if (args.has('--add')) return 'add';
    if (args.has('--relogin')) return 'relogin';
    if (args.has('--remove')) return 'remove';
    return null;
}

function printHelp() {
    printDivider();
    console.log('Qwen account management script');
    console.log(formatForgetMeAiWatermark());
    printDivider();
    console.log('Usage:');
    console.log('  --list      Show account list and statuses');
    console.log('  --add       Add new account');
    console.log('  --relogin   Relogin account with expired token');
    console.log('  --remove    Remove account');
    console.log('Without options, interactive menu starts.');
    printDivider();
}

async function runCliAction(action) {
    if (action === 'help') {
        printHelp();
        return;
    }

    if (action === 'list') {
        const tokens = loadTokens();
        handleList(tokens);
        return;
    }

    if (action === 'add') {
        await addAccountInteractive();
        return;
    }

    if (action === 'relogin') {
        await reloginAccountInteractive();
        return;
    }

    if (action === 'remove') {
        await removeAccountInteractive();
        return;
    }
}

async function runInteractiveMenu() {
    while (true) {
        const tokens = loadTokens();
        printDivider();
        console.log(formatForgetMeAiWatermark());
        printAccounts(tokens);
        printDivider();
        console.log('Menu:');
        console.log('1 - Add new account');
        console.log('2 - Relogin account with expired token');
        console.log('3 - Remove account');
        console.log('4 - Show list and statuses');
        console.log('5 - Exit');
        const choice = await prompt('Your choice (Enter = 5): ');
        const normalized = choice || '5';

        if (normalized === '1') {
            await addAccountInteractive();
        } else if (normalized === '2') {
            await reloginAccountInteractive();
        } else if (normalized === '3') {
            await removeAccountInteractive();
        } else if (normalized === '4') {
            handleList(tokens);
            await prompt('\nPress Enter to return to menu...');
        } else if (normalized === '5') {
            console.log('Exiting script.');
            break;
        }
    }
}

(async () => {
    const action = parseArgs(process.argv);
    if (action) {
        await runCliAction(action);
        return;
    }

    await runInteractiveMenu();
})();
