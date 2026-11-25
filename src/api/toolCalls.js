// Tool-call parsing/normalization for Qwen -> OpenAI-compatible responses.
// Pure module (no I/O) so scripts/core/verify-tools.mjs can verify offline.
// Mirrors the in-page SSE constraints by keeping logic dependency-free.
//
// messagesToQwenPrompt() ports the Python qwen-web2api tools.py approach:
//   flatten messages -> one prompt with a pinned '# Tool Use' block, then
//   model outputs ```tool_call fences which parseToolCalls() decodes.

import crypto from 'crypto';

const FENCE_OPEN = /```(tool_call|function_call|tool_code|json)(?![A-Za-z0-9_])[ \t]*\n?/gi;
const FENCE_CLOSE = /\s*```/g;
const XML_TAG_OPEN = /<tool_call>[ \t]*\n?/gi;
const XML_TAG_CLOSE = /\s*<\/tool_call>/gi;
const XML_FUNC_OPEN = /<function[= ](?:name=)?["']?(?<name>[\w.:-]+)["']?>[ \t]*\n?/gi;
const XML_FUNC_CLOSE = /\s*<\/function>/gi;
const XML_PARAM = /<parameter[= ](?:name=)?["']?(?<key>[\w.-]+)["']?>(?<val>.*?)(?:<\/parameter>|(?=<parameter\b)|(?=<\/function>)|(?=<\/tool_call>)|$)/gis;

const NATIVE_TOOL_NAME_PREFIXES = ['functions.', 'default_api.'];
const ARGUMENT_KEYS = ['arguments', 'args', 'input', 'parameters', 'params', 'action_input'];
const NOTHING = Symbol('nothing');

export function normalizeToolName(name) {
    let n = String(name || '').trim();
    const lower = n.toLowerCase();
    for (const p of NATIVE_TOOL_NAME_PREFIXES) {
        if (lower.startsWith(p)) {
            n = n.slice(p.length);
            break;
        }
    }
    return n.trim();
}

export function toolNames(tools) {
    const names = new Set();
    for (const t of tools || []) {
        const fn = t?.type === 'function' ? t.function : (t?.function || t);
        if (fn && typeof fn.name === 'string' && fn.name.trim()) names.add(fn.name.trim());
    }
    return names;
}

export function toolRequiredParams(tools) {
    const required = {};
    for (const t of tools || []) {
        const fn = t?.type === 'function' ? t.function : (t?.function || t);
        if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) continue;
        const params = fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : {};
        const names = Array.isArray(params.required) ? params.required.filter(v => typeof v === 'string') : [];
        if (names.length) required[fn.name.trim()] = new Set(names);
    }
    return required;
}

function stringifyArgs(rawArgs) {
    if (typeof rawArgs === 'string') return rawArgs;
    if (rawArgs === undefined || rawArgs === null) return '{}';
    return JSON.stringify(rawArgs);
}

function parseArgsObject(rawArgs) {
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return { ok: true, value: rawArgs };
    const text = typeof rawArgs === 'string' ? rawArgs.trim() : '';
    if (!text) return { ok: true, value: {} };
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed };
        return { ok: false, error: 'arguments must be a JSON object' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export function missingRequiredParams(toolCalls, requiredByName) {
    const missing = [];
    if (!requiredByName || typeof requiredByName !== 'object') return missing;
    for (const call of toolCalls || []) {
        const name = call?.function?.name;
        const req = requiredByName[name];
        if (!req || req.size === 0) continue;
        const parsed = parseArgsObject(call?.function?.arguments);
        if (!parsed.ok) continue;
        for (const p of req) {
            if (!Object.prototype.hasOwnProperty.call(parsed.value, p)) missing.push(`${name}.${p}`);
        }
    }
    return missing;
}

// Qwen often writes real newlines/tabs inside JSON strings (typical for
// write/edit tool arguments), which JSON.parse rejects.
function escapeControlCharsInStrings(text) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (const c of text) {
        if (inStr && c < ' ') {
            const code = JSON.stringify(c).slice(1, -1);
            // A backslash right before a raw control char already opened an escape.
            out += esc ? code.slice(1) : code;
            esc = false;
            continue;
        }
        if (esc) esc = false;
        else if (inStr && c === '\\') esc = true;
        else if (c === '"') inStr = !inStr;
        out += c;
    }
    return out;
}

// Index just past the balanced {...} / [...] starting at `start`, or -1.
function balancedJsonEnd(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let j = start; j < text.length; j++) {
        const c = text[j];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0) return j + 1;
        }
    }
    return -1;
}

// Where to start looking for the closing fence: past the JSON payload, so that
// ``` inside an argument value (README, markdown...) does not close it early.
function fenceCloseSearchStart(text, from) {
    let pos = from;
    for (;;) {
        let j = pos;
        while (j < text.length && /[\s,]/.test(text[j])) j++;
        if (text[j] !== '{' && text[j] !== '[') break;
        const end = balancedJsonEnd(text, j);
        if (end === -1) return from;
        pos = end;
    }
    return /^\s*(?:```|$)/.test(text.slice(pos)) ? pos : from;
}

function parseLenientJson(raw) {
    const text = escapeControlCharsInStrings(String(raw || '').trim());
    if (!text) return NOTHING;
    try { return JSON.parse(text); } catch { /* fall through */ }

    const fb = text.indexOf('{');
    const lb = text.lastIndexOf('}');
    const candidate = fb >= 0 && lb > fb ? text.slice(fb, lb + 1) : text;
    try { return JSON.parse(candidate); } catch { /* fall through */ }

    let repaired = candidate.replace(/^\s*\{\s*(["']?)([a-zA-Z0-9_.:-]+)\1\s*,\s*/, '{"name":"$2",');
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(repaired); } catch { /* fall through */ }

    // Handle {"name":"foo",{"key":"val"}} where the bare object IS the arguments value.
    // Qwen sometimes omits the "arguments": key: {"name":"read",{"path":"x"}}
    // instead of the correct {"name":"read","arguments":{"path":"x"}}.
    const argObjMatch = candidate.match(/^\s*\{[^{]*"name"\s*:\s*"([^"]+)"\s*,\s*(\{[\s\S]*\})\s*\}\s*$/);
    if (argObjMatch) {
        try {
            const args = JSON.parse(argObjMatch[2]);
            return { name: argObjMatch[1], arguments: args };
        } catch { /* fall through */ }
    }

    return NOTHING;
}

function extractArgs(raw) {
    for (const key of ARGUMENT_KEYS) {
        if (raw && Object.prototype.hasOwnProperty.call(raw, key)) return raw[key];
    }
    // Some models put args at top-level alongside name/id/type.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const copy = { ...raw };
        for (const k of ['name', 'tool', 'tool_name', 'action', 'id', 'type', 'description', 'function', 'tool_call', 'tool_calls']) delete copy[k];
        if (Object.keys(copy).length > 0) return copy;
    }
    return {};
}

function normalizeRawCall(raw, index = 0) {
    if (!raw || typeof raw !== 'object') return null;
    let call = raw;
    if (raw.function_call || raw.tool_call) call = raw.function_call || raw.tool_call;
    if (Array.isArray(raw.tool_calls) && raw.tool_calls.length === 1) call = raw.tool_calls[0];
    const fn = call.function && typeof call.function === 'object' ? call.function : null;
    const name = normalizeToolName(call.name || call.tool || call.tool_name || call.action || fn?.name);
    if (!name) return null;
    const argsRaw = fn?.arguments ?? extractArgs(call);
    const args = stringifyArgs(argsRaw);
    return {
        id: String(call.id || call.call_id || call.tool_call_id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`),
        type: 'function',
        function: { name, arguments: args },
        index
    };
}

function parseXmlFunctionBlock(blockText) {
    const results = [];
    let m;
    XML_FUNC_OPEN.lastIndex = 0;
    while ((m = XML_FUNC_OPEN.exec(blockText)) !== null) {
        const fnName = normalizeToolName(m.groups?.name || m[1] || '');
        if (!fnName) continue;
        const bodyStart = m.index + m[0].length;
        XML_FUNC_CLOSE.lastIndex = bodyStart;
        const close = XML_FUNC_CLOSE.exec(blockText);
        const body = blockText.slice(bodyStart, close ? close.index : blockText.length);
        const params = {};
        XML_PARAM.lastIndex = 0;
        let p;
        while ((p = XML_PARAM.exec(body)) !== null) {
            const key = String(p.groups?.key || p[1] || '').trim();
            let val = String(p.groups?.val || p[2] || '').trim();
            if (!key) continue;
            try {
                const parsed = JSON.parse(val);
                if (parsed !== null && typeof parsed === 'object' || typeof parsed === 'number' || typeof parsed === 'boolean') {
                    params[key] = parsed;
                    continue;
                }
            } catch { /* keep string */ }
            if (val === 'true') params[key] = true;
            else if (val === 'false') params[key] = false;
            else if (val === 'null') params[key] = null;
            else if (/^-?\d+(?:\.\d+)?$/.test(val)) params[key] = Number(val);
            else params[key] = val;
        }
        results.push({ name: fnName, arguments: params });
        if (close) XML_FUNC_OPEN.lastIndex = close.index + close[0].length;
    }
    return results;
}

function collectJsonObjects(text) {
    const dec = {
        rawDecode: (s, i) => {
            // Simple raw decode using JSON.parse by scanning; fallback below handles.
            throw new Error('unused');
        }
    };
    const objs = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch !== '{' && ch !== '[') { i++; continue; }
        // Scan for balanced JSON object/array starting at i
        let depth = 0, inStr = false, esc = false, start = i, end = -1;
        for (let j = i; j < text.length; j++) {
            const c = text[j];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') { inStr = true; continue; }
            if (c === '{' || c === '[') depth++;
            else if (c === '}' || c === ']') {
                depth--;
                if (depth === 0) { end = j + 1; break; }
            }
        }
        if (end === -1) break;
        const slice = text.slice(start, end);
        try {
            objs.push({ value: JSON.parse(escapeControlCharsInStrings(slice)), start, end });
            i = end;
        } catch {
            i++;
        }
    }
    return objs;
}

function* iterBlocks(text) {
    const candidates = [];
    FENCE_OPEN.lastIndex = 0;
    let m;
    while ((m = FENCE_OPEN.exec(text)) !== null) {
        candidates.push({ start: m.index, endOpen: m.index + m[0].length, kind: m[1].toLowerCase(), isXml: false });
    }
    XML_TAG_OPEN.lastIndex = 0;
    while ((m = XML_TAG_OPEN.exec(text)) !== null) {
        candidates.push({ start: m.index, endOpen: m.index + m[0].length, kind: 'tool_call', isXml: true });
    }
    candidates.sort((a, b) => a.start - b.start);

    let consumedUpTo = 0;
    for (const cand of candidates) {
        if (cand.start < consumedUpTo) continue;

        if (cand.isXml) {
            XML_TAG_CLOSE.lastIndex = cand.endOpen;
            const close = XML_TAG_CLOSE.exec(text);
            const blockEnd = close ? close.index + close[0].length : text.length;
            const rawBlock = text.slice(cand.endOpen, close ? close.index : text.length);

            // Try JSON objects inside XML tag
            let j = cand.endOpen;
            while (j < text.length && /[\s\r\n\t]/.test(text[j])) j++;
            let anyDecoded = false;
            if (text[j] === '{' || text[j] === '[') {
                const objs = collectJsonObjects(text.slice(j, close ? close.index : text.length));
                if (objs.length > 0) {
                    for (const obj of objs) {
                        yield { start: cand.start, end: blockEnd, data: obj.value, kind: cand.kind };
                        anyDecoded = true;
                    }
                }
            }

            if (!anyDecoded && XML_FUNC_OPEN.test(rawBlock)) {
                XML_FUNC_OPEN.lastIndex = 0;
                const xmlCalls = parseXmlFunctionBlock(rawBlock);
                if (xmlCalls.length > 0) {
                    for (const item of xmlCalls) yield { start: cand.start, end: blockEnd, data: item, kind: cand.kind };
                    consumedUpTo = blockEnd;
                    continue;
                }
            }
            if (!anyDecoded) {
                const lenient = parseLenientJson(rawBlock);
                if (lenient !== NOTHING) yield { start: cand.start, end: blockEnd, data: lenient, kind: cand.kind };
            }
            consumedUpTo = blockEnd;
            continue;
        }

        // Fence block: find closing ``` after endOpen
        FENCE_CLOSE.lastIndex = fenceCloseSearchStart(text, cand.endOpen);
        let close = null;
        let cm;
        while ((cm = FENCE_CLOSE.exec(text)) !== null) {
            // ensure it's a fence close on its own line-ish; accept any ```
            close = cm;
            break;
        }
        const blockEnd = close ? close.index + close[0].length : text.length;
        const rawBlock = text.slice(cand.endOpen, close ? close.index : text.length);

        // Parse multiple JSON objects in fence
        const objs = collectJsonObjects(rawBlock);
        // Check whether any collected objects look like tool calls (have a name/tool key).
        // If not, also try parseLenientJson which can recover malformed patterns like
        // {"name":"foo",{"key":"val"}} where the arguments object is bare (no "arguments" key).
        const TOOL_KEYS = ['name', 'tool', 'tool_name', 'action', 'function_call', 'tool_call', 'tool_calls'];
        const hasToolShape = objs.some(o => o.value && typeof o.value === 'object' &&
            TOOL_KEYS.some(k => Object.prototype.hasOwnProperty.call(o.value, k)));
        if (objs.length > 0 && hasToolShape) {
            for (const obj of objs) yield { start: cand.start, end: blockEnd, data: obj.value, kind: cand.kind };
        } else {
            const lenient = parseLenientJson(rawBlock);
            if (lenient !== NOTHING) {
                yield { start: cand.start, end: blockEnd, data: lenient, kind: cand.kind };
            } else if (objs.length > 0) {
                // parseLenientJson found nothing better; fall back to collected objects
                for (const obj of objs) yield { start: cand.start, end: blockEnd, data: obj.value, kind: cand.kind };
            }
        }
        consumedUpTo = blockEnd;
    }
}

function extractCallsFromData(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.tool_calls)) return data.tool_calls;
    if (Array.isArray(data.calls)) return data.calls;
    if (data.function_call || data.tool_call) return [data.function_call || data.tool_call];
    if (data.name || data.tool || data.tool_name || data.action || data.function?.name) return [data];
    return [];
}

// Keep the strict tool shape here: a plain JSON answer like {"name":"Alice"}
// must not turn into a tool call just because tools were declared on the request.
function looksLikeToolCallObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.function && typeof value.function === 'object' && value.function.name) return true;
    if (!value.name && !value.tool && !value.tool_name && !value.action) return false;
    return ARGUMENT_KEYS.some(k => Object.prototype.hasOwnProperty.call(value, k));
}

// A ```json fence is ordinary answer content unless it clearly calls a declared
// tool; otherwise config examples / package.json get cut out of the reply.
function isJsonFenceToolCall(data, allowed) {
    const items = Array.isArray(data) ? data
        : Array.isArray(data?.tool_calls) ? data.tool_calls
            : [data?.function_call || data?.tool_call || data];
    return items.some(item => looksLikeToolCallObject(item) && (!allowed || allowed.has(
        normalizeToolName(item.name || item.tool || item.tool_name || item.action || item.function?.name)
    )));
}

// Qwen sometimes answers with the JSON call un-fenced, mixed with prose or
// several calls in one turn. The old fallback only accepted exactly one JSON
// object as the whole message, so those calls leaked into `content` as text.
function collectBareToolCallObjects(text, excludeSpans = []) {
    return collectJsonObjects(text).filter(obj =>
        looksLikeToolCallObject(obj.value) &&
        // JSON inside a fence/XML block that was rejected as "mid-sentence" is
        // still a description, not a call (see verify-tools.mjs regression).
        !excludeSpans.some(([start, end]) => obj.start >= start && obj.start < end)
    );
}

// Remove the now-empty ```tool_call / <tool_call> wrapper left behind when a
// JSON object inside it was consumed by the bare-object sweep.
function stripEmptyToolWrappers(text) {
    return String(text)
        .replace(/```(?:tool_call|function_call|tool_code|json)[ \t]*\r?\n?[ \t]*(?=```|$)/gi, '')
        .replace(/^[ \t]*```[ \t]*$/gm, '')
        .replace(/<tool_call>[ \t\r\n]*<\/tool_call>/gi, '');
}

function addNormalizedCalls(rawCalls, ctx) {
    const { allowed, dropped, calls } = ctx;
    for (const raw of rawCalls) {
        const normalized = normalizeRawCall(raw, calls.length);
        if (!normalized) continue;
        const name = normalized.function.name;
        if (allowed && !allowed.has(name)) { dropped.push(`undeclared tool: ${name}`); continue; }
        const parsedArgs = parseArgsObject(normalized.function.arguments);
        if (!parsedArgs.ok) { dropped.push(`unusable arguments for ${name}: ${parsedArgs.error}`); continue; }
        normalized.function.arguments = JSON.stringify(parsedArgs.value);
        calls.push(normalized);
    }
}

export function parseToolCalls(text, allowedNames = null, requiredByName = null) {
    if (typeof text !== 'string') return { calls: [], dropped: [], text: '' };
    const allowed = allowedNames instanceof Set ? allowedNames : (Array.isArray(allowedNames) ? new Set(allowedNames) : null);
    const required = requiredByName || {};
    const calls = [];
    const dropped = [];
    const ctx = { allowed, dropped, calls };
    let cleanText = text;

    // 1) Structured blocks (fenced/XML)
    const blocks = [...iterBlocks(text)];

    // Filter out "mid-sentence" blocks: if there is non-whitespace prose on the
    // same line immediately before the block opening, the model is explaining the
    // call rather than making it (mirrors Python tools.py lines 732-737).
    const validBlocks = blocks.filter(block => {
        if (block.kind === 'json') return isJsonFenceToolCall(block.data, allowed);
        const lineStart = text.lastIndexOf('\n', block.start) + 1;
        // Strip XML tags from prefix before checking (use fresh regex to avoid lastIndex issues)
        const prefix = text.slice(lineStart, block.start).replace(/<\/?[\w][\w:.-]*(?:\s[^>]*)?>|<\/tool_call>/gi, '').trim();
        return prefix.length === 0; // skip block when prose precedes it on the same line
    });

    if (validBlocks.length > 0) {
        // Remove valid blocks from cleanText in reverse order (preserve positions).
        // Several objects in one fence share a span: cut each span only once.
        const sorted = [...new Map(validBlocks.map(b => [b.start, b])).values()]
            .sort((a, b) => b.start - a.start);
        for (const b of sorted) {
            cleanText = cleanText.slice(0, b.start) + cleanText.slice(b.end);
        }
        for (const block of validBlocks) addNormalizedCalls(extractCallsFromData(block.data), ctx);
    }

    // 2) Bare JSON sweep. Runs when structured parsing produced nothing usable:
    // prose + JSON, several calls, or the JSON left behind by a fence that was
    // rejected as "mid-sentence" (validBlocks empty but the fence text remains).
    if (calls.length === 0 && (blocks.length === 0 || validBlocks.length === 0)) {
        const bare = collectBareToolCallObjects(text, blocks.map(b => [b.start, b.end]));
        if (bare.length > 0) {
            const bareCalls = bare.flatMap(obj => extractCallsFromData(obj.value));
            addNormalizedCalls(bareCalls, ctx);
            if (calls.length > 0) {
                for (const obj of [...bare].sort((a, b) => b.start - a.start)) {
                    cleanText = cleanText.slice(0, obj.start) + cleanText.slice(obj.end);
                }
                cleanText = stripEmptyToolWrappers(cleanText);
            }
        }
        // 3) Lenient repair for malformed single objects (e.g. {"name":"x",{...}}).
        // Only when no fence exists, otherwise the raw fence text would match.
        if (calls.length === 0 && blocks.length === 0) {
            const lenient = parseLenientJson(text.trim());
            if (lenient !== NOTHING) {
                addNormalizedCalls(extractCallsFromData(lenient), ctx);
                if (calls.length > 0) cleanText = '';
            }
        }
    }

    // Final required param validation
    const missing = missingRequiredParams(calls, required);
    if (missing.length > 0) {
        for (const m of missing) dropped.push(`missing required parameter: ${m}`);
        return { calls: [], dropped, text: cleanText.trim() };
    }

    // Ensure indices sequential
    calls.forEach((c, i) => { c.index = i; });
    return { calls, dropped, text: cleanText.trim() };
}

function jsonComplete(s) {
    const t = String(s || '').trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return false;
    try { JSON.parse(t); return true; } catch { return false; }
}

export function createNativeToolCallAccumulator() {
    return { calls: [], order: [] };
}

export function collectNativeCall(acc, fc, allowedNames = null) {
    if (!acc || !fc || typeof fc !== 'object') return;
    const allowed = allowedNames instanceof Set ? allowedNames : (Array.isArray(allowedNames) ? new Set(allowedNames) : null);
    const name = normalizeToolName(fc.name || fc.function?.name || '');
    const rawArgs = typeof fc.arguments === 'string' ? fc.arguments : (fc.arguments ? JSON.stringify(fc.arguments) : (typeof fc.function?.arguments === 'string' ? fc.function.arguments : (fc.function?.arguments ? JSON.stringify(fc.function.arguments) : '')));
    const cid = String(fc.id ?? fc.call_id ?? fc.tool_call_id ?? fc.index ?? '').trim();

    if (!Array.isArray(acc.calls)) acc.calls = [];
    if (!Array.isArray(acc.order)) acc.order = [];

    let call = null;
    if (cid) {
        call = acc.calls.find(c => c.cid === cid && (!name || !c.name || c.name === name)) || null;
        if (!call) {
            call = { cid, name, arguments: '', emitted: false };
            acc.calls.push(call);
        }
    } else {
        call = acc.calls[acc.calls.length - 1] || null;
        const newByName = !!(name && call && call.name && call.name !== name);
        const boundary = !!(call && rawArgs && jsonComplete(call.arguments) && String(rawArgs).trim().startsWith('{') && !String(rawArgs).startsWith(call.arguments));
        if (!call || newByName || boundary) {
            call = { cid: '', name, arguments: '', emitted: false };
            acc.calls.push(call);
        }
    }

    if (name) call.name = name;
    if (!rawArgs) return;
    const prev = call.arguments || '';
    if (!prev) call.arguments = rawArgs;
    else if (rawArgs.startsWith(prev)) call.arguments = rawArgs;
    else if (prev.startsWith(rawArgs)) { /* keep longer */ }
    else call.arguments += rawArgs;
}

export function flushNativeToolCalls(acc, allowedNames = null) {
    const allowed = allowedNames instanceof Set ? allowedNames : (Array.isArray(allowedNames) ? new Set(allowedNames) : null);
    const out = { calls: [], dropped: [] };
    if (!acc || !Array.isArray(acc.calls)) return out;

    for (const entry of acc.calls) {
        const name = normalizeToolName(entry?.name || '');
        if (!name) continue;
        if (allowed && !allowed.has(name)) {
            out.dropped.push(`undeclared tool: ${name}`);
            continue;
        }
        const rawArgs = String(entry.arguments || '').trim() || '{}';
        const parsed = parseArgsObject(rawArgs);
        if (!parsed.ok) {
            out.dropped.push(`unusable arguments for ${name}: ${parsed.error}`);
            continue;
        }
        out.calls.push({
            id: String(entry.cid || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`),
            type: 'function',
            function: { name, arguments: JSON.stringify(parsed.value) },
            index: out.calls.length
        });
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// messagesToQwenPrompt  — port of qwen-web2api/tools.py:messages_to_prompt()
//
// Converts an OpenAI messages array (+ optional tools/tool_choice) into a
// single text prompt that Qwen Web understands.  The tool definitions are
// rendered as a pinned "# Tool Use" block at the top; each message role is
// serialised as labelled text; previous tool calls/results are reproduced as
// ```tool_call fences + "[Tool result for …]" lines so the model has full
// context.  Returns the finished prompt string.
//
// Usage (in routes.js):
//   const prompt = messagesToQwenPrompt(messages, tools, tool_choice);
//   // send prompt as the messageContent; do NOT set payload.tools
// ─────────────────────────────────────────────────────────────────────────────

const _TOOL_REMINDER = '\n\n[Reminder: you have working tools. To know what a file ' +
    'contains or what a command produced, call the tool -- do ' +
    'not answer from memory and do not claim to have read or ' +
    'run anything you have not.]';

function _stringifyContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (Array.isArray(content)) {
        const parts = [];
        for (const c of content) {
            if (c && typeof c === 'object') {
                if (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') {
                    if (c.text) parts.push(c.text);
                } else if (typeof c.text === 'string') {
                    parts.push(c.text);
                }
            } else if (typeof c === 'string') {
                parts.push(c);
            }
        }
        return parts.filter(Boolean).join('\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
    return String(content);
}

function _fnOf(t) {
    return (t && t.type === 'function' && t.function) ? t.function : (t && t.function ? t.function : t);
}

function _choiceInstruction(tool_choice) {
    if (tool_choice === 'none') return '\n\nIMPORTANT: Do NOT call any tools. Respond with text only.';
    if (tool_choice === 'required') return '\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.';
    if (tool_choice && typeof tool_choice === 'object') {
        const fn = tool_choice.function;
        const name = (fn && typeof fn === 'object') ? fn.name : (tool_choice.name || null);
        if (name) return `\n\nIMPORTANT: You MUST call the tool "${name}". Do not call other tools.`;
    }
    return '';
}

function _toolUseBlock(toolDefs, constraint) {
    const toolsJson = JSON.stringify(toolDefs, null, 0);
    return (
        '# Tool Use\n\n' +
        'The tools below are connected to the user\'s machine and execute for ' +
        'real the moment you call them.\n\n' +
        'Call format (use this exact format):\n' +
        '```tool_call\n' +
        '{"name": "<tool_name>", "arguments": {<parameters>}}\n' +
        '```\n\n' +
        'Example (ALWAYS include the \"arguments\" key, even for simple calls):\n' +
        '```tool_call\n' +
        '{"name": "read_file", "arguments": {"path": "index.js"}}\n' +
        '```\n\n' +
        'Rules:\n' +
        '- Each turn do exactly ONE of: (A) you need to read or change ' +
        'something -> output ONLY tool_call block(s); (B) you already have ' +
        'everything -> answer as plain text with NO block. Never both, and ' +
        'never any prose after the block.\n' +
        '- If the conversation\'s own instructions require every reply to use ' +
        'a tool (for example an error such as "You did not use a tool in ' +
        'your previous response"), do NOT answer in plain text: deliver the ' +
        'final answer through the matching completion tool (for example ' +
        'attempt_completion) as a tool_call block.\n' +
        '- Every parameter belongs inside the "arguments" object, keyed ' +
        'exactly like the tool\'s "parameters" properties -- never beside ' +
        '"name".\n' +
        '- Emit several blocks in one turn when the calls are independent.\n' +
        '- Before reviewing or editing code, read the actual files with a ' +
        'read/search tool first. Listing file names is not reading.\n' +
        '- Never write [Tool result for ...] yourself and never invent a ' +
        'result: emit the block and stop.\n' +
        '- Never claim the tools are unavailable or that you lack ' +
        'permission: they are connected and will run.\n\n' +
        `Available tools:\n${toolsJson}${constraint}`
    );
}

/**
 * Convert an OpenAI messages array + tools into a single Qwen-Web prompt string.
 *
 * @param {Array}  messages    - OpenAI messages array
 * @param {Array}  [tools]     - OpenAI tools array (optional)
 * @param {*}      [tool_choice] - OpenAI tool_choice value (optional)
 * @returns {string}  Complete prompt ready to send as the user message
 */
export function messagesToQwenPrompt(messages, tools = null, tool_choice = null) {
    const parts = [];
    let toolBlock = null;

    // Build pinned tool-use block if tools are present and tool_choice != 'none'
    if (tools && Array.isArray(tools) && tools.length > 0 && tool_choice !== 'none') {
        const defs = [];
        for (const t of tools) {
            if (!t || typeof t !== 'object') continue;
            const fn = _fnOf(t);
            if (!fn || typeof fn !== 'object' || !fn.name) continue;
            defs.push({
                name: fn.name,
                description: fn.description || '',
                parameters: fn.parameters || {}
            });
        }
        if (defs.length > 0) {
            toolBlock = _toolUseBlock(defs, _choiceInstruction(tool_choice));
        }
    }

    // Build id->name map from assistant tool_calls for tool result labelling
    const idToName = {};
    for (const m of messages || []) {
        if (!m || m.role !== 'assistant') continue;
        for (const tc of m.tool_calls || []) {
            const fn = (tc && tc.function) || {};
            if (tc && tc.id && fn.name) idToName[tc.id] = fn.name;
        }
    }

    // Serialise each message
    const combined = new Set(); // tool_call_ids already included inline with assistant
    for (let i = 0; i < (messages || []).length; i++) {
        const m = messages[i];
        if (!m || typeof m !== 'object') continue;
        let role = m.role || 'user';
        if (role === 'developer') role = 'system';
        const content = _stringifyContent(m.content);

        if (role === 'system') {
            parts.push(`[System instruction]: ${content}`);
        } else if (role === 'assistant') {
            if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                // Render tool calls as fence blocks, then inline any following tool results
                const blocks = [];
                for (const tc of m.tool_calls) {
                    const fn = (tc && tc.function) || {};
                    let args = fn.arguments || '{}';
                    if (typeof args !== 'string') args = JSON.stringify(args, null, 0);
                    try { JSON.parse(args); } catch { args = '{}'; }
                    blocks.push(
                        '```tool_call\n' +
                        JSON.stringify({ id: tc.id || '', name: fn.name || '', arguments: JSON.parse(args) }) +
                        '\n```'
                    );
                }
                let text = `[Assistant]: ${content}\n` + blocks.join('\n');
                // Collect following tool result messages and inline them
                for (let j = i + 1; j < messages.length; j++) {
                    const nm = messages[j];
                    if (!nm || nm.role !== 'tool') break;
                    const tcid = nm.tool_call_id || '';
                    combined.add(tcid);
                    const name = nm.name || idToName[tcid] || 'tool';
                    text += `\n[Tool result for ${name} (id=${tcid})]: ` + _stringifyContent(nm.content);
                }
                parts.push(text);
            } else {
                parts.push(`[Assistant]: ${content}`);
            }
        } else if (role === 'tool') {
            const tcid = m.tool_call_id || '';
            if (combined.has(tcid)) continue; // already inlined above
            const name = m.name || idToName[tcid] || 'tool';
            parts.push(`[Tool result for ${name} (id=${tcid})]: ${content}`);
        } else {
            // user (or unknown role)
            parts.push(content);
        }
    }

    if (toolBlock) parts.push(_TOOL_REMINDER);

    const bodyText = parts.filter(Boolean).join('\n\n');
    return toolBlock ? `${toolBlock}\n\n${bodyText}` : bodyText;
}

export function mergeToolCalls(nativeCalls = [], textCalls = []) {
    const merged = [];
    const seen = new Set();
    for (const call of [...(nativeCalls || []), ...(textCalls || [])]) {
        const name = normalizeToolName(call?.function?.name || '');
        const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments || {});
        if (!name) continue;
        const key = `${name}\n${args}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({
            id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: { name, arguments: args },
            index: merged.length
        });
    }
    return merged;
}