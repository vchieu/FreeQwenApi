import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const QWEN_CHAT_URL = process.env.QWEN_CHAT_URL || 'https://chat.qwen.ai/';
const QWEN_MODELS_API_URL = process.env.QWEN_MODELS_API_URL || 'https://chat.qwen.ai/api/v2/models';
const OUTPUT_FILE = process.env.QWEN_MODELS_FILE || path.join(process.cwd(), 'src', 'AvailableModels.txt');
const DOC_FILE = process.env.QWEN_MODELS_DOC || path.join(process.cwd(), 'docs', 'QWEN_CHAT_MODELS.md');

function uniq(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function readExistingModels(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

function extractPrerenderedJson(html) {
  const match = html.match(/window\.__prerendered_data\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!match) {
    throw new Error('Failed to find window.__prerendered_data in Qwen Chat HTML');
  }
  return JSON.parse(match[1]);
}

function capabilitiesOf(model) {
  const caps = model?.info?.meta?.capabilities || {};
  const labels = {
    audio: 'audio',
    document: 'documents',
    search: 'search',
    thinking: 'thinking mode',
    video: 'video',
    vision: 'vision'
  };
  return Object.entries(caps)
    .filter(([, enabled]) => Boolean(enabled))
    .map(([name]) => labels[name] || name)
    .sort();
}

async function fetchModelsFromBrowser() {
  const cdpUrl = process.env.QWEN_CDP_URL || 'http://127.0.0.1:9222';
  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.connect({ browserURL: cdpUrl });
  try {
    const page = (await browser.pages()).find(p => p.url().includes('chat.qwen.ai'));
    if (!page) throw new Error('No Qwen tab available');
    const models = await page.evaluate(() => window.__prerendered_data?.models || []);
    if (!Array.isArray(models) || !models.length) throw new Error('No models in Qwen tab');
    return models;
  } finally {
    browser.disconnect();
  }
}

function normalizeModels(models) {
  return models
    .map(model => ({
      id: model.id,
      name: model.name || model.id,
      capabilities: capabilitiesOf(model),
      description: model?.info?.meta?.short_description || model?.info?.meta?.description || ''
    }))
    .filter(model => model.id);
}

async function fetchQwenChatModels(useBrowser = false) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8'
  };
  const sources = [
    ...(useBrowser ? [{ browser: true }] : []),
    { url: QWEN_MODELS_API_URL, json: true },
    { url: QWEN_CHAT_URL, json: false }
  ];
  let lastError;

  for (const source of sources) {
    try {
      let models;
      if (source.browser) {
        models = await fetchModelsFromBrowser();
      } else {
        const response = await fetch(source.url, { headers });
        if (!response.ok) throw new Error(`Request to ${source.url} failed: HTTP ${response.status}`);
        if (source.json) {
          const data = await response.json();
          models = data?.data?.data || data?.data || [];
        } else {
          const data = extractPrerenderedJson(await response.text());
          models = data.models || [];
        }
      }
      if (!Array.isArray(models) || !models.length) throw new Error(`No models found in ${source.url || 'Qwen tab'}`);
      return normalizeModels(models);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function writeModelsFile(file, models) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${models.join('\n')}\n`, 'utf8');
}

function writeDocFile(file, discoveredModels, mergedIds, previousIds) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const discoveredIds = discoveredModels.map(model => model.id);
  const added = discoveredIds.filter(id => !previousIds.includes(id));
  const missingFromChat = previousIds.filter(id => !discoveredIds.includes(id));

  const lines = [];
  lines.push('# Qwen Chat Model Synchronization');
  lines.push('');
  lines.push('Source: prerendered model metadata from https://chat.qwen.ai/.');
  lines.push('');
  lines.push('## Models Currently Visible in Qwen Chat');
  lines.push('');
  for (const model of discoveredModels) {
    const caps = model.capabilities.length ? ` — ${model.capabilities.join(', ')}` : '';
    lines.push(`- \`${model.id}\`${caps}`);
  }
  lines.push('');
  lines.push('## Added by Latest Synchronization');
  lines.push('');
  if (added.length) {
    for (const id of added) lines.push(`- \`${id}\``);
  } else {
    lines.push('- No new models.');
  }
  lines.push('');
  lines.push('## Endpoint Models Not in Current Qwen Chat Landing Metadata');
  lines.push('');
  if (missingFromChat.length) {
    for (const id of missingFromChat) lines.push(`- \`${id}\``);
  } else {
    lines.push('- No such models.');
  }
  lines.push('');
  lines.push('## Final Combined Endpoint Model List');
  lines.push('');
  for (const id of mergedIds) lines.push(`- \`${id}\``);
  lines.push('');

  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

export async function syncModels(options = {}) {
  const existing = uniq(readExistingModels(OUTPUT_FILE));
  const discovered = await fetchQwenChatModels(Boolean(options.useBrowser));
  const discoveredIds = uniq(discovered.map(model => model.id));
  const merged = uniq([...discoveredIds, ...existing]);

  writeModelsFile(OUTPUT_FILE, merged);
  writeDocFile(DOC_FILE, discovered, merged, existing);

  const added = discoveredIds.filter(id => !existing.includes(id));
  return { discovered: discoveredIds.length, merged: merged.length, added };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  syncModels().then(({ discovered, merged, added }) => {
    console.log(`Found Qwen Chat models: ${discovered}`);
    console.log(`Endpoint model list saved: ${merged} models -> ${OUTPUT_FILE}`);
    console.log(`Synchronization report saved: ${DOC_FILE}`);
    if (added.length) console.log(`New models: ${added.join(', ')}`);
  }).catch(error => {
    console.error(`Model synchronization failed: ${error.message}`);
    process.exit(1);
  });
}
