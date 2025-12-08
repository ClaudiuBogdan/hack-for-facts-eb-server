# OpenCode Configuration

> Configuration for [OpenCode](https://opencode.ai) AI coding assistant.
> Official docs: https://opencode.ai/docs

## Directory Structure

```
.opencode/
├── agent/                 # Standalone markdown agents (auto-loaded)
│   ├── api-designer.md
│   ├── database.md
│   ├── devops.md
│   └── performance.md
├── plugin/                # Plugins for extending OpenCode
│   └── env-protection.js  # Blocks access to .env files
├── prompts/               # Prompt files referenced by opencode.jsonc
│   ├── build.md
│   ├── plan.md
│   ├── architect.md
│   └── ... (9 files)
├── AGENTS.md              # Project context for all agents
├── opencode.jsonc         # Main configuration
└── README.md              # This file
```

## Quick Start

| Task            | How                                |
| --------------- | ---------------------------------- |
| Switch agents   | Press `Tab`                        |
| Run command     | Type `/test`, `/lint`, `/ci`, etc. |
| Invoke subagent | Type `@database help with query`   |
| Switch model    | Type `/models`                     |

## Deep vs Fast Mode

Press `Tab` to cycle through agents with different reasoning modes:

```
build → build-fast → build-max → build-ultra-fast → plan → plan-fast → architect
  │         │            │              │             │         │           │
  └─ deep   └─ fast      └─ max         └─ ultra      └─ deep   └─ fast     └─ deep
```

### Model Aliases

| Alias         | Extended Thinking | Best For                               |
| ------------- | ----------------- | -------------------------------------- |
| `opus-max`    | 128K tokens       | Hardest problems, complex architecture |
| `opus-deep`   | 64K tokens        | Complex tasks, debugging               |
| `opus-fast`   | None              | Quick iterations, simple changes       |
| `sonnet`      | 32K tokens        | Fast exploration                       |
| `sonnet-fast` | None              | Ultra-fast iterations (cheapest)       |

> Docs: https://opencode.ai/docs/models

## Agents

### Primary Agents (Tab to switch)

| Agent              | Model       | Description                                |
| ------------------ | ----------- | ------------------------------------------ |
| `build`            | opus-deep   | Full development with extended thinking    |
| `build-fast`       | opus-fast   | Quick iterations without extended thinking |
| `build-max`        | opus-max    | Maximum reasoning (128K thinking tokens)   |
| `build-ultra-fast` | sonnet-fast | Ultra-fast iterations (Sonnet, cheapest)   |
| `plan`             | opus-deep   | Analysis and planning (read-only)          |
| `plan-fast`        | opus-fast   | Quick planning                             |
| `architect`        | opus-deep   | System design decisions                    |

### Subagents (@mention to invoke)

| Agent           | Description                   |
| --------------- | ----------------------------- |
| `@explore`      | Fast codebase exploration     |
| `@reviewer`     | Code review                   |
| `@debug`        | Investigation and diagnostics |
| `@refactor`     | Code improvement              |
| `@docs`         | Documentation writing         |
| `@test`         | Test creation                 |
| `@security`     | Security audit                |
| `@database`     | PostgreSQL/Kysely expertise   |
| `@api-designer` | GraphQL/API design            |
| `@performance`  | Performance optimization      |
| `@devops`       | CI/CD and deployment          |

> Docs: https://opencode.ai/docs/agents

## Creating Agents

### Method 1: Markdown File (Recommended for subagents)

Create `.opencode/agent/my-agent.md`:

```markdown
---
description: Brief description shown in TUI
mode: subagent
model: anthropic/opus-deep
temperature: 0.1
maxSteps: 30
tools:
  read: true
  write: false
  bash: true
permission:
  bash:
    'safe-command *': allow
    '*': ask
---

Your system prompt with project-specific context...
```

### Method 2: JSON Config (Recommended for primary agents)

Add to `opencode.jsonc` under `"agent"`:

```jsonc
"my-agent": {
  "description": "Description for TUI",
  "mode": "primary",
  "model": "anthropic/opus-deep",
  "temperature": 0.1,
  "maxSteps": 50,
  "prompt": "{file:.opencode/prompts/my-agent.md}",
  "tools": { "read": true, "write": true, "bash": true },
  "permission": { "edit": "allow" }
}
```

Then create `.opencode/prompts/my-agent.md` with the system prompt.

### Agent Options

| Option        | Type                        | Description                              |
| ------------- | --------------------------- | ---------------------------------------- |
| `description` | string                      | **Required.** Shown in TUI               |
| `mode`        | `"primary"` \| `"subagent"` | Primary = Tab cycle, Subagent = @mention |
| `model`       | string                      | Model alias or full ID                   |
| `temperature` | number                      | 0.0-1.0 (lower = deterministic)          |
| `maxSteps`    | number                      | Max agentic iterations                   |
| `prompt`      | string                      | System prompt or `{file:path}`           |
| `tools`       | object                      | Enable/disable tools                     |
| `permission`  | object                      | Override global permissions              |

> Docs: https://opencode.ai/docs/agents

## Custom Commands

Commands are defined in `opencode.jsonc` under `"command"`:

```jsonc
"my-command": {
  "template": "Your prompt here with $ARGUMENTS",
  "description": "Shown in TUI",
  "agent": "build"  // Optional: which agent runs it
}
```

### Template Syntax

| Syntax           | Description                     |
| ---------------- | ------------------------------- |
| `$ARGUMENTS`     | All arguments passed to command |
| `$1`, `$2`, ...  | Individual positional arguments |
| `` !`command` `` | Inject shell output into prompt |
| `@path/to/file`  | Include file contents           |

> Docs: https://opencode.ai/docs/commands

## Permissions

Three permission levels: `"allow"` | `"ask"` | `"deny"`

### Bash Permissions (glob patterns)

```jsonc
"permission": {
  "bash": {
    "git status": "allow",      // Exact match
    "git diff*": "allow",       // Wildcard
    "rm *": "ask",              // Require confirmation
    "sudo *": "deny",           // Block entirely
    "*": "ask"                  // Default for unmatched
  }
}
```

> Docs: https://opencode.ai/docs/permissions

## Model Configuration

### Adding a Model Alias

In `opencode.jsonc` under `provider.anthropic.models`:

```jsonc
"my-alias": {
  "id": "claude-opus-4-5-20251101",  // Base model
  "options": {
    "reasoningEffort": "high",
    "thinking": {
      "type": "enabled",
      "budgetTokens": 64000
    }
  }
}
```

Then use as `"model": "anthropic/my-alias"` in agents.

> Docs: https://opencode.ai/docs/models

## MCP Servers

External tools via Model Context Protocol.

```jsonc
"mcp": {
  "server-name": {
    "type": "remote",  // or "local"
    "url": "https://example.com/mcp",
    "enabled": true
  }
}
```

> Docs: https://opencode.ai/docs/mcp-servers

## Common Tasks

| Task                   | Action                                       |
| ---------------------- | -------------------------------------------- |
| Add new subagent       | Create `.opencode/agent/name.md`             |
| Add primary agent      | Add to `opencode.jsonc` + create prompt file |
| Change thinking budget | Edit `budgetTokens` in model alias           |
| Add bash permission    | Add pattern to `permission.bash`             |
| Add custom command     | Add to `command` in `opencode.jsonc`         |
| Modify agent prompt    | Edit file in `.opencode/prompts/`            |

## Files Reference

| File                       | Purpose                                             |
| -------------------------- | --------------------------------------------------- |
| `opencode.jsonc`           | Main config (models, agents, permissions, commands) |
| `AGENTS.md`                | Project context loaded for all agents               |
| `prompts/*.md`             | System prompts referenced by agents in config       |
| `agent/*.md`               | Standalone agent definitions (auto-loaded)          |
| `plugin/env-protection.js` | Security plugin to block .env file access           |

## Security

### .env File Protection

The `plugin/env-protection.js` plugin prevents OpenCode from reading `.env` files:

- Blocks `read` tool from accessing any file with `.env` in the path
- Blocks bash commands like `cat .env`, `head .env`, etc.
- Throws descriptive error directing to `.env.example` instead

> Docs: https://opencode.ai/docs/plugins/#env-protection

---

**Official Documentation:** https://opencode.ai/docs
