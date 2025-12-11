import { type Plugin, tool } from '@opencode-ai/plugin';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir, platform } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CANCELLED_MARKER = '[[CANCELLED]]';
const SKIPPED_MARKER = '[[SKIPPED]]';
const DELIMITER = '|||';
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Human-in-the-Loop (HITL) Plugin
 *
 * Provides a flexible tool for interactive user decisions via native macOS dialogs.
 * Supports choice selection with optional comments, confirmations, and text input.
 *
 * @see https://opencode.ai/docs/plugins/#custom-tools
 */
export const HITLPlugin: Plugin = async ({ $ }) => {
  // ─────────────────────────────────────────────────────────────────────────────
  // Platform Check
  // ─────────────────────────────────────────────────────────────────────────────

  if (platform() !== 'darwin') {
    throw new Error(
      'HITL plugin requires macOS (AppleScript dialogs are not available on other platforms)'
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper Functions
  // ─────────────────────────────────────────────────────────────────────────────

  function escapeForAppleScript(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  async function runAppleScript(script: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const tempFile = join(tmpdir(), `opencode-dialog-${randomUUID()}.scpt`);
    try {
      await writeFile(tempFile, script, 'utf-8');
      const result = await Promise.race([
        $`osascript ${tempFile}`.text(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Dialog timeout - no response received')), timeoutMs)
        ),
      ]);
      return result.trim();
    } finally {
      await unlink(tempFile).catch((e) => {
        console.warn('Dialog temp file cleanup failed:', e);
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Dialog Functions
  // ─────────────────────────────────────────────────────────────────────────────

  async function showChoiceDialog(
    title: string,
    question: string,
    options: string[],
    multiple: boolean
  ): Promise<{ status: string; selected?: string[]; error?: string }> {
    const optionList = options.map((o) => `"${escapeForAppleScript(o)}"`).join(', ');
    const multipleFlag = multiple
      ? 'with multiple selections allowed'
      : 'without multiple selections allowed';

    const script = `
set theOptions to {${optionList}}
set theChoices to choose from list theOptions with prompt "${escapeForAppleScript(question)}" with title "${escapeForAppleScript(title)}" default items {item 1 of theOptions} ${multipleFlag}
if theChoices is false then
  return "${CANCELLED_MARKER}"
else
  set AppleScript's text item delimiters to "${DELIMITER}"
  set theResult to theChoices as text
  set AppleScript's text item delimiters to ""
  return theResult
end if
`;

    try {
      const result = await runAppleScript(script);
      if (result === CANCELLED_MARKER) {
        return { status: 'cancelled' };
      }
      const selected = result.split(DELIMITER).filter((s) => s.length > 0);
      return { status: 'success', selected };
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async function showCommentDialog(
    title: string,
    selectedOptions: string[]
  ): Promise<{ status: string; comment?: string }> {
    const selectionSummary = selectedOptions.join(', ');

    const script = `
set theResult to display dialog "You selected: ${escapeForAppleScript(selectionSummary)}

Add any additional context or notes (optional):" with title "${escapeForAppleScript(title)}" default answer "" buttons {"Skip", "Add Comment"} default button "Add Comment"
if button returned of theResult is "Skip" then
  return "${SKIPPED_MARKER}"
else
  return text returned of theResult
end if
`;

    try {
      const result = await runAppleScript(script);
      if (result === SKIPPED_MARKER) {
        return { status: 'skipped', comment: '' };
      }
      return { status: 'success', comment: result };
    } catch {
      return { status: 'skipped', comment: '' };
    }
  }

  async function showConfirmDialog(
    title: string,
    message: string,
    confirmButton: string = 'Yes',
    cancelButton: string = 'No',
    icon: 'note' | 'caution' | 'stop' = 'note'
  ): Promise<{ status: string; confirmed?: boolean; error?: string }> {
    const iconMap = { stop: 0, note: 1, caution: 2 } as const;
    const iconNum = iconMap[icon];

    const script = `
set theResult to display dialog "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}" buttons {"${escapeForAppleScript(cancelButton)}", "${escapeForAppleScript(confirmButton)}"} default button 2 with icon ${iconNum}
return button returned of theResult
`;

    try {
      const result = await runAppleScript(script);
      return { status: 'success', confirmed: result === confirmButton };
    } catch {
      return { status: 'success', confirmed: false };
    }
  }

  async function showTextDialog(
    title: string,
    question: string,
    defaultValue: string = '',
    hidden: boolean = false
  ): Promise<{ status: string; text?: string; error?: string }> {
    const hiddenFlag = hidden ? 'with hidden answer' : '';

    const script = `
try
  set theResult to display dialog "${escapeForAppleScript(question)}" with title "${escapeForAppleScript(title)}" default answer "${escapeForAppleScript(defaultValue)}" buttons {"Skip", "OK"} default button "OK" cancel button "Skip" ${hiddenFlag}
  return text returned of theResult
on error number -128
  return "${CANCELLED_MARKER}"
end try
`;

    try {
      const result = await runAppleScript(script);
      if (result === CANCELLED_MARKER) {
        return { status: 'cancelled' };
      }
      return { status: 'success', text: result };
    } catch {
      return { status: 'cancelled' };
    }
  }

  async function showNotification(title: string, message: string): Promise<void> {
    const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`;
    try {
      await runAppleScript(script);
    } catch {
      // Ignore
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Definition
  // ─────────────────────────────────────────────────────────────────────────────

  return {
    tool: {
      ask_user: tool({
        description:
          'Show native dialogs to get user decisions. PREFER SIMPLE SINGLE-STEP CALLS.\n\n' +
          '## WHEN TO USE\n' +
          '- Ambiguous requirements needing clarification\n' +
          '- Multiple valid implementation approaches\n' +
          '- Destructive actions (deletions, overwrites, schema changes)\n' +
          '- External dependencies or breaking changes\n' +
          '- User preferences (naming, structure, patterns)\n\n' +
          '## WHEN NOT TO USE\n' +
          '- Clear requirements with obvious solution\n' +
          '- Following established project patterns\n' +
          '- Bug fixes with single correct approach\n' +
          '- Standard refactoring\n\n' +
          '## STEP TYPES\n' +
          '1. choice - Select from options (use allowComment:true for context)\n' +
          '2. confirm - Yes/No with icon:caution/stop for destructive actions\n' +
          '3. text - Free text input (use hidden:true for secrets)\n\n' +
          '## BEST PRACTICE\n' +
          'Single step with allowComment:true and "Other" option:\n' +
          '```\n' +
          '{ title: "Question", steps: [{\n' +
          '    id: "choice", type: "choice",\n' +
          '    question: "Which approach?",\n' +
          '    options: ["Option A", "Option B", "Other"],\n' +
          '    allowComment: true\n' +
          '}]}\n' +
          '```\n' +
          'Response: { answers: { choice: { selected: "Option A", comment: "..." } } }',
        args: {
          title: tool.schema.string(),
          steps: tool.schema.array(
            tool.schema.object({
              id: tool.schema.string(),
              type: tool.schema.enum(['choice', 'confirm', 'text']),
              question: tool.schema.string(),
              options: tool.schema.optional(tool.schema.array(tool.schema.string())),
              multiple: tool.schema.optional(tool.schema.boolean()),
              allowComment: tool.schema.optional(tool.schema.boolean()),
              defaultValue: tool.schema.optional(tool.schema.string()),
              hidden: tool.schema.optional(tool.schema.boolean()),
              confirmButton: tool.schema.optional(tool.schema.string()),
              cancelButton: tool.schema.optional(tool.schema.string()),
              icon: tool.schema.optional(tool.schema.enum(['note', 'caution', 'stop'])),
            })
          ),
        },
        async execute(args) {
          const { title, steps } = args;

          if (steps.length === 0) {
            return JSON.stringify({ status: 'error', message: 'At least one step is required' });
          }

          const answers: Record<string, unknown> = {};
          const isWizard = steps.length > 1;

          for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const stepTitle = isWizard ? `${title} (${i + 1}/${steps.length})` : title;

            if (step.type === 'choice') {
              if (!step.options || step.options.length === 0) {
                return JSON.stringify({
                  status: 'error',
                  message: `Step "${step.id}" requires options`,
                });
              }

              const result = await showChoiceDialog(
                stepTitle,
                step.question,
                step.options,
                step.multiple ?? false
              );

              if (result.status === 'cancelled') {
                return JSON.stringify({
                  status: 'cancelled',
                  completedSteps: i,
                  answers,
                  message: `Cancelled at: ${step.question}`,
                });
              }

              if (result.status === 'error' || !result.selected) {
                return JSON.stringify({
                  status: 'error',
                  message: result.error ?? 'No selection returned',
                });
              }

              const selected = step.multiple ? result.selected : result.selected[0];

              // If allowComment is true, show follow-up dialog for context
              if (step.allowComment) {
                const commentResult = await showCommentDialog(stepTitle, result.selected);
                answers[step.id] = {
                  selected,
                  comment: commentResult.comment ?? '',
                };
              } else {
                answers[step.id] = selected;
              }
            } else if (step.type === 'confirm') {
              const result = await showConfirmDialog(
                stepTitle,
                step.question,
                step.confirmButton ?? 'Yes',
                step.cancelButton ?? 'No',
                step.icon ?? 'note'
              );

              if (result.status === 'error') {
                return JSON.stringify({ status: 'error', message: result.error });
              }

              answers[step.id] = result.confirmed ?? false;
            } else if (step.type === 'text') {
              const result = await showTextDialog(
                stepTitle,
                step.question,
                step.defaultValue ?? '',
                step.hidden ?? false
              );

              if (result.status === 'cancelled') {
                return JSON.stringify({
                  status: 'cancelled',
                  completedSteps: i,
                  answers,
                  message: `Cancelled at: ${step.question}`,
                });
              }

              answers[step.id] = result.text!;
            }
          }

          if (isWizard) {
            await showNotification(title, 'Completed!');
          }

          return JSON.stringify({
            status: 'success',
            completedSteps: steps.length,
            answers,
          });
        },
      }),
    },
  };
};
