import { type Plugin } from '@opencode-ai/plugin';

/**
 * Notification Plugin
 *
 * Plays sound notifications and shows desktop alerts when:
 * - Session becomes idle (agent finished, awaiting input)
 * - Permission/confirmation is needed
 * - Errors occur
 *
 * @see https://opencode.ai/docs/plugins/
 */
export const NotificationPlugin: Plugin = async ({ $ }) => {
  // Track the last message for summary extraction
  let lastMessage: { messageID: string | null; text: string | null } = {
    messageID: null,
    text: null,
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Sound Configuration (macOS)
  // ─────────────────────────────────────────────────────────────────────────────
  const sounds = {
    idle: '/System/Library/Sounds/Frog.aiff', // Task completed
    permission: '/System/Library/Sounds/Ping.aiff', // Input required
    error: '/System/Library/Sounds/Basso.aiff', // Error occurred
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper Functions
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Escapes a string for use in AppleScript
   */
  function escapeForAppleScript(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Extracts a summary from the message text
   */
  function extractSummary(text: string | null): string {
    if (!text) return 'Task completed';

    // Try to extract *Summary:* line if present
    const summaryMatch = text.match(/[_*]Summary:[_*]?\s*(.*)[\s*_]?$/im);
    if (summaryMatch?.[1]) {
      return summaryMatch[1].trim().slice(0, 100);
    }

    // Fall back to truncated text
    const cleaned = text.replace(/\n/g, ' ').trim();
    if (cleaned.length > 80) {
      return cleaned.slice(0, 77) + '...';
    }
    return cleaned || 'Task completed';
  }

  /**
   * Plays a sound file (macOS)
   */
  async function playSound(soundPath: string): Promise<void> {
    if (process.platform !== 'darwin') return;

    try {
      await $`afplay ${soundPath}`.quiet();
    } catch {
      // Ignore sound errors
    }
  }

  /**
   * Shows a desktop notification (macOS)
   */
  async function showNotification(title: string, message: string): Promise<void> {
    if (process.platform !== 'darwin') return;

    const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`;
    try {
      await $`osascript -e ${script}`.quiet();
    } catch {
      // Ignore notification errors
    }
  }

  /**
   * Plays sound and shows notification together
   */
  async function notify(
    soundType: keyof typeof sounds,
    title: string,
    message: string
  ): Promise<void> {
    await Promise.all([playSound(sounds[soundType]), showNotification(title, message)]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  return {
    event: async ({ event }) => {
      // Track last message for summary extraction
      if (event.type === 'message.part.updated') {
        const part = (
          event as { properties: { part: { type: string; messageID: string; text: string } } }
        ).properties.part;
        if (part.type === 'text') {
          lastMessage = { messageID: part.messageID, text: part.text };
        }
      }

      // Session idle - agent finished, waiting for user input
      if (event.type === 'session.idle') {
        const summary = extractSummary(lastMessage.text);
        await notify('idle', 'OpenCode', summary);
      }

      // Permission needed - user confirmation required
      if (event.type === 'permission.updated') {
        await notify('permission', 'OpenCode', 'User input required');
      }

      // Session error
      if (event.type === 'session.error') {
        const errorEvent = event as { properties?: { error?: string } };
        const errorMessage = errorEvent.properties?.error ?? 'An error occurred';
        await notify('error', 'OpenCode Error', errorMessage.slice(0, 100));
      }
    },
  };
};
