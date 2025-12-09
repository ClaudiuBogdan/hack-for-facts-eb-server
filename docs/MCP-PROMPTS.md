# MCP Prompts - Analysis Workflow Templates

## Overview

The MCP module includes 5 pre-built prompt templates that guide AI assistants through comprehensive budget analysis workflows. Each prompt provides structured, step-by-step instructions for common investigation scenarios.

## Available Prompts

### 1. Entity Health Check (`entity-health-check`)

**Purpose:** Comprehensive financial health assessment of a public entity.

**Arguments:**

- `cui` (string): Entity fiscal code
- `year` (string): Year to analyze (e.g., "2023")

**Workflow:**

1. Get entity basic information
2. Analyze annual budget execution
3. Break down by functional classification
4. Break down by economic classification
5. Compare with similar entities (peer comparison)
6. Verify monthly evolution for anomalies

**Output:** Health report with:

- Executive summary (🟢 Healthy / 🟡 Attention / 🔴 Problematic)
- Key indicators (budget, payments, execution rate, arrears)
- Expense distribution (top functional/economic chapters)
- Identified anomalies with severity
- Actionable recommendations

**Use Case:** Quick assessment of entity financial performance and identification of issues.

---

### 2. Peer Comparison (`peer-comparison`)

**Purpose:** Compare budget execution of an entity against similar peers to identify performance gaps.

**Arguments:**

- `cui` (string): Target entity fiscal code
- `year` (string): Year to analyze
- `peerCuis` (string[]): List of peer entity CUIs (1-10 entities)

**Workflow:**

1. Get data for target entity
2. Get data for each peer entity
3. Statistical analysis (mean, median, standard deviation, percentiles)
4. Compare by functional classification
5. Compare by economic classification
6. Identify best practices from top performers

**Output:** Comparative report with:

- Positioning (e.g., "3 out of 6 entities")
- Comparative table (budget, payments, execution rate)
- Gap analysis (where target lags/excels)
- Best practices identified from peers
- Actionable recommendations

**Use Case:** Benchmarking entity performance against similar institutions.

---

### 3. Outlier Detection (`outlier-detection`)

**Purpose:** Detect entities with unusual budget execution patterns for a specific classification code.

**Arguments:**

- `classificationCode` (string): Functional or economic classification code
- `year` (string): Year to analyze
- `uatId` (number, optional): Filter by UAT (county/locality)

**Workflow:**

1. Get aggregated execution for classification code
2. Calculate descriptive statistics (mean, std dev, median, IQR)
3. Identify statistical outliers (Z-score and IQR methods)
4. Analyze top outliers (context, entity type, UAT size)
5. Verify suspicious temporal patterns (monthly evolution)
6. Compare with previous year (consistency check)

**Output:** Outlier report with:

- Group statistics (total budget, mean, std dev, median)
- Top 10 outliers table (ranked by Z-score)
- Outliers with suspicious patterns (🔴 high priority)
- Justified outliers (valid context, e.g., large hospital)
- Investigation recommendations

**Use Case:** Fraud detection, anomaly identification, data quality verification.

---

### 4. Trend Tracking (`trend-tracking`)

**Purpose:** Track budget execution trends for an entity over multiple years.

**Arguments:**

- `cui` (string): Entity fiscal code
- `startYear` (string): Start year (e.g., "2020")
- `endYear` (string): End year (e.g., "2023")
- `focusArea` (string, optional): Specific classification code to focus on

**Workflow:**

1. Get entity basic information
2. Get execution for each year in range
3. Calculate trend indicators (annual growth, CAGR, volatility)
4. Analyze trends by functional classification
5. Analyze trends by economic classification
6. Identify events and anomalies (sudden changes)
7. Compare with national/regional trends

**Output:** Trend report with:

- Executive summary (📈 Growth / 📉 Decline / ➡️ Stability)
- Key indicators evolution table (budget, payments, execution rate)
- Trend graphs (described)
- Priority changes (top growing/declining chapters)
- Events and anomalies identified (with context)
- Predictions and recommendations

**Use Case:** Multi-year performance tracking, identifying long-term trends.

---

### 5. Deep-Dive Investigation (`deep-dive-investigation`)

**Purpose:** Comprehensive, multi-level investigation of an entity with drill-down analysis.

**Arguments:**

- `cui` (string): Entity fiscal code
- `year` (string): Year to investigate
- `classificationCode` (string, optional): Specific classification code to investigate

**Workflow:**

1. **Level 1:** General overview (entity profile, annual execution)
2. **Level 2:** Distribution by classifications (functional, economic)
3. **Level 3:** Drill-down on specific codes (focus area or problematic codes)
4. **Level 4:** Temporal evolution (monthly, quarterly)
5. **Level 5:** Comparative context (similar entities, multi-year trends)

**Output:** Comprehensive report with:

- Executive summary (1 page)
- Entity profile and context
- General budget execution analysis
- Distribution by classifications
- Detailed code-specific analysis
- Temporal evolution (monthly/quarterly patterns)
- Peer comparison
- Findings and recommendations (strengths, weaknesses, risks)
- Appendices (shareable links, detailed tables)

**Use Case:** In-depth investigation for audits, investigative journalism, detailed analysis.

---

## Usage in MCP Clients

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "transparenta": {
      "command": "node",
      "args": ["/path/to/transparenta-eu-server/dist/mcp-server.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "CLIENT_BASE_URL": "https://transparenta.eu"
      }
    }
  }
}
```

### Invoking Prompts

In Claude Desktop, use the prompt picker or type:

```
Use the entity-health-check prompt for CUI 12345678, year 2023
```

Claude will receive the full structured prompt with step-by-step instructions.

---

## Prompt Design Principles

### 1. **Structured Workflow**

Each prompt provides a clear, numbered sequence of steps with specific tool calls.

### 2. **Tool Call Examples**

Every step includes exact tool invocation syntax with parameter examples.

### 3. **Analysis Guidance**

Prompts explain what to calculate, what to look for, and how to interpret results.

### 4. **Output Format**

Detailed output format specification ensures consistent, professional reports.

### 5. **Context Awareness**

Prompts remind the AI to contextualize findings (entity type, UAT size, economic conditions).

### 6. **Actionable Recommendations**

All prompts conclude with specific, prioritized recommendations.

---

## Technical Implementation

### File Structure

```
src/modules/mcp/shell/prompts/
└── prompt-templates.ts    # All 5 prompt templates
```

### Schema Validation

Each prompt has a Zod schema for argument validation:

```typescript
export const EntityHealthCheckArgsSchema = z.object({
  cui: z.string().describe('CUI (fiscal code) of the entity to analyze'),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .describe('Year to analyze (e.g., "2023")'),
});
```

### Registration

Prompts are registered in `mcp-server.ts`:

```typescript
for (const prompt of ALL_PROMPTS) {
  server.registerPrompt(
    prompt.name,
    {
      description: prompt.description,
      argsSchema: prompt.arguments.shape,
    },
    (args: Record<string, unknown>) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: prompt.template(args as never),
          },
        },
      ],
    })
  );
}
```

---

## Language and Formatting

### Language

- **Prompt instructions:** Romanian (matches data language)
- **Number format:** International (1,234,567.89 RON)
- **Output:** Romanian with structured formatting

### Number Formatting

- Monetary amounts: `5,234,567.89 RON` (comma thousands, dot decimal)
- Compact format: `5.23M RON`
- Percentages: `85.67%` (2 decimals)

### Severity Indicators

- 🟢 Green: Healthy / Normal / Good
- 🟡 Yellow: Attention / Moderate / Warning
- 🔴 Red: Problematic / Critical / High Priority

---

## Best Practices

### For AI Assistants

1. **Follow the workflow sequentially** - Each step builds on previous results
2. **Use exact tool syntax** - Copy parameter structures from prompt
3. **Contextualize findings** - Consider entity type, size, region
4. **Verify data quality** - Check for anomalies before drawing conclusions
5. **Provide actionable recommendations** - Specific, prioritized actions

### For Developers

1. **Keep prompts updated** - Sync with tool changes
2. **Test with real data** - Verify workflows produce useful results
3. **Add examples** - Include sample outputs in documentation
4. **Version prompts** - Track changes for reproducibility

---

## Future Enhancements

### Planned Additions

1. **Budget Planning Prompt** - Compare planned vs. executed budgets
2. **Investment Analysis Prompt** - Track capital expenditure projects
3. **Revenue Analysis Prompt** - Analyze income sources and trends
4. **Cross-Entity Comparison Prompt** - Compare multiple entities simultaneously
5. **Seasonal Pattern Detection Prompt** - Identify recurring patterns

### Customization

Prompts can be customized by:

- Modifying templates in `prompt-templates.ts`
- Adding new prompts to `ALL_PROMPTS` array
- Extending argument schemas with additional filters

---

## Related Documentation

- [MCP Module Specification](./MCP-MODULE-SPEC.md) - Full module architecture
- [Tool Descriptions](../src/modules/mcp/shell/server/tool-descriptions.ts) - Detailed tool documentation
- [Resources](../src/modules/mcp/shell/resources/) - Classification guides and glossaries

---

## Support

For issues or questions:

- GitHub Issues: [transparenta-eu/transparenta-eu-server](https://github.com/transparenta-eu/transparenta-eu-server)
- Documentation: [docs/](../docs/)
