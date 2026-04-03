import type {
  PublicDebateEntityUpdateNotification,
  PublicDebateEntityUpdatePublisher,
} from '../ports.js';

export const publishPublicDebateUpdateBestEffort = async (
  publisher: PublicDebateEntityUpdatePublisher | undefined,
  input: PublicDebateEntityUpdateNotification
): Promise<boolean> => {
  if (publisher === undefined) {
    return false;
  }

  try {
    const publishResult = await publisher.publish(input);
    return publishResult.isOk();
  } catch {
    return false;
  }
};
