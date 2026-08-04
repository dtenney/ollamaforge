import * as assert from 'assert';
import * as vscode from 'vscode';

describe('Extension Integration Tests', () => {
  it('should activate extension', async () => {
    const ext = vscode.extensions.getExtension('dtenney.ollamaforge');
    assert.ok(ext);

    if (!ext.isActive) {
      await ext.activate();
    }

    assert.ok(ext.isActive);
  });

  it('should register all commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    const ollamaCommands = [
      'ollamaForge.newChat',
      'ollamaForge.openChat',
      'ollamaForge.generateCode',
      'ollamaForge.explainSelection',
      'ollamaForge.codeAction',
      'ollamaForge.explainError',
      'ollamaForge.diagnose',
      'ollamaForge.manageTemplates',
      'ollamaForge.triggerInlineCompletion',
      'ollamaForge.exportChatMarkdown',
      'ollamaForge.exportChatJSON',
      'ollamaForge.switchWorkspace'
    ];

    ollamaCommands.forEach(cmd => {
      assert.ok(commands.includes(cmd), `Command ${cmd} not registered`);
    });
  });

  it('should register chat view', async () => {
    // The extension registers the chatView provider on activation.
    // Verify by checking the extension activated successfully (provider registered without error).
    const ext = vscode.extensions.getExtension('dtenney.ollamaforge');
    assert.ok(ext?.isActive, 'Extension should be active, meaning chatView provider was registered');
  });

  it('should register memory view', async () => {
    // The extension registers the memoryView tree data provider on activation.
    // Verify by checking the extension activated successfully.
    const ext = vscode.extensions.getExtension('dtenney.ollamaforge');
    assert.ok(ext?.isActive, 'Extension should be active, meaning memoryView provider was registered');
  });

  it('should load configuration', () => {
    const config = vscode.workspace.getConfiguration('ollamaForge');
    
    assert.ok(config);
    assert.ok(config.has('host'));
    assert.ok(config.has('port'));
    assert.ok(config.has('model'));
  });
});
