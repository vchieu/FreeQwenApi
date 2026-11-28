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
const XML_PARAM = /<parameter[= ](?:name=)?["']?(?<key>[\w.-]+)["']?>(?<val>.*?)<\/parameter>/gis;

const NATIVE_TOOL_NAME_PREFIXES = ['functions.', 'default_api.'];
const ARGUMENT_KEYS = ['arguments', 'args', 'input', 'parameters', 'params', 'action_input'];
const NOTHING = Symbol('nothing');
// Symbol used by parseLenientJson to signal that escapeInvalidBackslashesInStrings was needed.
// addNormalizedCalls rejects calls that have non-path params in that case, because JSON.parse
// would then decode \n -> newline / \t -> tab, silently corrupting content / command strings.
const SLASH_REPAIR_SYM = Symbol('slashRepair');

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

// Escape invalid JSON backslash sequences inside string literals (e.g. Windows
// paths like "C:\Users\Admin\file.txt") without touching valid escapes or
// anything outside strings.
function escapeInvalidBackslashesInStrings(text) {
    let out = '';
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (!inStr) {
            if (c === '"') inStr = true;
            out += c;
            continue;
        }
        if (c === '"') {
            inStr = false;
            out += c;
            continue;
        }
        if (c === '\\') {
            const next = text[i + 1];
            if (next && '"\\/bfnrt'.includes(next)) {
                out += '\\' + next;
                i++;
                continue;
            }
            if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
                out += text.slice(i, i + 6);
                i += 5;
                continue;
            }
            out += '\\\\';
            continue;
        }
        out += c;
    }
    return out;
}

// Remove trailing commas before `}` or `]` ONLY outside JSON string literals,
// so file content like `x = [1, 2, ]` inside `"content"` is never altered.
function stripTrailingCommasOutsideStrings(text) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            out += c;
            continue;
        }
        if (c === '"') {
            inStr = true;
            out += c;
            continue;
        }
        if (c === ',') {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            if (text[j] === '}' || text[j] === ']') continue;
        }
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

    // escapeInvalidBackslashesInStrings fixes bare backslashes (e.g. Windows paths like
    // C:\Users\Admin\file.txt). When this step is needed, JSON.parse will decode
    // \n -> newline, \t -> tab etc. — correct for path params but silently corrupts
    // content / command strings. Tag the result with SLASH_REPAIR_SYM so callers can
    // reject calls that have non-path params (Fix 1 R9).
    const slashSafe = escapeInvalidBackslashesInStrings(candidate);
    const slashNeeded = slashSafe !== candidate;
    function tagRepair(v) {
        if (slashNeeded && v !== null && typeof v === 'object') {
            v[SLASH_REPAIR_SYM] = true;
            Object.values(v).forEach(tagRepair);
        }
        return v;
    }
    try { return tagRepair(JSON.parse(slashSafe)); } catch { /* fall through */ }

    let repaired = slashSafe.replace(/^\s*\{\s*(["']?)([a-zA-Z0-9_.:-]+)\1\s*,\s*/, '{"name":"$2",');
    repaired = stripTrailingCommasOutsideStrings(repaired);
    try { return tagRepair(JSON.parse(repaired)); } catch { /* fall through */ }

    // Handle {"name":"foo",{"key":"val"}} where the bare object IS the arguments value.
    // Qwen sometimes omits the "arguments": key: {"name":"read",{"path":"x"}}
    // instead of the correct {"name":"read","arguments":{"path":"x"}}.
    const argObjMatch = repaired.match(/^\s*\{[^{]*"name"\s*:\s*"([^"]+)"\s*,\s*(\{[\s\S]*\})\s*\}\s*$/);
    if (argObjMatch) {
        try {
            const args = JSON.parse(argObjMatch[2]);
            return tagRepair({ name: argObjMatch[1], arguments: args });
        } catch { /* fall through */ }
    }

    return NOTHING;
}

// When Qwen encodes a Windows/Unix path as a JSON string value, it often uses
// literal backslashes (e.g. C:\new\test.js). After escapeInvalidBackslashesInStrings
// turns those into \\, JSON.parse decodes \n → newline, \t → tab, etc.
// This function restores those control characters back to their escaped form so the
// caller receives the original path string rather than corrupted bytes.
// Only applies to string values that look like paths (contains \ or /).
// Pure content strings (file bodies, etc.) must NOT go through this.
const CTRL_TO_ESC = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\b': '\\b', '\f': '\\f' };
function restorePathControlChars(str) {
    // Only restore if the string resembles a path: contains \ or / and no literal newlines
    // that are intentional (paths never have real newlines).
    if (typeof str !== 'string') return str;
    return str.replace(/[\n\t\r\b\f]/g, c => CTRL_TO_ESC[c] || c);
}

// Known path-like parameter names. When Qwen returns one of these, we apply
// restorePathControlChars so Windows paths like C:\new\test.js survive the round-trip.
// IMPORTANT: Keep this list tight — only names that ALWAYS hold a filesystem path.
// Do NOT include: source, output, target, src, dest — these can hold multi-line content
// (file bodies, shell commands, etc.) and restoring \n there corrupts the content.
// Key matching is case-insensitive (normalized to lowercase before lookup).
const PATH_PARAM_KEYS = new Set(['path', 'file_path', 'filepath', 'filename', 'directory', 'dir', 'workdir']);

function restoreArgsPathParams(argsObj) {
    if (!argsObj || typeof argsObj !== 'object' || Array.isArray(argsObj)) return argsObj;
    const out = {};
    for (const [k, v] of Object.entries(argsObj)) {
        // Normalize key to lowercase for case-insensitive matching so both
        // 'filePath' (OpenCode) and 'file_path' are caught.
        if (PATH_PARAM_KEYS.has(k.toLowerCase()) && typeof v === 'string') {
            out[k] = restorePathControlChars(v);
        } else {
            out[k] = v;
        }
    }
    return out;
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
        id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
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
        if (!fnName) return { calls: [], malformed: true };
        const bodyStart = m.index + m[0].length;
        XML_FUNC_CLOSE.lastIndex = bodyStart;
        const close = XML_FUNC_CLOSE.exec(blockText);
        if (!close) return { calls: [], malformed: true };
        const body = blockText.slice(bodyStart, close.index);
        const params = {};
        const matchedSpans = [];
        XML_PARAM.lastIndex = 0;
        let p;
        while ((p = XML_PARAM.exec(body)) !== null) {
            matchedSpans.push([p.index, p.index + p[0].length]);
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
        // Reject unclosed <parameter...> tags inside the function body so truncated
        // XML parameters never silently disappear or corrupt file content.
        let remainder = '';
        let pos = 0;
        for (const [s, e] of matchedSpans) {
            remainder += body.slice(pos, s);
            pos = e;
        }
        remainder += body.slice(pos);
        if (/<parameter\b/i.test(remainder)) return { calls: [], malformed: true };

        results.push({ name: fnName, arguments: params });
        XML_FUNC_OPEN.lastIndex = close.index + close[0].length;
    }
    return { calls: results, malformed: false };
}

function collectJsonObjects(text) {
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
        const escaped = escapeControlCharsInStrings(slice);
        try {
            objs.push({ value: JSON.parse(escaped), start, end });
            i = end;
        } catch {
            try {
                // Only strip trailing commas; do NOT call escapeInvalidBackslashesInStrings here.
                // That helper treats \n, \t, \b, \f as valid JSON escapes which silently corrupts
                // Windows paths like C:\new\test.js (turns \n → newline, \t → tab).
                // If the JSON is still invalid after comma-stripping, let it fall through to i++
                // so callers receive a parse failure instead of silently corrupted data.
                const repaired = stripTrailingCommasOutsideStrings(escaped);
                objs.push({ value: JSON.parse(repaired), start, end });
                i = end;
            } catch {
                i++;
            }
        }
    }
    return objs;
}

const TOOL_KEYS = ['name', 'tool', 'tool_name', 'action', 'function_call', 'tool_call', 'tool_calls'];
function hasToolKey(value) {
    if (Array.isArray(value)) return value.some(hasToolKey);
    if (!value || typeof value !== 'object') return false;
    if (value.function && typeof value.function === 'object' && value.function.name) return true;
    return TOOL_KEYS.some(k => Object.prototype.hasOwnProperty.call(value, k));
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
            if (!close) {
                yield { start: cand.start, end: text.length, data: null, kind: cand.kind, malformed: true };
                consumedUpTo = text.length;
                continue;
            }
            const blockEnd = close.index + close[0].length;
            const rawBlock = text.slice(cand.endOpen, close.index);

            // Try JSON objects inside XML tag
            let j = cand.endOpen;
            while (j < close.index && /[\s\r\n\t]/.test(text[j])) j++;
            let anyDecoded = false;
            if (text[j] === '{' || text[j] === '[') {
                const objs = collectJsonObjects(text.slice(j, close.index));
                if (objs.length > 0) {
                    for (const obj of objs) {
                        yield { start: cand.start, end: blockEnd, data: obj.value, kind: cand.kind };
                        anyDecoded = true;
                    }
                }
            }

            if (!anyDecoded && XML_FUNC_OPEN.test(rawBlock)) {
                XML_FUNC_OPEN.lastIndex = 0;
                const xmlParsed = parseXmlFunctionBlock(rawBlock);
                if (!xmlParsed.malformed && xmlParsed.calls.length > 0) {
                    for (const item of xmlParsed.calls) yield { start: cand.start, end: blockEnd, data: item, kind: cand.kind };
                    consumedUpTo = blockEnd;
                    continue;
                }
                yield { start: cand.start, end: blockEnd, data: null, kind: cand.kind, malformed: true };
                consumedUpTo = blockEnd;
                continue;
            }
            if (!anyDecoded) {
                const lenient = parseLenientJson(rawBlock);
                if (lenient !== NOTHING && hasToolKey(lenient)) {
                    yield { start: cand.start, end: blockEnd, data: lenient, kind: cand.kind };
                } else {
                    yield { start: cand.start, end: blockEnd, data: null, kind: cand.kind, malformed: true };
                }
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

        // Safety: an unclosed fence is treated differently depending on kind:
        //   • ```json unclosed → never execute (could be example / markdown prose)
        //   • ```tool_call unclosed → accept ONLY when nothing follows the JSON
        //     payload (i.e. no additional prose after the JSON object).
        //     If there IS trailing prose, the model is using the fence as an
        //     example inside a paragraph — yield malformed so caller can decide.
        const isUnclosed = !close;
        if (isUnclosed) {
            if (cand.kind === 'json') {
                // Never execute unclosed ```json blocks — skip entirely.
                consumedUpTo = text.length;
                continue;
            }
            // For tool_call / other explicit fences: check if trailing prose follows JSON.
            const objs = collectJsonObjects(text.slice(cand.endOpen));
            if (objs.length > 0) {
                const lastObj = objs[objs.length - 1];
                const afterJson = text.slice(cand.endOpen + lastObj.end).trim();
                if (afterJson.length > 0) {
                    // Trailing prose exists — model is using this as an example.
                    // Mark as mid-sentence so parseToolCalls records the right drop reason.
                    yield { start: cand.start, end: text.length, data: null, kind: cand.kind, malformed: true, midSentenceUnclosed: true };
                    consumedUpTo = text.length;
                    continue;
                }
            }
        }

        const blockEnd = close ? close.index + close[0].length : text.length;
        const rawBlock = text.slice(cand.endOpen, close ? close.index : text.length);

        // Parse multiple JSON objects in fence
        const objs = collectJsonObjects(rawBlock);
        // Check whether any collected objects look like tool calls (have a name/tool key).
        // If not, also try parseLenientJson which can recover malformed patterns like
        // {"name":"foo",{"key":"val"}} where the arguments object is bare (no "arguments" key).
        const hasToolShape = objs.some(o => hasToolKey(o.value));
        if (objs.length > 0 && hasToolShape) {
            for (const obj of objs) yield { start: cand.start, end: blockEnd, data: obj.value, kind: cand.kind };
        } else {
            const lenient = parseLenientJson(rawBlock);
            if (lenient !== NOTHING && hasToolKey(lenient)) {
                yield { start: cand.start, end: blockEnd, data: lenient, kind: cand.kind };
            } else if (cand.kind === 'json') {
                // Fix 2 (R9): a ```json block that (a) fails whole-block JSON.parse AND
                // (b) contains both "name" and "arguments" keys may be a broken tool call
                // (e.g. unescaped " inside content). collectJsonObjects may still extract
                // partial/corrupt objects from it, so we cannot rely on objs.length.
                // parseToolCalls stops later fences only if it names a declared tool.
                let wholeBlockValid = false;
                try { JSON.parse(rawBlock.trim()); wholeBlockValid = true; } catch { /* broken */ }
                if (!wholeBlockValid && /"name"/.test(rawBlock) && /"arguments"/.test(rawBlock)) {
                    yield { start: cand.start, end: blockEnd, data: null, kind: cand.kind, malformed: true, raw: rawBlock };
                } else if (objs.length > 0) {
                    // Ordinary ```json block without tool shape stays eligible for isJsonFenceToolCall() -> false
                    for (const obj of objs) yield { start: cand.start, end: blockEnd, data: obj.value, kind: cand.kind };
                }
                // else: empty/non-JSON ```json block — skip silently
            } else {
                // Explicit tool fence with broken JSON or no tool-shaped payload:
                // mark malformed so parseToolCalls records a drop reason for nudge retry.
                yield { start: cand.start, end: blockEnd, data: null, kind: cand.kind, malformed: true };
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

function isToolPayloadObject(value) {
    if (Array.isArray(value)) return value.length > 0 && value.every(looksLikeToolCallObject);
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value.tool_calls)) return value.tool_calls.length > 0 && value.tool_calls.every(looksLikeToolCallObject);
    if (Array.isArray(value.calls)) return value.calls.length > 0 && value.calls.every(looksLikeToolCallObject);
    if (value.function_call || value.tool_call) return looksLikeToolCallObject(value.function_call || value.tool_call);
    return looksLikeToolCallObject(value);
}

// Accept bare JSON tool calls ONLY when the entire trimmed message consists
// exclusively of tool-call JSON object(s)/array(s) separated by whitespace.
// "Do NOT run it: {...}" and "I will read it.\n{...}" both stay as text —
// the model's intent is ambiguous and executing it silently is dangerous
// (R7 regression: prose + newline + JSON was executing destructive commands).
//
// When prose precedes a bare JSON that starts on its own line at the END of
// the message, we return a sentinel so the caller can nudge with a neutral
// prompt ("place it on its own line") rather than executing or discarding it.
// This avoids both the false execution bug (R7/finding #1) and the agent
// stall that happens when the JSON is completely ignored.
const BARE_JSON_AT_END = Symbol('bareJsonAtEnd');

function collectWholeMessageBareToolCalls(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        // Case: prose + JSON at end-of-message on its own line.
        // Return the sentinel so caller can decide (nudge, not execute).
        const objs = collectJsonObjects(trimmed);
        if (objs.length > 0) {
            const lastObj = objs[objs.length - 1];
            if (isToolPayloadObject(lastObj.value) && trimmed.slice(lastObj.end).trim() === '') {
                // JSON is at the very end of the message.
                // Check it starts at beginning of a line (not mid-sentence).
                const lineStart = trimmed.lastIndexOf('\n', lastObj.start - 1) + 1;
                const prefix = trimmed.slice(lineStart, lastObj.start).trim();
                if (!prefix) return [BARE_JSON_AT_END];
            }
        }
        return [];
    }
    // Case (a): entire message is bare JSON (no prose at all).
    const objs = collectJsonObjects(trimmed);
    if (objs.length === 0) return [];
    let cursor = 0;
    for (const obj of objs) {
        if (trimmed.slice(cursor, obj.start).trim() !== '') return [];
        if (!isToolPayloadObject(obj.value)) return [];
        cursor = obj.end;
    }
    if (trimmed.slice(cursor).trim() !== '') return [];
    return objs;
}
function addNormalizedCalls(rawCalls, ctx) {
    const { allowed, dropped, calls } = ctx;
    for (const raw of rawCalls) {
        // Fix 1 (R9): parseLenientJson tags every object it produced through backslash
        // repair. Check BEFORE normalizeRawCall stringifies the args (which drops the Symbol).
        const usedSlashRepair = !!(raw && (raw[SLASH_REPAIR_SYM] ||
            (raw.arguments && typeof raw.arguments === 'object' && raw.arguments[SLASH_REPAIR_SYM])));
        const normalized = normalizeRawCall(raw, calls.length);
        if (!normalized) continue;
        const name = normalized.function.name;
        // Fix #4 (R8): stop at the FIRST broken call of any kind — undeclared tool,
        // bad arguments — so subsequent calls that may depend on this one never run.
        // Set ctx.stopped so the outer block loop also stops (each fence block is a
        // separate addNormalizedCalls call, so break alone is not enough).
        if (allowed && !allowed.has(name)) { dropped.push(`undeclared tool: ${name}`); ctx.stopped = true; break; }
        const parsedArgs = parseArgsObject(normalized.function.arguments);
        if (!parsedArgs.ok) { dropped.push(`unusable arguments for ${name}: ${parsedArgs.error}`); ctx.stopped = true; break; }
        // Fix #3 (R2): restore control chars back to escaped form in path-like params.
        // parseLenientJson may have called escapeInvalidBackslashesInStrings which makes
        // JSON.parse decode \n → newline, \t → tab etc., corrupting Windows paths silently.
        const restoredArgs = restoreArgsPathParams(parsedArgs.value);
        // Fix 1 (R9): after backslash repair, a non-path string holding a backslash or a
        // control char may have been decoded wrongly (\n, \t, \b). Reject the whole call
        // and retry. Numbers, booleans and plain strings cannot be damaged.
        if (usedSlashRepair) {
            // Object.keys() skips Symbols, so only real parameters are checked.
            const hasEscapes = (v) => typeof v === 'string' ? /[\\\x00-\x1f]/.test(v)
                : !!v && typeof v === 'object' && Object.values(v).some(hasEscapes);
            const nonPathKey = Object.keys(parsedArgs.value).find(
                k => !PATH_PARAM_KEYS.has(k.toLowerCase()) && hasEscapes(parsedArgs.value[k]));
            if (nonPathKey !== undefined) {
                dropped.push(`backslash-repair would corrupt non-path param '${nonPathKey}' in ${name} — rejecting call; write every backslash as \\\\ inside JSON strings, or use / in paths`);
                ctx.stopped = true;
                break;
            }
        }
        normalized.function.arguments = JSON.stringify(restoredArgs);
        calls.push(normalized);
    }
}

export function parseToolCalls(text, allowedNames = null, requiredByName = null) {
    if (typeof text !== 'string') return { calls: [], dropped: [], text: '' };
    const allowed = allowedNames instanceof Set ? allowedNames : (Array.isArray(allowedNames) ? new Set(allowedNames) : null);
    const required = requiredByName || {};
    const calls = [];
    const dropped = [];
    const ctx = { allowed, dropped, calls, stopped: false };
    let cleanText = text;

    // 1) Structured blocks (fenced/XML)
    const blocks = [...iterBlocks(text)];

    // Filter out "mid-sentence" blocks: if there is non-whitespace prose on the
    // same line immediately before the block opening, the model is explaining the
    // call rather than making it (mirrors Python tools.py lines 732-737).
    // Record skipped explicit tool blocks in `dropped` so nudge-retry can recover
    // when the model accidentally wrote "Let me read it: ```tool_call...".
    const validBlocks = [];
    for (const block of blocks) {
        const lineStart = text.lastIndexOf('\n', block.start) + 1;
        if (block.kind === 'json') {
            const prefix = text.slice(lineStart, block.start).trim();
            if (prefix.length === 0 && !block.malformed && isJsonFenceToolCall(block.data, allowed)) {
                validBlocks.push(block);
            } else if (prefix.length === 0 && block.malformed) {
                // Only a block naming a declared tool is a broken call; templates and
                // commented config examples stay part of the answer.
                const raw = block.raw || '';
                const namesTool = /^\s*[\[{]/.test(raw) && /"arguments"\s*:/.test(raw)
                    && [...raw.matchAll(/"name"\s*:\s*"([^"]+)"/g)]
                        .some(m => !allowed || allowed.has(normalizeToolName(m[1])));
                if (!namesTool) continue;
                // Fix 2 (R9): such a broken call must set ctx.stopped so subsequent fences
                // do not run. Include it in validBlocks so the malformed loop below handles
                // it — only if it starts on its own line (same guard as valid calls).
                validBlocks.push(block);
            }
            continue;
        }
        // midSentenceUnclosed: unclosed fence with trailing prose — iterBlocks flagged it.
        if (block.midSentenceUnclosed) {
            dropped.push(`mid-sentence ${block.kind} block ignored (unclosed fence with trailing prose)`);
            continue;
        }
        // Strip XML tags from prefix before checking (use fresh regex to avoid lastIndex issues)
        const prefix = text.slice(lineStart, block.start).replace(/<\/?[\w][\w:.-]*(?:\s[^>]*)?>|<\/tool_call>/gi, '').trim();
        if (prefix.length === 0) {
            validBlocks.push(block);
        } else {
            dropped.push(`mid-sentence ${block.kind} block ignored (preceded by text on same line)`);
        }
    }

    if (validBlocks.length > 0) {
        // Remove valid blocks from cleanText in reverse order (preserve positions).
        // Several objects in one fence share a span: cut each span only once.
        const sorted = [...new Map(validBlocks.map(b => [b.start, b])).values()]
            .sort((a, b) => b.start - a.start);
        for (const b of sorted) {
            cleanText = cleanText.slice(0, b.start) + cleanText.slice(b.end);
        }
        for (const block of validBlocks) {
            if (block.malformed) {
                dropped.push(`malformed ${block.kind} block (invalid JSON or missing tool call)`);
                // Fix D (R8): a malformed explicit tool_call block means the model tried
                // to call a tool but produced broken JSON — stop processing subsequent blocks
                // so a dependent call does not run with a broken or missing predecessor result.
                ctx.stopped = true;
                continue;
            }
            if (ctx.stopped) break; // R8: a previous block broke on bad call — stop all subsequent blocks
            addNormalizedCalls(extractCallsFromData(block.data), ctx);
        }
        if (calls.length === 0 && dropped.length === 0) {
            dropped.push('malformed tool_call block (no usable tool call)');
        }
    }

    // 2) Whole-message bare JSON fallback. Only runs when no structured blocks exist.
    //    - If the entire message is JSON tool call(s) with no prose: execute.
    //    - If JSON appears at end-of-message on its own line after prose: record
    //      a neutral drop so the caller can nudge ("place on its own line") without
    //      executing the command blindly (finding #1 fix).
    if (calls.length === 0 && blocks.length === 0) {
        const bare = collectWholeMessageBareToolCalls(text);
        if (bare.length === 1 && bare[0] === BARE_JSON_AT_END) {
            // Model wrote prose + JSON on separate line. Don't execute; nudge.
            dropped.push('bare-json-after-prose: tool call JSON found after prose — please place it in a ```tool_call block');
        } else if (bare.length > 0) {
            const bareCalls = bare.flatMap(obj => extractCallsFromData(obj.value));
            addNormalizedCalls(bareCalls, ctx);
            if (calls.length > 0) cleanText = '';
        }
        // 3) Lenient repair for malformed single objects (e.g. {"name":"x",{...}}).
        // Only when the whole trimmed message is a single {...} object.
        const trimmed = text.trim();
        if (calls.length === 0 && trimmed.startsWith('{') && trimmed.endsWith('}')) {
            const lenient = parseLenientJson(trimmed);
            if (lenient !== NOTHING && isToolPayloadObject(lenient)) {
                addNormalizedCalls(extractCallsFromData(lenient), ctx);
                if (calls.length > 0) cleanText = '';
            }
        }
    }

    // Per-call required param validation (R8 fix): stop at the FIRST broken call.
    // Keeping calls that come after a broken one is dangerous — e.g. if
    // `write deploy.sh` is missing `content`, we must NOT still run
    // `sh deploy.sh` which would execute the stale or non-existent file.
    // The correct behavior is: take all calls up to (but not including) the
    // first invalid one, record the missing params in `dropped`, and nudge.
    const validCalls = [];
    for (const call of calls) {
        const missing = missingRequiredParams([call], required);
        if (missing.length > 0) {
            for (const m of missing) dropped.push(`missing required parameter: ${m}`);
            break; // Stop here — subsequent calls may depend on this one.
        }
        validCalls.push(call);
    }

    // Ensure indices sequential
    validCalls.forEach((c, i) => { c.index = i; });
    return { calls: validCalls, dropped, text: cleanText.trim() };
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
                } else if (c.type === 'file' || c.type === 'input_file') {
                    const name = c.file?.filename || c.file?.name || c.filename || c.name
                        || (typeof c.file === 'string' ? c.file : '') || c.file?.file_id || 'attachment';
                    parts.push(`[file: ${name}]`);
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
                        JSON.stringify({ name: fn.name || '', arguments: JSON.parse(args) }) +
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
    const seenIds = new Set();
    for (const call of [...(nativeCalls || []), ...(textCalls || [])]) {
        const name = normalizeToolName(call?.function?.name || '');
        const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments || {});
        if (!name) continue;
        const key = `${name}\n${args}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let id = call.id && !seenIds.has(call.id)
            ? String(call.id)
            : `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        while (seenIds.has(id)) {
            id = `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        }
        seenIds.add(id);
        merged.push({
            id,
            type: 'function',
            function: { name, arguments: args },
            index: merged.length
        });
    }
    return merged;
}

/**
 * Decide whether sendMessage should issue a one-shot nudge retry when tools were
 * declared. Plain-text replies under tool_choice="auto" are left alone; only
 * rejected/broken tool calls or explicit tool requirements trigger a retry.
 */
export function shouldRetryToolCall({ merged = [], dropped = [], toolChoice = null } = {}) {
    if (Array.isArray(merged) && merged.length > 0) return false;
    if (toolChoice === 'none') return false;
    // tool_choice=required / specific function: always retry aggressively if no call was produced,
    // regardless of whether drops look like soft examples. Check this BEFORE soft-drop detection
    // so "required" is never downgraded to a neutral nudge.
    if (toolChoice === 'required') return true;
    if (toolChoice && typeof toolChoice === 'object') {
        const fn = toolChoice.function;
        const name = (fn && typeof fn === 'object') ? fn.name : toolChoice.name;
        if (name) return true;
    }
    if (Array.isArray(dropped) && dropped.length > 0) {
        // Classify each drop:
        //   • "mid-sentence ... block ignored" — model wrote an example fence
        //     mid-prose. Do NOT nudge aggressively ("Use a tool NOW"), as that
        //     would turn the explanation into an actual command. But DO retry
        //     with a neutral prompt so the model can clarify its intent.
        //   • "bare-json-after-prose" — model placed JSON on its own line after
        //     prose. Same treatment: neutral nudge.
        //   • anything else (malformed block, missing param, undeclared tool) —
        //     real failure; nudge assertively.
        const realDrops = dropped.filter(d =>
            !d.startsWith('mid-sentence') &&
            !d.includes('block ignored') &&
            !d.startsWith('bare-json-after-prose')
        );
        if (realDrops.length > 0) return true;
        // Soft retry for mid-sentence/bare-json-after-prose: the model may have
        // intended a real tool call but wrote it in an ambiguous position.
        // Use a neutral nudge ("if you meant a tool call, place it on its own line;
        // if this was an example, reply normally") — do NOT use the aggressive
        // "IMPORTANT: Use a tool call NOW" which would turn an explanation into a command.
        const hasSoftDrop = dropped.some(d =>
            d.startsWith('mid-sentence') || d.includes('block ignored') || d.startsWith('bare-json-after-prose')
        );
        if (hasSoftDrop) return 'soft';
    }
    return false;
}