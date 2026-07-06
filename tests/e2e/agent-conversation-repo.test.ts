import { randomUUID } from 'crypto';

import { describe, expect, it } from 'vitest';

import { makeAgentConversationRepo } from '@/modules/agent/shell/repo/conversation-repo.js';

import { dockerAvailable } from './setup.js';
import { getTestClients } from '../infra/test-db.js';

describe('Agent conversation repository', () => {
  it('round-trips UIMessage parts through the jsonb column', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const repo = makeAgentConversationRepo(userDb);
    const userId = `agent-user-${randomUUID()}`;
    const conversationId = randomUUID();

    const created = await repo.create(userId, conversationId);
    expect(created.isOk()).toBe(true);

    const parts = [
      { type: 'text', text: 'Cheltuieli educație 2024 — sumă 0.00 RON?' },
      {
        type: 'tool-search_entities',
        toolCallId: 'call_1',
        state: 'output-available',
        input: { query: 'Cluj', limit: 5 },
        output: { ok: true, kind: 'entity_list', items: [{ cui: '4305857' }] },
      },
    ];
    const appended = await repo.appendMessages(conversationId, [
      { id: 'msg-user-1', role: 'user', parts: [parts[0]] },
      { id: 'msg-assistant-1', role: 'assistant', parts },
    ]);
    expect(appended.isOk()).toBe(true);

    const messages = await repo.getMessages(conversationId);
    expect(messages.isOk()).toBe(true);
    if (messages.isOk()) {
      expect(messages.value).toEqual([
        { id: 'msg-user-1', role: 'user', parts: [parts[0]] },
        { id: 'msg-assistant-1', role: 'assistant', parts },
      ]);
    }
  });

  it('overwrites parts on message-id conflict instead of duplicating rows', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const repo = makeAgentConversationRepo(userDb);
    const userId = `agent-user-${randomUUID()}`;
    const conversationId = randomUUID();
    await repo.create(userId, conversationId);

    await repo.appendMessages(conversationId, [
      { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'draft' }] },
    ]);
    await repo.appendMessages(conversationId, [
      { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'final answer' }] },
    ]);

    const messages = await repo.getMessages(conversationId);
    expect(messages.isOk()).toBe(true);
    if (messages.isOk()) {
      expect(messages.value).toEqual([
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'final answer' }] },
      ]);
    }
  });

  it('does not leak conversations across users', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const repo = makeAgentConversationRepo(userDb);
    const ownerId = `agent-owner-${randomUUID()}`;
    const otherId = `agent-other-${randomUUID()}`;
    const conversationId = randomUUID();
    await repo.create(ownerId, conversationId);

    const foreignGet = await repo.getOwned(otherId, conversationId);
    expect(foreignGet.isErr()).toBe(true);
    if (foreignGet.isErr()) {
      expect(foreignGet.error.type).toBe('CONVERSATION_NOT_FOUND');
    }

    // Claiming an id owned by someone else reads as not-found, not a 500.
    const foreignCreate = await repo.create(otherId, conversationId);
    expect(foreignCreate.isErr()).toBe(true);
    if (foreignCreate.isErr()) {
      expect(foreignCreate.error.type).toBe('CONVERSATION_NOT_FOUND');
    }

    const foreignDelete = await repo.delete(otherId, conversationId);
    expect(foreignDelete.isOk()).toBe(true);
    if (foreignDelete.isOk()) {
      expect(foreignDelete.value).toBe(false);
    }

    const stillThere = await repo.getOwned(ownerId, conversationId);
    expect(stillThere.isOk()).toBe(true);
  });

  it('lists only the requesting user conversations, newest first, and sets titles', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const repo = makeAgentConversationRepo(userDb);
    const userId = `agent-list-${randomUUID()}`;
    const firstId = randomUUID();
    const secondId = randomUUID();
    await repo.create(userId, firstId);
    await repo.create(userId, secondId);
    await repo.setTitle(secondId, 'Bugetul Clujului');
    await repo.create(`agent-stranger-${randomUUID()}`, randomUUID());

    const listed = await repo.list(userId, 10);
    expect(listed.isOk()).toBe(true);
    if (listed.isOk()) {
      expect(listed.value.map((c) => c.id)).toEqual([secondId, firstId]);
      expect(listed.value[0]?.title).toBe('Bugetul Clujului');
      expect(listed.value[0]?.createdAt).toBeInstanceOf(Date);
    }
  });
});
