import { strict as assert } from 'assert';
import { formatReport } from '../../stackHealth';
import type { StackReport, ComponentStatus } from '../../stackHealth';

function makeComponent(overrides: Partial<ComponentStatus> = {}): ComponentStatus {
    return {
        name: 'ollama',
        status: 'ok',
        details: 'Running v0.5.0',
        issues: [],
        healActions: [],
        ...overrides,
    };
}

function makeReport(overrides: Partial<StackReport> = {}): StackReport {
    return {
        timestamp: Date.now(),
        sshHost: 'david@192.168.0.29',
        overallStatus: 'ok',
        components: [makeComponent()],
        ...overrides,
    };
}

describe('stackHealth.formatReport', () => {

    it('includes header with timestamp and host', () => {
        const report = makeReport();
        const out = formatReport(report);
        assert.ok(out.includes('# Stack Health Report'));
        assert.ok(out.includes('david@192.168.0.29'));
    });

    it('shows overall status with icon', () => {
        const report = makeReport({ overallStatus: 'degraded' });
        const out = formatReport(report);
        assert.ok(out.includes('⚠'));
        assert.ok(out.includes('DEGRADED'));
    });

    it('shows "ok" status with checkmark', () => {
        const report = makeReport({ overallStatus: 'ok' });
        const out = formatReport(report);
        assert.ok(out.includes('✓'));
        assert.ok(out.includes('OK'));
    });

    it('shows "down" status with X icon', () => {
        const report = makeReport({ overallStatus: 'down' });
        const out = formatReport(report);
        assert.ok(out.includes('✗'));
        assert.ok(out.includes('DOWN'));
    });

    it('shows "unknown" status with question mark', () => {
        const report = makeReport({ overallStatus: 'unknown' });
        const out = formatReport(report);
        assert.ok(out.includes('?'));
        assert.ok(out.includes('UNKNOWN'));
    });

    it('renders component name capitalized', () => {
        const report = makeReport({
            components: [makeComponent({ name: 'qdrant' })],
        });
        const out = formatReport(report);
        assert.ok(out.includes('## ✓ Qdrant'));
    });

    it('includes version when present', () => {
        const report = makeReport({
            components: [makeComponent({ version: '1.12.0' })],
        });
        const out = formatReport(report);
        assert.ok(out.includes('Version: 1.12.0'));
    });

    it('omits version line when not present', () => {
        const report = makeReport({
            components: [makeComponent({ version: undefined })],
        });
        const out = formatReport(report);
        assert.ok(!out.includes('Version:'));
    });

    it('lists issues when present', () => {
        const report = makeReport({
            components: [makeComponent({
                status: 'degraded',
                issues: ['Port 6333 not responding', 'Disk usage 95%'],
            })],
        });
        const out = formatReport(report);
        assert.ok(out.includes('**Issues:**'));
        assert.ok(out.includes('Port 6333 not responding'));
        assert.ok(out.includes('Disk usage 95%'));
    });

    it('omits issues section when empty', () => {
        const report = makeReport({
            components: [makeComponent({ issues: [] })],
        });
        const out = formatReport(report);
        assert.ok(!out.includes('**Issues:**'));
    });

    it('lists heal actions with destructive marker', () => {
        const report = makeReport({
            components: [makeComponent({
                status: 'down',
                healActions: [
                    { id: 'restart', label: 'Restart service', command: 'docker restart qdrant', destructive: false },
                    { id: 'recreate', label: 'Recreate container', command: 'docker rm -f qdrant && docker run qdrant', destructive: true },
                ],
            })],
        });
        const out = formatReport(report);
        assert.ok(out.includes('**Available fixes:**'));
        assert.ok(out.includes('Restart service'));
        assert.ok(out.includes('Recreate container'));
        assert.ok(out.includes('_(requires confirmation)_'));
        assert.ok(out.includes('docker restart qdrant'));
    });

    it('shows upgrade command when present', () => {
        const report = makeReport({
            components: [makeComponent({ upgradeCommand: 'ollama pull latest' })],
        });
        const out = formatReport(report);
        assert.ok(out.includes('**Upgrade command:**'));
        assert.ok(out.includes('ollama pull latest'));
    });

    it('handles multiple components', () => {
        const report = makeReport({
            components: [
                makeComponent({ name: 'ollama', status: 'ok' }),
                makeComponent({ name: 'qdrant', status: 'down' }),
                makeComponent({ name: 'searxng', status: 'degraded' }),
            ],
        });
        const out = formatReport(report);
        assert.ok(out.includes('## ✓ Ollama'));
        assert.ok(out.includes('## ✗ Qdrant'));
        assert.ok(out.includes('## ⚠ Searxng'));
    });

    it('handles empty components array', () => {
        const report = makeReport({ components: [] });
        const out = formatReport(report);
        assert.ok(out.includes('# Stack Health Report'));
    });
});
