// Node does not autoload .env. Import this module FIRST in index.js so that
// QWEN_CDP_URL (and every other setting in .env) is visible to config.js.
// Existing process.env values are never overwritten.
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.join(process.cwd(), '.env');

if (fs.existsSync(envPath)) {
    if (typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(envPath);
    } else {
        // Fallback for Node versions without process.loadEnvFile().
        for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const match = line.match(/^\s*(?:export\s+)?([^#=\s]+)\s*=\s*(.*?)\s*$/);
            if (!match) continue;
            const key = match[1];
            let value = match[2] || '';
            if ((value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (process.env[key] === undefined) process.env[key] = value;
        }
    }
}
