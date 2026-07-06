-- Agent module (docs/AGENT-MODULE-SPEC.md §2.6): conversation + message storage
-- for the in-app AI agent. Mirrors the schema.sql definitions.

CREATE TABLE IF NOT EXISTS AgentConversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_user
ON AgentConversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS AgentMessages (
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES AgentConversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  parts JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation
ON AgentMessages(conversation_id, created_at);
