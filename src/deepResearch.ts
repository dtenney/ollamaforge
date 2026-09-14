/**
 * deepResearch.ts — structured research pipeline
 *
 * Orchestrates: fan-out search → source fetch → claim extraction → cross-reference → cited synthesis.
 * Uses the same SearXNG + HTTP fetch patterns as agent.ts web_search/web_fetch tools.
 *
 * The agent calls this as a single tool: deep_research({ question, maxSources? })
 * Returns a structured markdown report with inline citations.
 */

import * as http from 'http';
import * as https from 'https';
import { getSearchConfig } from './config';
import { logInfo, logWarn } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    engine?: string;
}

interface FetchedSource {
    url: string;
    title: string;
    content: string; // cleaned text, capped
}

interface Claim {
    text: string;
    source: string; // URL
    confidence: 'confirmed' | 'single-source' | 'contradicted';
}

export interface DeepResearchResult {
    question: string;
    summary: string;
    claims: Claim[];
    sources: FetchedSource[];
    contradictions: string[];
    generatedAt: string;
}

// ── Config ────────────────────────────────────────────────────────────────────

interface ResearchConfig {
    maxSearches: number;       // parallel search queries to run
    maxSources: number;        // max pages to fetch
    maxContentChars: number;   // cap per fetched page
    searchTimeoutMs: number;
    fetchTimeoutMs: number;
}

const DEFAULTS: ResearchConfig = {
    maxSearches: 4,
    maxSources: 5,
    maxContentChars: 12000,
    searchTimeoutMs: 15000,
    fetchTimeoutMs: 20000,
};

// ── Query generation ──────────────────────────────────────────────────────────

/**
 * Generate diverse search angles for a research question.
 * Uses simple heuristics — no LLM call needed for query generation.
 */
function generateSearchQueries(question: string, maxQueries: number): string[] {
    const q = question.trim().replace(/\?+$/, '');
    const queries: string[] = [];

    // 1. Direct query
    queries.push(q);

    // 2. "best practices" / "how to" angle
    if (!/how|what|why|best/i.test(q)) {
        queries.push(`how ${q} best practices`);
    }

    // 3. Documentation angle
    queries.push(`${q} documentation`);

    // 4. Comparison / alternatives angle
    queries.push(`${q} vs alternatives comparison`);

    // 5. Recent / 2025/2026 angle
    queries.push(`${q} 2026`);

    // 6. Tutorial / guide angle
    queries.push(`${q} tutorial guide`);

    // 7. Issues / problems angle
    queries.push(`${q} common problems issues`);

    // 8. API / implementation angle
    queries.push(`${q} API implementation example`);

    return queries.slice(0, maxQueries);
}

// ── Search execution ──────────────────────────────────────────────────────────

async function executeSearch(query: string, cfg: ResearchConfig): Promise<SearchResult[]> {
    const searchCfg = getSearchConfig();
    if (!searchCfg.url) {
        throw new Error('No SearXNG URL configured');
    }

    const limit = 5;
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `${searchCfg.url}/search?q=${encodedQuery}&format=json`;

    return new Promise<SearchResult[]>((resolve) => {
        const parsed = new URL(searchUrl);
        const httpMod = parsed.protocol === 'https:' ? https : http;
        const reqOpts = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: { 'Accept': 'application/json', 'User-Agent': 'Ollama Forge/1.0' },
            timeout: cfg.searchTimeoutMs,
        };

        const req = httpMod.request(reqOpts, (res: any) => {
            let raw = '';
            res.on('data', (chunk: any) => { if (raw.length < 500_000) { raw += chunk; } });
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    const results: SearchResult[] = (data.results ?? []).slice(0, limit).map((r: any) => ({
                        title: r.title ?? '(no title)',
                        url: r.url ?? '',
                        snippet: (r.content ?? '').slice(0, 300),
                        engine: r.engine,
                    }));
                    resolve(results);
                } catch {
                    resolve([]);
                }
            });
        });

        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.end();
    });
}

// ── Fetch execution ───────────────────────────────────────────────────────────

async function fetchSource(url: string, cfg: ResearchConfig): Promise<FetchedSource | null> {
    if (!/^https?:\/\//i.test(url)) { return null; }

    // SSRF guard
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
            host === '169.254.169.254' || host.endsWith('.local')) {
            return null;
        }
    } catch { return null; }

    return new Promise<FetchedSource | null>((resolve) => {
        const parsed = new URL(url);
        const httpMod = parsed.protocol === 'https:' ? https : http;
        const reqOpts = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: { 'Accept': 'text/html,application/xhtml+xml,text/plain', 'User-Agent': 'Ollama Forge/1.0' },
            timeout: cfg.fetchTimeoutMs,
        };

        const req = httpMod.request(reqOpts, (res: any) => {
            if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                // Follow one redirect
                const redirectUrl = new URL(res.headers.location, url).toString();
                fetchSource(redirectUrl, cfg).then(resolve);
                return;
            }
            let raw = '';
            res.on('data', (chunk: any) => { if (raw.length < 200_000) { raw += chunk; } });
            res.on('end', () => {
                const content = htmlToText(raw).slice(0, cfg.maxContentChars);
                if (content.length < 50) { resolve(null); return; }
                const title = extractTitle(raw) || url;
                resolve({ url, title, content });
            });
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// ── HTML → text ───────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
    // Strip scripts, styles, nav, footer, header
    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<aside[\s\S]*?<\/aside>/gi, '')
        // Convert block elements to newlines
        .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
        // Strip remaining tags
        .replace(/<[^>]+>/g, ' ')
        // Decode common entities
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        // Collapse whitespace
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n/g, '\n')
        .trim();
    return text;
}

function extractTitle(html: string): string {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (match) {
        return match[1].replace(/<[^>]+>/g, '').trim().slice(0, 200);
    }
    return '';
}

// ── Claim extraction ──────────────────────────────────────────────────────────

/**
 * Extract key claims from fetched content.
 * Heuristic: sentences with specific facts (numbers, names, versions, dates).
 */
function extractClaims(source: FetchedSource): Claim[] {
    const claims: Claim[] = [];
    const sentences = source.content
        .split(/(?<=[.!?])\s+/)
        .filter(s => s.length > 40 && s.length < 400);

    // Prioritize sentences with concrete facts
    const factPattern = /\d+|version|release|support|require|must|should|cannot|does not|API|endpoint|parameter|config/i;

    for (const sentence of sentences) {
        if (factPattern.test(sentence)) {
            claims.push({
                text: sentence.trim(),
                source: source.url,
                confidence: 'single-source',
            });
            if (claims.length >= 8) break; // cap per source
        }
    }
    return claims;
}

// ── Cross-reference ───────────────────────────────────────────────────────────

function crossReference(claims: Claim[]): { claims: Claim[]; contradictions: string[] } {
    const contradictions: string[] = [];
    const seen = new Map<string, Claim>();

    for (const claim of claims) {
        // Normalize for dedup
        const key = claim.text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').slice(0, 80);
        if (seen.has(key)) {
            // Same claim from multiple sources → confirmed
            seen.get(key)!.confidence = 'confirmed';
        } else {
            seen.set(key, claim);
        }
    }

    // Detect contradictions: same topic, opposite assertions
    const confirmed = [...seen.values()].filter(c => c.confidence === 'confirmed');
    const single = [...seen.values()].filter(c => c.confidence === 'single-source');

    // Simple contradiction detection: "does not" vs "does", "cannot" vs "can"
    for (let i = 0; i < confirmed.length; i++) {
        for (let j = i + 1; j < confirmed.length; j++) {
            const a = confirmed[i].text.toLowerCase();
            const b = confirmed[j].text.toLowerCase();
            if ((a.includes('does not') && b.includes('does ') && !b.includes('does not')) ||
                (a.includes('cannot') && b.includes('can ') && !b.includes('cannot'))) {
                contradictions.push(`Contradiction: "${confirmed[i].text.slice(0, 100)}" vs "${confirmed[j].text.slice(0, 100)}"`);
            }
        }
    }

    return { claims: [...confirmed, ...single], contradictions };
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

function synthesize(question: string, claims: Claim[], sources: FetchedSource[], contradictions: string[]): string {
    let report = `# Research: ${question}\n\n`;
    report += `**Generated:** ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n`;
    report += `**Sources consulted:** ${sources.length}\n`;
    report += `**Claims extracted:** ${claims.length}\n\n`;

    if (contradictions.length > 0) {
        report += `## ⚠️ Contradictions Detected\n\n`;
        for (const c of contradictions) {
            report += `- ${c}\n`;
        }
        report += '\n';
    }

    report += `## Key Findings\n\n`;
    const confirmed = claims.filter(c => c.confidence === 'confirmed');
    const single = claims.filter(c => c.confidence === 'single-source');

    if (confirmed.length > 0) {
        report += `### Confirmed (multiple sources)\n\n`;
        for (const c of confirmed) {
            report += `- ${c.text} [${c.source}]\n`;
        }
        report += '\n';
    }

    if (single.length > 0) {
        report += `### Single-source claims\n\n`;
        for (const c of single) {
            report += `- ${c.text} [${c.source}]\n`;
        }
        report += '\n';
    }

    report += `## Sources\n\n`;
    sources.forEach((s, i) => {
        report += `${i + 1}. [${s.title}](${s.url})\n`;
    });

    return report;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Execute a deep research pipeline for a given question.
 * Returns a formatted markdown report with citations.
 */
export async function deepResearch(question: string, options?: { maxSources?: number }): Promise<string> {
    const cfg: ResearchConfig = {
        ...DEFAULTS,
        maxSources: options?.maxSources ?? DEFAULTS.maxSources,
    };

    logInfo(`[deepResearch] Starting research: "${question}"`);
    const startTime = Date.now();

    // Step 1: Generate diverse search queries
    const queries = generateSearchQueries(question, cfg.maxSearches);
    logInfo(`[deepResearch] ${queries.length} search angles: ${queries.map(q => `"${q}"`).join(', ')}`);

    // Step 2: Execute parallel searches
    const searchResults = await Promise.allSettled(
        queries.map(q => executeSearch(q, cfg))
    );

    const allResults: SearchResult[] = [];
    for (const result of searchResults) {
        if (result.status === 'fulfilled') {
            allResults.push(...result.value);
        }
    }

    // Deduplicate by URL
    const uniqueUrls = new Map<string, SearchResult>();
    for (const r of allResults) {
        if (r.url && !uniqueUrls.has(r.url)) {
            uniqueUrls.set(r.url, r);
        }
    }

    const topResults = [...uniqueUrls.values()].slice(0, cfg.maxSources);
    logInfo(`[deepResearch] ${allResults.length} raw results → ${topResults.length} unique sources selected`);

    if (topResults.length === 0) {
        return `# Research: ${question}\n\nNo results found. Try rephrasing the question or checking your SearXNG configuration.`;
    }

    // Step 3: Fetch top sources in parallel
    const fetchResults = await Promise.allSettled(
        topResults.map(r => fetchSource(r.url, cfg))
    );

    const sources: FetchedSource[] = [];
    for (const result of fetchResults) {
        if (result.status === 'fulfilled' && result.value) {
            sources.push(result.value);
        }
    }
    logInfo(`[deepResearch] Fetched ${sources.length}/${topResults.length} sources successfully`);

    if (sources.length === 0) {
        // Fall back to snippets from search results
        let report = `# Research: ${question}\n\n`;
        report += `**Note:** Could not fetch full pages. Showing search snippets only.\n\n`;
        report += `## Search Results\n\n`;
        topResults.forEach((r, i) => {
            report += `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}\n\n`;
        });
        return report;
    }

    // Step 4: Extract claims from each source
    const allClaims: Claim[] = [];
    for (const source of sources) {
        const claims = extractClaims(source);
        allClaims.push(...claims);
    }
    logInfo(`[deepResearch] Extracted ${allClaims.length} claims from ${sources.length} sources`);

    // Step 5: Cross-reference
    const { claims, contradictions } = crossReference(allClaims);

    // Step 6: Synthesize report
    const report = synthesize(question, claims, sources, contradictions);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logInfo(`[deepResearch] Complete in ${elapsed}s — ${claims.length} claims, ${contradictions.length} contradictions`);

    return report;
}
