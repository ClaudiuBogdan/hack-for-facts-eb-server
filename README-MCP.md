# MCP Client Configuration

This directory contains configuration files for connecting MCP clients to the Hack for Facts AI Basic MCP server.

## Server Setup

1. **Start the server:**
   ```bash
   yarn start
   # Server runs on http://localhost:3000
   ```

2. **Optional Authentication:**
   ```bash
   # On the server
   export MCP_API_KEY="your-secret-key"
   ```

## Client Configurations

### Claude Desktop

1. Copy `.claude-mcp.json` to your home directory:
   ```bash
   cp .claude-mcp.json ~/.claude-mcp.json
   ```

2. Restart Claude Desktop

3. The server will appear as "Hack for Facts – AI Basic MCP" in your MCP servers list

### Cursor

1. Open Cursor Settings (Cmd/Ctrl + ,)

2. Go to "MCP" section in settings

3. Add a new MCP server with:
   - **Name:** Hack for Facts AI Basic
   - **Type:** HTTP SSE
   - **URL:** http://localhost:3000/mcp/sse
   - **Message URL:** http://localhost:3000/mcp/messages
   - **Auth Header:** x-api-key (optional)

Or use the JSON config format in `mcp-cursor-config.json`

### VS Code

1. Install an MCP extension (e.g., "MCP Client" or similar)

2. Configure the extension with:
   - **Server Type:** HTTP SSE
   - **SSE URL:** http://localhost:3000/mcp/sse
   - **Message URL:** http://localhost:3000/mcp/messages
   - **Auth Header:** x-api-key (if enabled)

### Generic MCP Clients

Use `mcp-client-config.json` as a template for other MCP-compatible tools.

## Available Tools

### getEntityDetails

Get high-level financial totals for a Romanian public entity.

**Parameters:**
- `entityCui` (optional): Exact CUI (fiscal identifier) - preferred if known
- `entitySearch` (optional): Free-text fuzzy search when CUI unknown
- `year` (required): Reporting year (2016-2100)

**Example Usage:**
```json
{
  "entityCui": "4305857",
  "year": 2024
}
```

**Response:** JSON matching `/ai/v1/entities/details` endpoint with totals, human-readable summaries, and deep links.

## Troubleshooting

1. **Connection Issues:**
   - Ensure server is running on localhost:3000
   - Check firewall settings
   - Verify MCP_API_KEY matches if auth is enabled

2. **Auth Issues:**
   - If auth is enabled, ensure client sends `x-api-key` header
   - Check server logs for authentication errors

3. **Tool Not Available:**
   - Verify server started successfully
   - Check `/mcp/definition` endpoint returns tool list
   - Ensure client supports HTTP SSE transport

## Development

To test the MCP server directly:

```bash
# Check if server is responding
curl http://localhost:3000/mcp/definition

# Test SSE connection
curl -N http://localhost:3000/mcp/sse
```
