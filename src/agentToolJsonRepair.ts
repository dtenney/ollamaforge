/**
 * Tool-call JSON repair utilities.
 *
 * Extracted from agent.ts (Phase 1 decomposition). These are pure functions
 * with no `this` coupling -- they repair malformed tool-call JSON emitted by
 * small models that truncate or mis-escape their arguments.
 */

/**
 * Repair a malformed tool-call JSON string. Returns a clean JSON string or null.
 */
export function repairToolJson(raw: string): string | null {
    // Extract tool name
    const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
    if (!nameMatch) return null;
    const toolName = nameMatch[1];

    // Extract path if present
    const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/);

    // For shell_read and run_command: extract the command field robustly
    if (toolName === 'shell_read' || toolName === 'run_command') {
        // Try strict match first (well-formed JSON with closing })
        const strictMatch = raw.match(/"command"\s*:\s*"([\s\S]*?)"\s*\}/);
        // Fallback: grab everything after "command": " to end of string (malformed JSON)
        const looseMatch = raw.match(/"command"\s*:\s*"([\s\S]*)/);
        const cmdRaw = strictMatch ? strictMatch[1] : looseMatch ? looseMatch[1] : null;
        if (!cmdRaw) return null;
        // Unescape standard JSON escapes, then re-encode cleanly
        const cmdStr = cmdRaw
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            // Strip any trailing JSON structure noise (closing quotes/braces)
            .replace(/"\s*\}\s*\}?\s*$/, '');
        return `{"name":"${toolName}","arguments":{"command":${JSON.stringify(cmdStr)}}}`;
    }

    // Generic repair for simple single-field tools (memory_search, workspace_summary, memory_list, etc.)
    // These tools typically have one primary string argument -- try to extract it.
    const SIMPLE_TOOLS: Record<string, string> = {
        memory_search:    'query',
        memory_tier_write:'content',
        memory_delete:    'id',
        workspace_summary:'',  // no args
        memory_list:      '',  // no args
        get_diagnostics:  '',  // no args
        find_files:       'query',
    };
    if (toolName in SIMPLE_TOOLS) {
        const argKey = SIMPLE_TOOLS[toolName];
        if (!argKey) {
            // No-arg tool
            return `{"name":"${toolName}","arguments":{}}`;
        }
        // Try to extract the primary argument value.
        // Use a JSON-string-aware pattern that honours \" escapes inside the value,
        // so content like "key: \"value\"" or sentences with "quotes" isn't truncated.
        const argRe = new RegExp(`"${argKey}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's');
        const argMatch = raw.match(argRe);
        if (argMatch) {
            // Unescape the extracted value so JSON.stringify re-encodes it cleanly.
            let extracted = argMatch[1]
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\')
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t');
            // Also try to extract tier and tags for memory_tier_write
            const tierMatch = raw.match(/"tier"\s*:\s*(\d)/);
            const tagsMatch = raw.match(/"tags"\s*:\s*(\[[^\]]*\])/);
            const tierPart = tierMatch ? `,"tier":${tierMatch[1]}` : '';
            const tagsPart = tagsMatch ? `,"tags":${tagsMatch[1]}` : '';
            return `{"name":"${toolName}","arguments":{"${argKey}":${JSON.stringify(extracted)}${tierPart}${tagsPart}}}`;
        }
        return null;
    }

    // Repair write_file with broken content field (e.g. Python code containing \" or \' in JSON,
    // or unescaped " from f-strings that cause the brace-counter to truncate the JSON early).
    if (toolName === 'write_file' && pathMatch) {
        const contentKeyIdx = raw.indexOf('"content"');
        if (contentKeyIdx !== -1) {
            const colonIdx = raw.indexOf(':', contentKeyIdx);
            const openQuoteIdx = raw.indexOf('"', colonIdx + 1);
            if (openQuoteIdx !== -1) {
                // Try several end-markers in order of preference:
                //   1. "}} -- normal JSON close (content ends with double-quote then }})
                //   2. '}} -- model used single-quote to end content (Python style)
                //   3. </tool> stripped marker -- when brace-counter exits early, caller passes full block
                //   4. Last " in raw -- desperate fallback
                let closeIdx = raw.lastIndexOf('"}}');
                if (closeIdx <= openQuoteIdx) closeIdx = raw.lastIndexOf("'}}");
                if (closeIdx <= openQuoteIdx) {
                    // Try </tool> boundary (caller strips it, but check anyway)
                    const toolCloseIdx = raw.lastIndexOf('</tool>');
                    if (toolCloseIdx > openQuoteIdx) {
                        // Walk backwards from </tool> to find the real content end
                        let end = toolCloseIdx - 1;
                        while (end > openQuoteIdx && (raw[end] === '}' || raw[end] === "'" || raw[end] === '"')) end--;
                        closeIdx = end + 1;
                    }
                }
                if (closeIdx <= openQuoteIdx) closeIdx = raw.lastIndexOf('"');
                if (closeIdx > openQuoteIdx) {
                    const contentRaw = raw.slice(openQuoteIdx + 1, closeIdx);
                    let contentDecoded = contentRaw
                        .replace(/\\n/g, '\n')
                        .replace(/\\t/g, '\t')
                        .replace(/\\r/g, '\r')
                        .replace(/\\"/g, '"')
                        .replace(/\\\\/g, '\x00BACKSLASH\x00')  // protect real backslashes
                        .replace(/\\'/g, "'")                    // \' -> ' (Python escape, invalid JSON)
                        .replace(/\\\s/g, ' ')                   // other invalid \ sequences -> space
                        .replace(/\x00BACKSLASH\x00/g, '\\');    // restore real backslashes
                    return `{"name":"${toolName}","arguments":{"path":${JSON.stringify(pathMatch[1])},"content":${JSON.stringify(contentDecoded)}}}`;
                }
            }
        }
        return null;
    }

    // Only repair edit_file (has complex old_string/new_string fields)
    if (toolName !== 'edit_file') return null;

    if (toolName === 'edit_file') {
        // edit_file has old_string and new_string -- too complex to reliably repair
        // Try: extract path, then old_string and new_string by finding the field boundaries
        const oldStrMarker = raw.indexOf('"old_string"');
        const newStrMarker = raw.indexOf('"new_string"');
        if (oldStrMarker === -1 || newStrMarker === -1 || !pathMatch) return null;

        // Find the value start (after the colon and opening quote)
        const oldValStart = raw.indexOf('"', raw.indexOf(':', oldStrMarker) + 1) + 1;
        // The old_string value ends where new_string key begins (backtrack to find closing quote + comma)
        const oldValEnd = raw.lastIndexOf('"', newStrMarker - 1);
        const newValStart = raw.indexOf('"', raw.indexOf(':', newStrMarker) + 1) + 1;
        // new_string value ends at the last }} structure
        const newValEnd = raw.lastIndexOf('"');

        if (oldValStart <= 0 || oldValEnd <= oldValStart || newValStart <= 0 || newValEnd <= newValStart) return null;

        const oldStr = raw.slice(oldValStart, oldValEnd);
        const newStr = raw.slice(newValStart, newValEnd);

        const escOld = JSON.stringify(oldStr).slice(1, -1);
        const escNew = JSON.stringify(newStr).slice(1, -1);
        return `{"name":"edit_file","arguments":{"path":"${pathMatch[1]}","old_string":"${escOld}","new_string":"${escNew}"}}`;
    }

    return null;
}

/**
 * Fix raw (unescaped) newlines/tabs inside JSON string values.
 * Walks character by character to avoid regex catastrophe on large payloads.
 * Only escapes characters that appear inside JSON string values (between unescaped quotes).
 */
export function fixRawNewlinesInJson(s: string): string {
    const out: string[] = [];
    let inString = false;
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === '\\' && inString) {
            // Pass escape sequence through unchanged
            out.push(ch);
            i++;
            if (i < s.length) { out.push(s[i]); i++; }
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            out.push(ch);
            i++;
            continue;
        }
        if (inString) {
            if (ch === '\n') { out.push('\\n'); i++; continue; }
            if (ch === '\r') { out.push('\\r'); i++; continue; }
            if (ch === '\t') { out.push('\\t'); i++; continue; }
        }
        out.push(ch);
        i++;
    }
    return out.join('');
}

/**
 * Direct field extraction for edit_file tool calls that fail JSON.parse.
 * Extracts name, path, old_string, new_string by finding field boundaries,
 * handling the case where new_string contains raw code with unescapable characters.
 */
export function extractEditFileArgs(jsonStr: string): { name: string; arguments: Record<string, unknown> } | null {
    try {
        // Extract tool name
        const nameMatch = jsonStr.match(/"name"\s*:\s*"(edit_file(?:_at_line)?)"/);
        if (!nameMatch) return null;
        const toolName = nameMatch[1];

        // Extract path
        const pathMatch = jsonStr.match(/"path"\s*:\s*"([^"\\]*)"/);
        if (!pathMatch) return null;
        const filePath = pathMatch[1];

        // Extract old_string: find the value between "old_string": " and the next unescaped "
        // For new-file creation old_string is always empty, handle that fast path
        const oldStringEmptyMatch = jsonStr.match(/"old_string"\s*:\s*""/);
        const oldString = oldStringEmptyMatch ? '' : extractJsonStringValue(jsonStr, 'old_string');

        // Extract new_string: the large content block
        // Find "new_string": " then take everything up to the end of the JSON object
        const newString = extractJsonStringValue(jsonStr, 'new_string');
        if (newString === null) return null;

        return {
            name: toolName,
            arguments: { path: filePath, old_string: oldString ?? '', new_string: newString }
        };
    } catch {
        return null;
    }
}

/** Extract a JSON string value by key, handling escape sequences. Returns raw (unescaped) string. */
export function extractJsonStringValue(jsonStr: string, key: string): string | null {
    const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`);
    const keyMatch = keyPattern.exec(jsonStr);
    if (!keyMatch) return null;

    let i = keyMatch.index + keyMatch[0].length;
    const chars: string[] = [];
    while (i < jsonStr.length) {
        const ch = jsonStr[i];
        if (ch === '\\' && i + 1 < jsonStr.length) {
            const next = jsonStr[i + 1];
            switch (next) {
                case '"': chars.push('"'); break;
                case '\\': chars.push('\\'); break;
                case '/': chars.push('/'); break;
                case 'n': chars.push('\n'); break;
                case 'r': chars.push('\r'); break;
                case 't': chars.push('\t'); break;
                case 'b': chars.push('\b'); break;
                case 'f': chars.push('\f'); break;
                default: chars.push('\\', next); break;
            }
            i += 2;
            continue;
        }
        if (ch === '"') break; // end of string value
        chars.push(ch);
        i++;
    }
    return chars.join('');
}
