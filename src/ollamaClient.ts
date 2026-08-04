import * as http from 'http';
import * as https from 'https';
import { getConfig, parseBaseUrl } from './config';
import { logInfo, logWarn, logError, toErrorMessage } from './logger';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface OllamaMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
    function: { name: string; arguments: Record<string, unknown> };
}

export interface StreamResult {
    content: string;
    toolCalls: OllamaToolCall[];
    /** Average log-probability of generated tokens, or null if the model didn't return logprobs. */
    avgLogprob: number | null;
    /** Full thinking/reasoning content from <think> block, if any. */
    thinking: string;
}

// ── Endpoint helpers ──────────────────────────────────────────────────────────

function getEndpoint(): { hostname: string; port: number; isHttps: boolean } {
    const { baseUrl } = getConfig();
    const { hostname, port, protocol } = parseBaseUrl(baseUrl);
    return { hostname, port, isHttps: protocol === 'https:' };
}

function makeRequest(
    options: http.RequestOptions,
    callback: (res: http.IncomingMessage) => void
): http.ClientRequest {
    const { isHttps } = getEndpoint();
    return isHttps
        ? https.request(options, callback)
        : http.request(options, callback);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export function rawGet(
    urlPath: string,
    timeoutMs = 5000
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const { hostname, port } = getEndpoint();
        const req = makeRequest(
            { hostname, port, path: urlPath, method: 'GET', timeout: timeoutMs },
            (res) => {
                let body = '';
                res.on('data', (c: Buffer) => (body += c.toString()));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Get the exact token count for a text string using Ollama's /api/tokenize endpoint.
 * Much more accurate than the char/4 heuristic, especially for models with large
 * vocabularies like gemma4 (20-30% drift possible with heuristic — see CODE_REVIEW_FINDINGS #8).
 *
 * Returns null if the endpoint is unavailable or errors (caller should fall back to heuristic).
 * Results are NOT cached here — call sites should cache for repeated content (system prompt, memory).
 */
export async function tokenizeText(model: string, text: string): Promise<number | null> {
    const { hostname, port, isHttps } = { ...getEndpoint() };
    return new Promise((resolve) => {
        const body = JSON.stringify({ model, prompt: text });
        const req = (isHttps ? https : http).request(
            { hostname, port, path: '/api/tokenize', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
              timeout: 5000 },
            (res) => {
                let buf = '';
                res.on('data', (c: Buffer) => (buf += c.toString()));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(buf) as { tokens?: number[] };
                        resolve(parsed.tokens ? parsed.tokens.length : null);
                    } catch { resolve(null); }
                });
            }
        );
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        try {
            req.write(body);
            req.end();
        } catch {
            resolve(null);
        }
    });
}

/** Sentinel thrown when the model doesn't support Ollama native tool calling. */
export class ToolsNotSupportedError extends Error {
    constructor(model: string) {
        super(`Model "${model}" does not support native tool calling. Switched to text-mode.`);
        this.name = 'ToolsNotSupportedError';
    }
}

export function streamChatRequest(
    model: string,
    messages: OllamaMessage[],
    tools: unknown[],
    onToken: (t: string) => void,
    stopRef: { stop: boolean; destroy?: () => void },
    options?: {
        disableThinkingGuards?: boolean;
        /**
         * Cap on visible output tokens (num_predict). Defaults to 2048.
         * Pass -1 only for turns where the model must emit large file content directly
         * (i.e. write_file with content inline in the response, not as a tool arg).
         * Thinking tokens are separate and not counted against this limit.
         */
        numPredict?: number;
    }
): Promise<StreamResult> {
    return new Promise((resolve, reject) => {
        const { hostname, port } = getEndpoint();
        const cfg = getConfig();
        const payload: Record<string, unknown> = {
            model,
            messages,
            stream: true,
            logprobs: true,
        };
        // Only include tools if non-empty (some models reject the field when empty)
        if (tools.length) { payload.tools = tools; }
        // Build options — temperature and thinking mode
        const opts: Record<string, unknown> = {};
        // Auto-enable thinking for models with native chain-of-thought support,
        // even if the user hasn't explicitly toggled it.
        const modelLower = model.toLowerCase();
        const modelSupportsThinking = /qwen3|deepseek-r1|deepseek-r2|gemma4|phi4-reasoning/.test(modelLower);
        const thinkingEnabled = cfg.enableThinking || modelSupportsThinking;
        if (thinkingEnabled) {
            // `think` is a top-level Ollama parameter, NOT inside options{} — sending it inside options
            // causes "invalid option provided: think" warnings in Ollama logs (OLLAMA_LOOP_BUG.md).
            (payload as Record<string, unknown>).think = true;
            // Accuracy over speed: use lower temperature when thinking is on.
            // High temp + chain-of-thought = hallucination. Default 0.7 → 0.3 for thinking models.
            const effectiveTemp = cfg.temperature !== 0.7 ? cfg.temperature : 0.3;
            opts.temperature = effectiveTemp;
        } else if (cfg.temperature !== 0.7) {
            opts.temperature = cfg.temperature;
        }
        // Inject num_ctx when the user has configured a context window override.
        // This tells Ollama to load/use that context size for this request,
        // overriding whatever the model's Modelfile specifies.
        if (cfg.contextWindow > 0) {
            opts.num_ctx = cfg.contextWindow;
        }
        // Cap visible output tokens to prevent runaway generation / infinite thinking loops.
        // In native tool-call mode, tool arguments don't count against this limit — 2048 is fine.
        // In text mode (qwen3 etc.), the entire response including inline tool-call JSON counts,
        // so long SSH commands or file paths can cause truncation at 2048, producing garbage output.
        // 4096 gives enough headroom for tool calls + surrounding text without enabling spirals.
        opts.num_predict = options?.numPredict ?? 4096;
        if (Object.keys(opts).length > 0) { payload.options = opts; }
        // keep_alive: how long Ollama holds the model in GPU memory after the request.
        // Configured by the user; defaults to '10m' to avoid cold-start latency on consecutive calls.
        if (cfg.keepAlive) { payload.keep_alive = cfg.keepAlive; }

        const body = JSON.stringify(payload);
        logInfo(`POST /api/chat  model=${model}  msgs=${messages.length}  think=${thinkingEnabled}  temp=${opts.temperature ?? 0.7}  num_predict=${opts.num_predict}  num_ctx=${cfg.contextWindow || 'model-default'}  keep_alive=${cfg.keepAlive || 'default'}`);

        const req = makeRequest(
            {
                hostname, port, path: '/api/chat', method: 'POST',
                timeout: 600_000,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    let e = '';
                    res.on('data', (c: Buffer) => (e += c.toString()));
                    res.on('end', () => {
                        // Detect the "model does not support tools" 400 specifically
                        if (res.statusCode === 400 && e.toLowerCase().includes('does not support tools')) {
                            reject(new ToolsNotSupportedError(model));
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${e}`));
                        }
                    });
                    return;
                }

                let fullContent = '';
                let fullThinking = '';
                let toolCalls: OllamaToolCall[] = [];
                let buf = '';
                let resolved = false;
                let thinkingStarted = false;
                let insideToolBlock = false; // suppress repetition detection inside <tool>...</tool>
                // Logprob accumulation — Ollama returns per-token logprobs when logprobs:true is set
                let logprobSum = 0;
                let logprobCount = 0;
                // Repetition detection — abort if the model enters a true token loop
                // (e.g. "brokensoitis" repeated hundreds of times).
                // Content thresholds are strict (short phrase, many repeats).
                // Thinking thresholds are looser — thinking is naturally more repetitive.
                const REPETITION_WINDOW = 800;      // chars to inspect
                const REPETITION_PHRASE = 50;       // min phrase length for content (was 20 -- too short, fired on find -name patterns)
                const REPETITION_THRESHOLD = 6;     // times seen in content = abort
                const THINK_REPETITION_PHRASE = 60; // longer phrase for thinking -- model restates plan in slightly varied ways
                const THINK_REPETITION_THRESHOLD = 8; // more occurrences needed in thinking before abort

                // Hard cap on thinking block size — prevents list-continuation spirals
                // (e.g. "27. Check ... 28. Check ... 29. Check ...") that evade phrase detection.
                // Pattern from ogcode: two-tier approach — text tokens stream freely,
                // reasoning tokens have a hard cap and are truncated with a marker.
                // 12k chars ≈ ~3000 tokens of thinking before we force a commit.
                // 32k allows complex design/geometry/multi-file tasks to reason fully before acting.
                // Spirals are caught earlier by isListSpiral/isRepeating; this cap is the backstop.
                const MAX_THINKING_CHARS = 32000;

                const isRepeating = (content: string, phraseMin = REPETITION_PHRASE, threshold = REPETITION_THRESHOLD): boolean => {
                    // Slide a window over the last N chars of content
                    const tail = content.slice(-REPETITION_WINDOW);
                    if (tail.length < phraseMin * threshold) { return false; }
                    // Try phrase lengths from short to medium
                    for (let len = phraseMin; len <= phraseMin + 20; len++) {
                        const phrase = tail.slice(-len);
                        // Count non-overlapping occurrences in the tail
                        let count = 0;
                        let pos = 0;
                        while ((pos = tail.indexOf(phrase, pos)) !== -1) { count++; pos += len; }
                        if (count >= threshold) { return true; }
                    }
                    return false;
                };

                // Detect thinking spirals of several patterns:
                // 1. Numbered list items incrementing without resolving ("27. Check... 28. Check...")
                // 2. Hyphen-joined sentence repetition ("I-will-start-by..." repeated many times)
                // 3. High line-to-unique-line ratio (same short lines repeating with minor variation)
                const isListSpiral = (thinking: string): boolean => {
                    if (thinking.length < 1200) { return false; }
                    const tail = thinking.slice(-1200);

                    // Pattern 1: consecutive numbered list items — fire on long runs (10+)
                    // or on "Search for" / "Look up" planning lists (6+ items) which are
                    // pre-action planning spirals that never resolve to a tool call.
                    // Exempt: thinking contains a concrete file path — model has identified its target and is about to act.
                    const hasConcreteTarget = /scripts\/\w+\.(py|sh|js|ts)\b|loot\/\w+|\.ollamaforge\//.test(thinking);
                    // Procurement/shopping tasks legitimately enumerate many search targets (find URLs for 15 items).
                    // Check ALL user messages (not just last) — context trimming may move the procurement request earlier.
                    const PROCUREMENT_RE = /\b(url|link|purchase|procure|buy|order|amazon|aliexpress|shop|price|cost)\b/i;
                    const isProcurementTask = messages.some(m => m.role === 'user' && PROCUREMENT_RE.test(typeof m.content === 'string' ? m.content : ''));
                    const nums = [...tail.matchAll(/^\s*(\d+)\.\s+/mg)].map(m => parseInt(m[1]));
                    if (nums.length >= 10 && !hasConcreteTarget && !isProcurementTask) {
                        let consecutive = 0;
                        for (let i = 1; i < nums.length; i++) {
                            if (nums[i] === nums[i - 1] + 1) { consecutive++; } else { consecutive = 0; }
                            if (consecutive >= 9) { logWarn('[stream] isListSpiral: pattern 1 (consecutive nums)'); return true; }
                        }
                    }
                    // Planning-list spiral: pure search/fetch enumeration — model narrates
                    // its entire research plan instead of acting. Only catch web-research verbs
                    // (Search/Find/Look up/Get/Fetch) NOT edit verbs (Update/Edit/Add) which are
                    // legitimate multi-step edit plans for restructuring tasks.
                    // Exempt past-tense status recaps: "I have already: 1. Searched... 2. Added..."
                    const isPastTenseContext = /\b(already|have\s+already|i\s+have|was|were|completed|done with|finished)\b/i.test(tail.slice(0, 300));
                    const planLinesTail = [...tail.matchAll(/^\s*\d+\.\s+(Search|Look\s+up|Find|Get|Fetch)\b/gim)];
                    if (planLinesTail.length >= 7 && !isPastTenseContext && !isProcurementTask) { logWarn('[stream] isListSpiral: pattern 1b (search-verb list)'); return true; }
                    // Check the tail for a dense status checklist — the model rewrites
                    // its full to-do list in the tail every retry (not just once at the start).
                    // Require 10+ (Done|Pending) items in the 1200-char tail. Exempt if model has a concrete target.
                    const tailPlanLines = [...tail.matchAll(/^\s*\d+\.\s+.+\((Done|Pending|Found|Needed|TBD)\)/gim)];
                    if (tailPlanLines.length >= 10 && !hasConcreteTarget) { logWarn('[stream] isListSpiral: pattern 1c (status checklist)'); return true; }
                    // Pattern 1d: markdown checkbox checklist re-enumeration — model is re-reading its
                    // full to-do list with [ ] / [x] syntax instead of acting on the next item.
                    // Triggered when 5+ checkbox items appear in the tail AND similar items appeared
                    // earlier in thinking (i.e. the model is cycling through the same list again).
                    const tailCheckboxLines = [...tail.matchAll(/^\s*[-*]?\s*\[[ xX]\]\s+.+/gm)];
                    const earlyCheckboxLines = [...thinking.slice(0, -1200).matchAll(/^\s*[-*]?\s*\[[ xX]\]\s+.+/gm)];
                    if (tailCheckboxLines.length >= 5 && earlyCheckboxLines.length >= 5 && !hasConcreteTarget) {
                        logWarn('[stream] isListSpiral: pattern 1d (checkbox checklist re-enumeration)');
                        return true;
                    }

                    // Pattern 2: hyphen-joined word-salad repetition (e.g. "I-will-use-ls-R." many times)
                    const hyphenLines = tail.match(/^[A-Z][a-z-]+-[a-z-]+-[a-z-]+[a-z-. ]*$/mg) ?? [];
                    if (hyphenLines.length >= 5) { logWarn('[stream] isListSpiral: pattern 2 (hyphen word-salad)'); return true; }

                    // (Pattern 3 / 3b removed — repetition ratio and self-ref checks produced too many
                    // false positives on legitimate code analysis and multi-step planning reasoning.
                    // The hard MAX_THINKING_CHARS cap and exact-phrase isRepeating() catch true runaway loops.)

                    // Pattern 4: dash-bullet enumeration spiral — model narrating a list/dict item by item
                    // e.g. "- omada: systemd\n- pihole-FTL: systemd\n- vaultwarden: systemd\n..."
                    // Only trigger if there are many bullets AND they have a highly repetitive structure
                    // (same key: value pattern with SHORT single-word values). Normal planning lists
                    // and directory explorations have varied, longer content and must not be caught here.
                    const dashBulletLines = [...tail.matchAll(/^\s*[-*]\s+\S.*/mg)].map(m => m[0].trim());
                    if (dashBulletLines.length >= 20) {
                        // Require value to be a short single token (1-15 chars, no spaces/slashes) —
                        // this targets inventory narration ("- service: systemd") not directory planning
                        // ("- wifipineapplepager-payloads/: need to check contents").
                        const kvPattern = dashBulletLines.filter(l => /^[-*]\s+\S+\s*:\s*[^\s/\\]{1,15}$/.test(l));
                        if (kvPattern.length / dashBulletLines.length > 0.7) { logWarn('[stream] isListSpiral: pattern 4a (kv bullet)'); return true; }
                        // Also catch numbered enumeration within bullet sections: "1. item\n2. item\n..."
                        const numberedInBullets = [...tail.matchAll(/^\s+\d+\.\s+\S.*/mg)];
                        if (numberedInBullets.length >= 12) { logWarn('[stream] isListSpiral: pattern 4b (numbered-in-bullets)'); return true; }
                    }

                    // Pattern 5: asterisk-emphasis oscillation spiral
                    if (thinking.length > 800) {
                        const thinkTail = thinking.slice(-2000);
                        const waitOscillations = (thinkTail.match(/\*(?:wait|actually|let'?s|ok|alright|so|now)[,.]?\*/gi) ?? []).length;
                        if (waitOscillations >= 5) { logWarn('[stream] isListSpiral: pattern 5a (wait* oscillation)'); return true; }
                        const waitLines = (thinkTail.match(/^\s*\*?(?:wait|actually)[,.]?\*?/gim) ?? []).length;
                        if (waitLines >= 6) { logWarn('[stream] isListSpiral: pattern 5b (wait lines)'); return true; }
                        // Pattern 5c: "Hmm/Let me reconsider/Let me think again" oscillation —
                        // model replanning repeatedly without acting. Broader than 5a/5b.
                        const rethinkLines = (thinkTail.match(/^\s*(?:hmm+[,.]?|let me (?:re(?:consider|think|read|check)|think again|re-read|recalculate)|actually,? (?:wait|no|let)|on second thought|i(?:'m| am) second-guessing)[,.]?/gim) ?? []).length;
                        if (rethinkLines >= 5) { logWarn('[stream] isListSpiral: pattern 5c (rethink oscillation)'); return true; }
                    }

                    // Pattern 6 (formerly 5): underscore-joined CamelCase fragment repetition
                    // e.g. "_Wait_I_Found_It_In_Search_Results_Earlier_Actually_I_Will_Use_The_One_From_Search_Result_1_Earlier_Actually..."
                    // These are long underscore-delimited tokens that repeat as the model oscillates
                    // between candidates. The isRepeating() window (400 chars) misses this because
                    // the fragment itself is often >100 chars. Use the full thinking tail here.
                    const underscoreFragments = thinking.slice(-2000).match(/_[A-Z][A-Za-z_0-9]{20,}/g) ?? [];
                    if (underscoreFragments.length >= 6) {
                        // Check if the same fragment appears 3+ times (repetition, not just multiple long tokens)
                        const fragCounts = new Map<string, number>();
                        for (const f of underscoreFragments) {
                            fragCounts.set(f, (fragCounts.get(f) ?? 0) + 1);
                        }
                        if ([...fragCounts.values()].some(c => c >= 3)) { logWarn('[stream] isListSpiral: pattern 6 (underscore fragment)'); return true; }
                    }

                    return false;
                };

                res.on('data', (chunk: Buffer) => {
                    if (stopRef.stop) { req.destroy(); return; }
                    buf += chunk.toString();
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';

                    for (const line of lines) {
                        if (!line.trim()) { continue; }
                        try {
                            const p = JSON.parse(line);
                            if (p.message?.thinking) {
                                // Send thinking via sentinel tokens so the webview can render
                                // it as a collapsible <details> block. Accumulate for return value too.
                                if (!thinkingStarted) {
                                    onToken('\x01THINK_START\x01');
                                    thinkingStarted = true;
                                }
                                fullThinking += p.message.thinking;
                                onToken(p.message.thinking);
                                // Thinking block guards: repetition, list spiral, hard size cap
                                // Disabled for sub-agent calls (e.g. critic) that legitimately
                                // include code in their thinking when reviewing a file.
                                if (!resolved && !options?.disableThinkingGuards) {
                                    const thinkingLoop = isRepeating(fullThinking, THINK_REPETITION_PHRASE, THINK_REPETITION_THRESHOLD);
                                    const thinkingSpiral = !thinkingLoop && isListSpiral(fullThinking);
                                    const thinkingOverflow = fullThinking.length > MAX_THINKING_CHARS;
                                    // Detect pre-drafting: model writing file content in thinking
                                    // (markdown tables, code fences, numbered list of file lines).
                                    // Pattern: thinking contains 3+ markdown table rows OR a large
                                    // code fence block — model is constructing the output in reasoning
                                    // instead of just calling write_file/edit_file directly.
                                    // Pre-draft detection: model is writing the full file content inside
                                    // thinking instead of calling write_file. Key signatures:
                                    // - A markdown code fence with 500+ chars of content (explicit draft)
                                    // - 12+ consecutive table rows in the last 3000 chars (reconstructing a table)
                                    const thinkTail3k = fullThinking.slice(-3000);
                                    const thinkTail1500 = fullThinking.slice(-1500);
                                    const consecutiveTableRows = (thinkTail3k.match(/^\s*\|.+\|/mg) ?? []).length;
                                    // Pre-draft = model writing NEW file content in thinking tail.
                                    // Only look at the LAST 1500 chars — the model legitimately
                                    // quotes existing file content earlier in thinking while reviewing.
                                    // A code fence only in the tail means it is actively drafting.
                                    // Threshold: 8000 chars of thinking before firing.
                                    // Lower thresholds (3500) caused false positives: model planning a complex edit
                                    // legitimately generates 3500 chars of YAML reasoning before calling edit_file.
                                    // The tail check (last 1500 chars) is the real guard — a large code fence in the
                                    // tail means the model is actively drafting output, not just planning.
                                    // Code fence content must be 1200+ chars to distinguish full file drafts from
                                    // short snippets the model quotes while reasoning about an edit.
                                    // NOTE: No suppression on retry — always fire when pre-drafting is detected.
                                    const thinkingPreDraft = !thinkingLoop && !thinkingSpiral && fullThinking.length > 12000 && (
                                        /```(?:python|py|bash|sh|js|ts|yaml|yml|json|toml|ini|conf|config|cpp|c|h|rs|go|rb|php|html|css|sql|xml|scad|openscad|gcode|ino)?\n[\s\S]{1200,}/m.test(thinkTail1500) ||
                                        consecutiveTableRows >= 12
                                    );
                                    if (thinkingLoop || thinkingSpiral || thinkingOverflow || thinkingPreDraft) {
                                        const reason = thinkingLoop ? 'repetition loop' : thinkingSpiral ? 'list-continuation spiral' : thinkingPreDraft ? 'pre-drafting file content in thinking' : `thinking exceeded ${MAX_THINKING_CHARS} chars`;
                                        logWarn(`[stream] Thinking block aborted — ${reason} after ${fullThinking.length} chars`);
                                        resolved = true;
                                        stopRef.stop = true; // suppress req.on('error') ECONNRESET after destroy
                                        req.destroy();
                                        // Close the thinking block in the webview — without this the THINK_END
                                        // sentinel is never emitted and all recovery content routes to the
                                        // thought panel instead of the visible chat response.
                                        if (thinkingStarted) {
                                            onToken('\x01THINK_END\x01');
                                            thinkingStarted = false;
                                        }
                                        const avgLogprob = logprobCount > 0 ? logprobSum / logprobCount : null;
                                        // Build recovery content for the agent's MODEL_SELF_STOP_RE handler to pick up.
                                        // Never emit the extracted conclusion as a visible user-facing message —
                                        // it looks like a broken partial response. Instead treat all thinking-abort
                                        // cases the same as overflow: return a [Generation stopped] sentinel that
                                        // the agent catches and silently retries.
                                        const recoveryContent = fullContent
                                            || (thinkingPreDraft
                                                ? `\n\n[Generation stopped — you were writing the file content inside your thinking block instead of calling a tool. Call write_file or edit_file_at_line NOW with the content you planned. Do not re-draft it in thinking.]\n`
                                                : thinkingLoop || thinkingSpiral
                                                ? `\n\n[Generation stopped — ${reason}. Resume the answer directly without re-enumerating steps — start from your conclusion.]\n`
                                                : `\n\n[Generation stopped — ${reason}. Please retry.]\n`);
                                        // Never emit recovery content as a visible token — the agent's
                                        // MODEL_SELF_STOP_RE catches result.content and auto-retries silently.
                                        // Emitting it would show the user a confusing partial message.
                                        resolve({ content: recoveryContent, toolCalls, avgLogprob, thinking: fullThinking.slice(0, 4000) + (fullThinking.length > 4000 ? `\n[thinking truncated — ${reason}]` : '') });
                                        // (removed: "let stream continue" — model never exits think naturally when narrating lists)
                                    }
                                }
                            }
                            if (p.message?.content) {
                                if (thinkingStarted && !fullContent) {
                                    thinkingStarted = false;
                                    onToken('\x01THINK_END\x01');
                                }
                                fullContent += p.message.content;
                                onToken(p.message.content);
                                // Track whether we're inside a <tool> block -- repetition patterns
                                // inside tool JSON (e.g. repeated -name flags in find commands) are
                                // not real loops and must not trigger the abort.
                                if (fullContent.includes('<tool>')) {
                                    const lastToolOpen = fullContent.lastIndexOf('<tool>');
                                    const lastToolClose = fullContent.lastIndexOf('</tool>');
                                    insideToolBlock = lastToolOpen > lastToolClose;
                                }
                                // Repetition guard: abort stream if model enters a token loop
                                if (!resolved && !insideToolBlock && isRepeating(fullContent)) {
                                    logWarn(`[stream] Repetition loop detected after ${fullContent.length} chars — aborting stream`);
                                    resolved = true;
                                    stopRef.stop = true;
                                    req.destroy();
                                    const avgLogprob = logprobCount > 0 ? logprobSum / logprobCount : null;
                                    const trimAt = Math.max(0, fullContent.length - REPETITION_WINDOW);
                                    resolve({ content: fullContent.slice(0, trimAt) + '\n\n[Generation stopped — repetition loop detected]', toolCalls, avgLogprob, thinking: fullThinking });
                                }
                                // Guard: bare closing tag loops in visible content.
                                // Model emits </think>, </antThinking>, </function>, </function_calls>
                                // repeatedly without ever opening the block — too short for isRepeating().
                                if (!resolved && fullContent.length > 500) {
                                    const thinkTagTail = fullContent.slice(-1000);
                                    const thinkTagCount    = (thinkTagTail.match(/<\/think>/g) ?? []).length;
                                    const antThinkTagCount = (thinkTagTail.match(/<\/antThinking>/gi) ?? []).length;
                                    const fnTagCount       = (thinkTagTail.match(/<\/(?:function|function_calls|invoke)>/gi) ?? []).length;
                                    if (thinkTagCount >= 8 || antThinkTagCount >= 8 || fnTagCount >= 8) {
                                        const whichTag = thinkTagCount >= 8 ? '</think>' : antThinkTagCount >= 8 ? '</antThinking>' : '</function>';
                                        logWarn(`[stream] ${whichTag} tag loop detected — aborting`);
                                        resolved = true;
                                        stopRef.stop = true;
                                        req.destroy();
                                        const avgLogprobTT = logprobCount > 0 ? logprobSum / logprobCount : null;
                                        const thinkTagStart = Math.max(
                                            fullContent.lastIndexOf('<think>'),
                                            fullContent.toLowerCase().lastIndexOf('<antthinking>'),
                                            fullContent.toLowerCase().lastIndexOf('<function_calls>'),
                                            fullContent.toLowerCase().lastIndexOf('<invoke>'),
                                        );
                                        const cleanContentTT = thinkTagStart > 0 ? fullContent.slice(0, thinkTagStart) : '';
                                        onToken('\n\n[Generation stopped — reasoning loop detected. Please retry.]');
                                        resolve({ content: cleanContentTT + '\n\n[Generation stopped — reasoning loop detected. Please retry.]', toolCalls, avgLogprob: avgLogprobTT, thinking: fullThinking });
                                    }
                                }
                                // Oscillation guard for <think>-in-content models (gemma4, etc.):
                                // "Wait, I'll use..." / "Actually, I'll just..." repeated many times.
                                // isRepeating misses this because each iteration varies slightly.
                                // Only check when content is large enough to be a real spiral (> 3000 chars).
                                if (!resolved && fullContent.length > 3000) {
                                    const tail = fullContent.slice(-3000);
                                    const oscillations = (tail.match(/\b(?:wait|actually)[,.]?\s+i.ll\s+(?:use|just|try|do|check|re-read|call)\b/gi) ?? []).length;
                                    if (oscillations >= 6) {
                                        logWarn(`[stream] Oscillation spiral detected (${oscillations} wait/actually cycles in last 3000 chars) — aborting`);
                                        resolved = true;
                                        stopRef.stop = true;
                                        req.destroy();
                                        const avgLogprob2 = logprobCount > 0 ? logprobSum / logprobCount : null;
                                        // Strip the looping think block from output — keep only content before the spiral
                                        const thinkStart = fullContent.lastIndexOf('<think>');
                                        const cleanContent = thinkStart > 0 ? fullContent.slice(0, thinkStart) : '';
                                        onToken('\n\n[Generation stopped — reasoning loop detected. Please retry.]');
                                        resolve({ content: cleanContent + '\n\n[Generation stopped — reasoning loop detected. Please retry.]', toolCalls, avgLogprob: avgLogprob2, thinking: fullThinking });
                                    }
                                }
                            }
                            if (p.message?.tool_calls?.length) {
                                toolCalls = p.message.tool_calls;
                            }
                            // Accumulate per-token logprobs (Ollama streams one token per chunk)
                            if (Array.isArray(p.logprobs)) {
                                for (const lp of p.logprobs as Array<{ logprob?: number }>) {
                                    if (typeof lp.logprob === 'number' && isFinite(lp.logprob)) {
                                        logprobSum += lp.logprob;
                                        logprobCount++;
                                    }
                                }
                            }
                            if (p.done && !resolved) {
                                resolved = true;
                                const avgLogprob = logprobCount > 0 ? logprobSum / logprobCount : null;
                                if (fullThinking) { logInfo(`[think] ${fullThinking.length} thinking chars`); }
                                if (avgLogprob !== null) { logInfo(`[logprobs] avg=${avgLogprob.toFixed(3)} over ${logprobCount} tokens`); }
                                logInfo(`Stream done — ${fullContent.length} chars, ${toolCalls.length} tool calls`);
                                // If the model produced thinking but no visible content and no tool calls,
                                // it got stuck in the thinking block and stopped. Return empty content —
                                // agent.ts will detect this and extract the question from result.thinking
                                // after the stream resolves, with correct streamStart/streamEnd framing.
                                const effectiveContent = fullContent;
                                resolve({ content: effectiveContent, toolCalls, avgLogprob, thinking: fullThinking });
                            }
                        } catch { /* skip malformed line */ }
                    }
                });

                res.on('end', () => {
                    if (!resolved) {
                        resolved = true;
                        const avgLogprob = logprobCount > 0 ? logprobSum / logprobCount : null;
                        resolve({ content: fullContent, toolCalls, avgLogprob, thinking: fullThinking });
                    }
                });
                res.on('error', reject);
            }
        );
        // Expose immediate destroy so callers can abort without waiting for next chunk
        stopRef.destroy = () => req.destroy();
        req.on('timeout', () => { req.destroy(); reject(new Error('Chat request timed out (600s)')); });
        req.on('error', (err) => {
            // Ignore ECONNRESET caused by our own destroy() on stop
            if ((err as NodeJS.ErrnoException).code === 'ECONNRESET' && stopRef.stop) { return; }
            logError(`streamChatRequest: ${err.message}`);
            reject(err);
        });
        req.write(body);
        req.end();
    });
}

// ── FIM (Fill-in-the-Middle) via /api/generate ───────────────────────────────

export function streamGenerateRequest(
    model: string,
    prompt: string,
    suffix: string,
    onToken: (t: string) => void,
    stopRef: { stop: boolean }
): Promise<string> {
    return new Promise((resolve, reject) => {
        const { hostname, port } = getEndpoint();
        const payload: Record<string, unknown> = {
            model,
            prompt,
            suffix,
            stream: true,
            raw: true,
            options: { temperature: 0, num_predict: 256, stop: ['\n\n\n'] },
        };

        const body = JSON.stringify(payload);
        logInfo(`POST /api/generate (FIM)  model=${model}  prefix=${prompt.length}c  suffix=${suffix.length}c`);

        let settled = false;
        const req = makeRequest(
            {
                hostname, port, path: '/api/generate', method: 'POST',
                timeout: 15_000,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    let e = '';
                    res.on('data', (c: Buffer) => (e += c.toString()));
                    res.on('end', () => { if (!settled) { settled = true; reject(new Error(`HTTP ${res.statusCode}: ${e}`)); } });
                    return;
                }

                let fullContent = '';
                let buf = '';

                res.on('data', (chunk: Buffer) => {
                    if (stopRef.stop) { req.destroy(); return; }
                    buf += chunk.toString();
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const p = JSON.parse(line);
                            if (p.response) {
                                fullContent += p.response;
                                onToken(p.response);
                            }
                            if (p.done && !settled) {
                                settled = true;
                                resolve(fullContent);
                            }
                        } catch { /* skip malformed line */ }
                    }
                });

                res.on('end', () => { if (!settled) { settled = true; resolve(fullContent); } });
                res.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
            }
        );
        req.on('timeout', () => { req.destroy(); if (!settled) { settled = true; reject(new Error('FIM request timed out')); } });
        req.on('error', (err) => {
            logError(`streamGenerateRequest: ${err.message}`);
            if (!settled) { settled = true; reject(err); }
        });
        req.write(body);
        req.end();
    });
}

/**
 * Generate a short chat title from the first exchange.
 * Fires a non-streaming /api/generate call with a tight token budget.
 * Returns null on any error so callers can fall back to deriveTitle().
 */
export async function generateChatTitle(
    model: string,
    userMessage: string,
    assistantSnippet: string
): Promise<string | null> {
    return new Promise((resolve) => {
        const { hostname, port } = getEndpoint();
        const prompt =
            `Summarize this conversation in 5 words or fewer as a chat title. ` +
            `Reply with only the title, no punctuation.\n\nUser: ${userMessage.slice(0, 300)}\nAssistant: ${assistantSnippet.slice(0, 300)}`;
        const payload = JSON.stringify({
            model,
            prompt,
            stream: false,
            options: { temperature: 0.3, num_predict: 16 },
        });

        const req = makeRequest(
            {
                hostname, port, path: '/api/generate', method: 'POST',
                timeout: 10_000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            },
            (res) => {
                let raw = '';
                res.on('data', (c: Buffer) => (raw += c.toString()));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(raw);
                        const title = (parsed.response as string | undefined)?.trim().replace(/[.!?]+$/, '');
                        resolve(title && title.length > 0 && title.length < 80 ? title : null);
                    } catch { resolve(null); }
                });
            }
        );
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(payload);
        req.end();
    });
}

/**
 * Send a keep-alive (empty generate) to Ollama to pre-load the model into GPU memory.
 * Fires-and-forgets — any error is silently ignored.
 */
export function keepAliveModel(model: string): void {
    const { hostname, port } = getEndpoint();
    const keepAlive = getConfig().keepAlive || '10m';
    const body = JSON.stringify({ model, keep_alive: keepAlive, prompt: '', stream: false });
    try {
        const req = makeRequest(
            {
                hostname, port, path: '/api/generate', method: 'POST',
                timeout: 30_000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            },
            (res) => {
                res.resume(); // discard response body
                logInfo(`[keep-alive] model=${model} status=${res.statusCode}`);
            }
        );
        req.on('error', () => { /* ignore — Ollama may not be running yet */ });
        req.write(body);
        req.end();
    } catch { /* ignore */ }
}

/** Cached model list with TTL */
let _cachedModels: { names: string[]; timestamp: number } | null = null;
const MODELS_TTL_MS = 60_000; // 60 seconds

export async function fetchModels(): Promise<string[]> {
    // Return cached list if still fresh
    if (_cachedModels && (Date.now() - _cachedModels.timestamp) < MODELS_TTL_MS) {
        return _cachedModels.names;
    }
    try {
        const { status, body } = await rawGet('/api/tags');
        if (status !== 200) { logError(`/api/tags HTTP ${status}`); return []; }
        const parsed = JSON.parse(body) as { models?: { name: string }[] };
        const names = parsed.models?.map((m) => m.name) ?? [];
        logInfo(`Models: ${names.join(', ') || '(none)'}`);
        _cachedModels = { names, timestamp: Date.now() };
        return names;
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        logError(`fetchModels: ${e.code ?? ''} ${e.message}`);
        return [];
    }
}

// ── Model info via /api/show ─────────────────────────────────────────────────

export interface OllamaModelInfo {
    contextLength: number | null;
    parameterSize: string | null;
    quantization: string | null;
    family: string | null;
}

/**
 * Fetch model metadata from Ollama's /api/show endpoint.
 * Returns the actual context window (num_ctx) and other model details.
 * Returns null if the request fails.
 */
export function fetchModelInfo(model: string): Promise<OllamaModelInfo | null> {
    return new Promise((resolve) => {
        const { hostname, port } = getEndpoint();
        const body = JSON.stringify({ name: model });

        const req = makeRequest(
            {
                hostname, port, path: '/api/show', method: 'POST',
                timeout: 5000,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    let e = '';
                    res.on('data', (c: Buffer) => (e += c.toString()));
                    res.on('end', () => {
                        logError(`/api/show HTTP ${res.statusCode}: ${e.slice(0, 200)}`);
                        resolve(null);
                    });
                    return;
                }

                let raw = '';
                res.on('data', (c: Buffer) => (raw += c.toString()));
                res.on('end', () => {
                    try {
                        const data = JSON.parse(raw);
                        // Extract context length from model_info or parameters.
                        // IMPORTANT: model_info[*].context_length is the architecture maximum,
                        // NOT the actual loaded num_ctx. A model tagged "65k" loads with
                        // num_ctx=65536 even though the architecture supports 262144.
                        // Always prefer the Modelfile num_ctx (what Ollama actually loaded)
                        // and treat model_info.context_length as an upper bound only.
                        let contextLength: number | null = null;
                        let archMaxLength: number | null = null;

                        // Method 1: parameters string — the actual loaded num_ctx from Modelfile
                        if (data.parameters) {
                            const match = String(data.parameters).match(/num_ctx\s+(\d+)/);
                            if (match) { contextLength = Number(match[1]); }
                        }

                        // Method 2: model_info architecture maximum (fallback if no num_ctx in Modelfile)
                        const modelInfo = data.model_info;
                        if (modelInfo) {
                            for (const key of Object.keys(modelInfo)) {
                                if (key.endsWith('.context_length')) {
                                    archMaxLength = Number(modelInfo[key]);
                                    break;
                                }
                            }
                        }

                        // Use num_ctx if present; fall back to arch max; never exceed arch max.
                        if (!contextLength && archMaxLength) {
                            contextLength = archMaxLength;
                        } else if (contextLength && archMaxLength) {
                            contextLength = Math.min(contextLength, archMaxLength);
                        }

                        // Extract other useful details
                        const details = data.details || {};

                        const info: OllamaModelInfo = {
                            contextLength,
                            parameterSize: details.parameter_size || null,
                            quantization: details.quantization_level || null,
                            family: details.family || null,
                        };

                        logInfo(`[model-info] ${model}: ctx=${info.contextLength ?? 'unknown'}, params=${info.parameterSize ?? '?'}, quant=${info.quantization ?? '?'}`);
                        resolve(info);
                    } catch (err) {
                        logError(`[model-info] Failed to parse /api/show response: ${toErrorMessage(err)}`);
                        resolve(null);
                    }
                });
            }
        );
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(body);
        req.end();
    });
}

