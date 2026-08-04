/**
 * System Map — cross-workspace knowledge graph
 *
 * Stores a persistent graph of nodes (workspaces, services, machines) and edges
 * (relationships between them) at ~/.ollamaforge/system-map.json.
 *
 * Design goals:
 * - Lives OUTSIDE any single workspace — readable by the agent from any project
 * - Never auto-loaded into context — queried on demand to keep context cost low
 * - Append-only writes (upsert by id) — safe to call from any workspace
 * - Human-readable JSON — can be inspected / edited directly
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ──────────────────────────────────────────────────────────────────────

export type NodeType =
    | 'workspace'   // a local VS Code workspace / git repo
    | 'service'     // a running service (web server, API, daemon)
    | 'machine'     // a physical or virtual host
    | 'database'    // a database instance
    | 'other';

export type EdgeType =
    | 'calls'       // A calls/uses B over the network
    | 'deploys_to'  // A code is deployed to B
    | 'reads_from'  // A reads config or data from B
    | 'writes_to'   // A writes data to B
    | 'ssh_into'    // A connects to B via SSH
    | 'hosts'       // A (machine) hosts B (service/workspace)
    | 'depends_on'  // A depends on B at runtime
    | 'related';    // generic catch-all relationship

export interface SystemNode {
    id: string;             // unique stable identifier (e.g. "ollamaforge", "server-29")
    type: NodeType;
    label: string;          // human-readable name
    description: string;    // one-line summary
    /** Key facts: host, port, path, tech stack, etc. */
    metadata: Record<string, string>;
    updatedAt: string;      // ISO timestamp
}

export interface SystemEdge {
    id: string;             // "<from>-<type>-<to>"
    from: string;           // node id
    to: string;             // node id
    type: EdgeType;
    description: string;    // what this relationship means
    updatedAt: string;
}

export interface SystemMap {
    version: 1;
    updatedAt: string;
    nodes: SystemNode[];
    edges: SystemEdge[];
}

// ── Storage path ───────────────────────────────────────────────────────────────

const SYSTEM_MAP_DIR  = path.join(os.homedir(), '.ollamaforge');
const SYSTEM_MAP_PATH = path.join(SYSTEM_MAP_DIR, 'system-map.json');

function emptyMap(): SystemMap {
    return { version: 1, updatedAt: new Date().toISOString(), nodes: [], edges: [] };
}

function load(): SystemMap {
    try {
        const raw = fs.readFileSync(SYSTEM_MAP_PATH, 'utf8');
        const parsed = JSON.parse(raw) as SystemMap;
        // Basic schema guard
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
            return emptyMap();
        }
        return parsed;
    } catch (err: any) {
        // ENOENT = file doesn't exist yet — expected on first use
        if (err?.code !== 'ENOENT') {
            // Corrupt or unreadable — log and start fresh
            try { require('./logger').logWarn(`[system_map] Could not read system-map.json: ${err?.message}`); } catch { /* logger not available */ }
        }
    }
    return emptyMap();
}

function save(map: SystemMap): void {
    fs.mkdirSync(SYSTEM_MAP_DIR, { recursive: true });
    map.updatedAt = new Date().toISOString();
    const json = JSON.stringify(map, null, 2);
    // Write via temp file + rename for atomic cross-process safety.
    // Prevents a concurrent write from a second VS Code window corrupting the file.
    const tmp = SYSTEM_MAP_PATH + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, SYSTEM_MAP_PATH);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Upsert a node. If a node with the same id already exists, merges metadata
 * and updates label/description/type if provided.
 */
export function upsertNode(node: Omit<SystemNode, 'updatedAt'>): SystemMap {
    const map = load();
    const now = new Date().toISOString();
    const existing = map.nodes.find(n => n.id === node.id);
    if (existing) {
        existing.type        = node.type        || existing.type;
        existing.label       = node.label       || existing.label;
        existing.description = node.description || existing.description;
        existing.metadata    = { ...existing.metadata, ...node.metadata };
        existing.updatedAt   = now;
    } else {
        map.nodes.push({ ...node, updatedAt: now });
    }
    save(map);
    return map;
}

/**
 * Upsert an edge. Edge id is derived as "<from>-<type>-<to>" for stability.
 */
export function upsertEdge(edge: Omit<SystemEdge, 'id' | 'updatedAt'>): SystemMap {
    const map = load();
    const now = new Date().toISOString();
    const edgeId = `${edge.from}-${edge.type}-${edge.to}`;
    const existing = map.edges.find(e => e.id === edgeId);
    if (existing) {
        existing.description = edge.description || existing.description;
        existing.updatedAt   = now;
    } else {
        map.edges.push({ id: edgeId, ...edge, updatedAt: now });
    }
    save(map);
    return map;
}

/**
 * Query the map by node id, label substring, type, or relationship.
 * Returns a filtered subgraph — never the full map unless filter is empty.
 *
 * @param nodeId    exact node id match
 * @param search    substring match against id, label, description, or metadata values
 * @param type      filter by NodeType
 * @param related   return all nodes/edges connected to this node id
 */
export function queryMap(opts: {
    nodeId?:  string;
    search?:  string;
    type?:    NodeType;
    related?: string;
}): { nodes: SystemNode[]; edges: SystemEdge[] } {
    const map = load();

    let nodes = map.nodes;
    let edges = map.edges;

    if (opts.nodeId) {
        nodes = nodes.filter(n => n.id === opts.nodeId);
    }
    if (opts.type) {
        nodes = nodes.filter(n => n.type === opts.type);
    }
    if (opts.search) {
        const q = opts.search.toLowerCase();
        nodes = nodes.filter(n =>
            n.id.toLowerCase().includes(q) ||
            n.label.toLowerCase().includes(q) ||
            n.description.toLowerCase().includes(q) ||
            Object.values(n.metadata).some(v => v.toLowerCase().includes(q))
        );
    }
    if (opts.related) {
        const id = opts.related;
        // Find all edges touching this node in the FULL edge list (not pre-filtered edges,
        // which may have been narrowed by an earlier related pass — there is only one related
        // filter, so map.edges is correct here).
        const relatedEdges = map.edges.filter(e => e.from === id || e.to === id);
        const connectedIds = new Set<string>(relatedEdges.flatMap(e => [e.from, e.to]));
        // Ensure the pivot node itself is always included regardless of prior type/search filters,
        // then intersect the neighbour set with whatever prior filters produced.
        const pivotNode = map.nodes.find(n => n.id === id);
        const priorNodeIds = new Set(nodes.map(n => n.id));
        nodes = map.nodes.filter(n =>
            connectedIds.has(n.id) &&
            (n.id === id || priorNodeIds.has(n.id))   // neighbours must pass prior filters
        );
        if (pivotNode && !nodes.find(n => n.id === id)) {
            nodes = [pivotNode, ...nodes]; // always show the pivot even if it fails type/search
        }
        edges = relatedEdges;
    }

    // Restrict edges to those whose both endpoints survived all filters
    const nodeIds = new Set(nodes.map(n => n.id));
    edges = edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));

    return { nodes, edges };
}

/**
 * Return the full map as a human-readable text tree (for Mermaid or plain review).
 * Kept short enough to fit in context when needed.
 */
export function formatMapAsText(filter?: { nodes: SystemNode[]; edges: SystemEdge[] }): string {
    const { nodes, edges } = filter ?? load();
    if (nodes.length === 0) {
        return '(system map is empty — use system_map_update to add nodes)';
    }

    const lines: string[] = ['## System Map\n'];

    // Group nodes by type
    const byType = new Map<string, SystemNode[]>();
    for (const n of nodes) {
        const bucket = byType.get(n.type) ?? [];
        bucket.push(n);
        byType.set(n.type, bucket);
    }
    for (const [type, typeNodes] of byType) {
        lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
        for (const n of typeNodes) {
            lines.push(`- **${n.label}** (\`${n.id}\`): ${n.description}`);
            for (const [k, v] of Object.entries(n.metadata)) {
                lines.push(`  - ${k}: ${v}`);
            }
        }
        lines.push('');
    }

    if (edges.length > 0) {
        lines.push('### Relationships');
        for (const e of edges) {
            const fromNode = nodes.find(n => n.id === e.from);
            const toNode   = nodes.find(n => n.id === e.to);
            const fromLabel = fromNode?.label ?? e.from;
            const toLabel   = toNode?.label   ?? e.to;
            lines.push(`- **${fromLabel}** → [${e.type}] → **${toLabel}**: ${e.description}`);
        }
    }

    return lines.join('\n');
}

/** Sanitise a node id for use as a Mermaid node identifier (alphanumeric + underscore only). */
function mermaidId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Generate a Mermaid graph diagram string from the map (or a subgraph).
 */
export function formatMapAsMermaid(filter?: { nodes: SystemNode[]; edges: SystemEdge[] }): string {
    const { nodes, edges } = filter ?? load();
    if (nodes.length === 0) { return 'graph LR\n  empty["(no nodes)"]'; }

    const lines = ['graph LR'];
    // Node shapes by type — label uses quoted string so spaces/special chars are safe
    const shape = (n: SystemNode): string => {
        const mid   = mermaidId(n.id);
        const label = n.label.replace(/"/g, "'");
        switch (n.type) {
            case 'machine':   return `  ${mid}[("${label}")]`;
            case 'database':  return `  ${mid}[("${label}")]`;
            case 'service':   return `  ${mid}["${label}"]`;
            case 'workspace': return `  ${mid}{{"${label}"}}`;
            default:          return `  ${mid}["${label}"]`;
        }
    };
    for (const n of nodes) { lines.push(shape(n)); }
    for (const e of edges) {
        lines.push(`  ${mermaidId(e.from)} -->|${e.type}| ${mermaidId(e.to)}`);
    }
    return lines.join('\n');
}
