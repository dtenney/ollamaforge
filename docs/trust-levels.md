# Trust Levels

Ollama Forge has three autonomy modes, selectable from the dropdown in the chat header.

---

## Normal (🔒 default)

- **Tool approvals**: Every file edit, write, and command requires a confirmation prompt.
- **Proceed questions**: The agent asks "Want me to proceed?" before multi-file plans.
- **Max retries**: 6 per run.
- **Turn limit**: Shows a "Keep going" button; user must click to continue.
- **Command tools** (`run_command`, `run_command_destructive`): Always require confirmation; not seeded into the approval set even if previously approved at a higher level.

---

## Trust (✅)

Auto-approves common editing tools; still blocks destructive commands.

| What changes from Normal |
|--------------------------|
| `edit_file`, `write_file`, `edit_file_at_line`, `run_command`, `run_command_pip` are auto-approved — no per-call confirmation prompt. |
| Multi-step plans execute end-to-end without "Want me to proceed?" pauses. |
| After each tool result the agent calls the next tool immediately — no summary between steps. |
| Max retries raised to **9**. |
| Turn limit auto-resumes ("Continuing…" spinner replaces the "Keep going" button). |
| `run_command_destructive` still requires confirmation. |
| Reading files outside the workspace (`shell_read_outside`, `read_file_outside`) still requires confirmation. |

**System prompt injection**: The agent is told to complete the full task without confirmation-seeking phrases ("Want me to proceed?", "Should I continue?"). It pauses only at genuinely ambiguous or destructive actions.

---

## YOLO (⚡)

Maximum autonomy — approve everything, work completely uninterrupted.

| What changes from Trust |
|--------------------------|
| `run_command_destructive` is also auto-approved. |
| `shell_read_outside` and `read_file_outside` (files outside the workspace) are also auto-approved. |
| Max retries raised to **12**. |
| System prompt is more aggressive: never pause between steps, never ask follow-up questions, treat every message as full authorization to complete the entire implied task end-to-end. |

---

## Switching modes

Changes take effect immediately — even for a run already in progress.

**Downgrading** (e.g. yolo → normal):
- `_trustedTools` is cleared completely.
- `run_command`, `run_command_pip`, `run_command_destructive` are stripped from the persistent approval set.
- Any tool that requires confirmation in Normal mode will prompt again on the next call.

**Upgrading** (e.g. normal → trust):
- Tool approvals are re-seeded for the new level.
- The system prompt injection changes on the next turn.

The selected level is persisted in VS Code workspace state and restored when the panel reopens.

---

## Summary table

| Feature                        | Normal | Trust | YOLO |
|-------------------------------|--------|-------|------|
| edit_file auto-approved       | No     | Yes   | Yes  |
| run_command auto-approved     | No     | Yes   | Yes  |
| run_command_destructive auto  | No     | No    | Yes  |
| Read outside workspace auto   | No     | No    | Yes  |
| Proceed question skipped      | No     | Yes   | Yes  |
| Max retries                   | 6      | 9     | 12   |
| Turn limit auto-resumes       | No     | Yes   | Yes  |
| System prompt — no follow-ups | No     | Yes   | Yes  |
| System prompt — fully autonomo| No     | No    | Yes  |
