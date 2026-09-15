import { strict as assert } from 'assert';
import { formatMapAsText, formatMapAsMermaid } from '../../systemMap';
import type { SystemNode, SystemEdge } from '../../systemMap';

function node(overrides: Partial<SystemNode> = {}): SystemNode {
    return {
        id: 'test-node',
        type: 'service',
        label: 'Test Service',
        description: 'A test service',
        metadata: { host: '192.168.0.29', port: '8080' },
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

function edge(overrides: Partial<SystemEdge> = {}): SystemEdge {
    return {
        id: 'a-calls-b',
        from: 'a',
        to: 'b',
        type: 'calls',
        description: 'A calls B',
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

describe('systemMap.formatMapAsText', () => {

    it('returns empty message when no nodes', () => {
        const out = formatMapAsText({ nodes: [], edges: [] });
        assert.ok(out.includes('system map is empty'));
    });

    it('groups nodes by type with capitalized header', () => {
        const out = formatMapAsText({
            nodes: [node({ id: 's1', type: 'service', label: 'API' })],
            edges: [],
        });
        assert.ok(out.includes('### Services'));
        assert.ok(out.includes('**API**'));
    });

    it('includes metadata key-value pairs', () => {
        const out = formatMapAsText({
            nodes: [node({ metadata: { host: '10.0.0.1', port: '5432' } })],
            edges: [],
        });
        assert.ok(out.includes('host: 10.0.0.1'));
        assert.ok(out.includes('port: 5432'));
    });

    it('renders edges with node labels', () => {
        const out = formatMapAsText({
            nodes: [
                node({ id: 'a', label: 'App' }),
                node({ id: 'b', label: 'DB' }),
            ],
            edges: [edge({ from: 'a', to: 'b', type: 'writes_to', description: 'stores data' })],
        });
        assert.ok(out.includes('### Relationships'));
        assert.ok(out.includes('**App**'));
        assert.ok(out.includes('[writes_to]'));
        assert.ok(out.includes('**DB**'));
        assert.ok(out.includes('stores data'));
    });

    it('falls back to raw id when node not found in edges', () => {
        const out = formatMapAsText({
            nodes: [node({ id: 'a', label: 'App' })],
            edges: [edge({ from: 'a', to: 'ghost', description: 'orphan edge' })],
        });
        assert.ok(out.includes('**ghost**'));
    });

    it('handles multiple node types', () => {
        const out = formatMapAsText({
            nodes: [
                node({ id: 'm1', type: 'machine', label: 'Server' }),
                node({ id: 'd1', type: 'database', label: 'Postgres' }),
                node({ id: 'w1', type: 'workspace', label: 'My Project' }),
            ],
            edges: [],
        });
        assert.ok(out.includes('### Machines'));
        assert.ok(out.includes('### Databases'));
        assert.ok(out.includes('### Workspaces'));
    });
});

describe('systemMap.formatMapAsMermaid', () => {

    it('returns empty graph when no nodes', () => {
        const out = formatMapAsMermaid({ nodes: [], edges: [] });
        assert.ok(out.includes('graph LR'));
        assert.ok(out.includes('no nodes'));
    });

    it('renders service nodes with square brackets', () => {
        const out = formatMapAsMermaid({
            nodes: [node({ id: 'svc1', label: 'My Service' })],
            edges: [],
        });
        assert.ok(out.includes('graph LR'));
        assert.ok(out.includes('svc1["My Service"]'));
    });

    it('renders machine nodes with rounded brackets', () => {
        const out = formatMapAsMermaid({
            nodes: [node({ id: 'm1', type: 'machine', label: 'Host' })],
            edges: [],
        });
        assert.ok(out.includes('m1[("Host")]'));
    });

    it('renders workspace nodes with curly brackets', () => {
        const out = formatMapAsMermaid({
            nodes: [node({ id: 'w1', type: 'workspace', label: 'Project' })],
            edges: [],
        });
        assert.ok(out.includes('w1{{"Project"}}'));
    });

    it('renders edges with type labels', () => {
        const out = formatMapAsMermaid({
            nodes: [
                node({ id: 'a', label: 'A' }),
                node({ id: 'b', label: 'B' }),
            ],
            edges: [edge({ from: 'a', to: 'b', type: 'calls' })],
        });
        assert.ok(out.includes('a -->|calls| b'));
    });

    it('sanitizes node ids with special characters', () => {
        const out = formatMapAsMermaid({
            nodes: [node({ id: 'my-node.v2', label: 'Safe' })],
            edges: [],
        });
        assert.ok(out.includes('my_node_v2'));
        assert.ok(!out.includes('my-node.v2'));
    });

    it('escapes double quotes in labels', () => {
        const out = formatMapAsMermaid({
            nodes: [node({ id: 'q1', label: 'Say "hello"' })],
            edges: [],
        });
        assert.ok(out.includes("'hello'"));
        assert.ok(!out.includes('"hello"'));
    });
});
