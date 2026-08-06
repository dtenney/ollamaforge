# Ollama Forge Test Suite

Unit and integration tests for the Ollama Forge VS Code extension.

## Structure

```
src/test/
├── unit/                          # Mocha tests — no VS Code API required
│   ├── agent.test.ts              # Agent loop, tool parsing, prompt builder
│   ├── agentHarness.test.ts       # End-to-end agent harness tests
│   ├── chatExporter.test.ts       # Markdown/JSON export
│   ├── chatStorage.test.ts        # Session CRUD, sorting, ID generation
│   ├── codeActionsProvider.test.ts# Code action provider
│   ├── codeLensProvider.test.ts   # Code lens provider
│   ├── codeReview.test.ts         # Review request builder
│   ├── config.test.ts             # Configuration loading, presets, validation
│   ├── context.test.ts            # Workspace context builder
│   ├── contextCalculator.test.ts  # Token counting, context window management
│   ├── diffView.test.ts           # Diff view manager
│   ├── docScanner.test.ts         # Project doc ingestion
│   ├── e2e.test.ts                # End-to-end scenario tests
│   ├── gitContext.test.ts         # Git diff/blame context
│   ├── mcpClient.test.ts          # MCP server client (mocked)
│   ├── memoryCore.test.ts         # Memory tier system, promotion/demotion
│   ├── mentions.test.ts           # @-mention parsing
│   ├── multiWorkspace.test.ts     # Workspace isolation, context management
│   ├── ollamaClient.test.ts       # Ollama HTTP client (mocked)
│   ├── promptTemplates.test.ts    # Variable substitution, built-in templates
│   ├── provider.test.ts           # Webview message handler
│   ├── smartContext.test.ts       # Import parsing, file relevance scoring
│   ├── symbolProvider.test.ts     # Symbol indexing, fuzzy search, caching
│   └── workspace.test.ts          # Workspace utilities
└── integration/                   # vscode-test tests (require Extension Host)
    ├── extension.test.ts          # Extension activation, command registration
    └── index.ts                   # Test runner
```

## Running Tests

```bash
# Unit tests only (fast, no VS Code needed)
npm run test:unit

# Unit tests with coverage report
npm run test:coverage

# Full suite including integration tests (requires VS Code Extension Host)
npm test

# Agent harness tests (longer-running scenario tests)
npm run test:harness
```

## Test Framework

- **Mocha** — test runner
- **Sinon** — mocking and stubbing
- **@vscode/test-electron** — VS Code Extension Host for integration tests
- **nyc** — code coverage
- **Node assert** — assertions

## Writing Tests

### Unit Test Template

```typescript
import * as assert from 'assert';
import * as sinon from 'sinon';

describe('Module Name', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should do something', () => {
    assert.strictEqual(actual, expected);
  });
});
```

### Integration Test Template

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';

describe('Integration Test', () => {
  it('should activate the extension', async () => {
    const ext = vscode.extensions.getExtension('dtenney.ollamaforge');
    assert.ok(ext);
    await ext!.activate();
    assert.ok(ext!.isActive);
  });
});
```

## Notes

- Unit tests mock Ollama, Qdrant, and MCP servers — no live services required
- Integration tests require VS Code Extension Host (run via `npm test`)
- Webview UI is not covered by automated tests (no browser environment)
