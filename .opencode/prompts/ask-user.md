# Using ask_user for Decisions

Use `ask_user` to get user input when there's genuine ambiguity. **Don't ask when the answer is obvious.**

## When to Ask

| Scenario                        | Example                                                 |
| ------------------------------- | ------------------------------------------------------- |
| **Multiple valid approaches**   | "Normalize in SQL vs application layer?"                |
| **Naming/structure preference** | "Name this: `getAnalytics` vs `fetchAnalyticsData`?"    |
| **Destructive actions**         | "Delete 3 unused files?" (use `confirm` with `caution`) |
| **Missing requirements**        | "Should pagination default to 20 or 50 items?"          |
| **Breaking changes**            | "This changes the API response shape. Proceed?"         |
| **External dependencies**       | "Add lodash for this, or implement manually?"           |
| **Ambiguous scope**             | "Should I also update the related tests?"               |

## When NOT to Ask

- Clear requirements with single correct solution
- Following established project patterns (check existing code first!)
- Bug fixes with obvious fix
- Standard refactoring that preserves behavior
- Trivial decisions (file placement following conventions)
- Information you can find by reading code or docs

## Pattern: Single Step with Comment (Recommended)

```typescript
ask_user({
  title: 'Implementation Choice',
  steps: [
    {
      id: 'approach',
      type: 'choice',
      question: 'How should I handle the date normalization?',
      options: [
        'SQL-level (EXTRACT in query)',
        'Application-level (in usecase)',
        'Other', // Always include!
      ],
      allowComment: true, // User can explain their choice
    },
  ],
});
```

## Pattern: Destructive Action Confirmation

```typescript
ask_user({
  title: 'Confirm Deletion',
  steps: [
    {
      id: 'confirm',
      type: 'confirm',
      question: 'Delete deprecated-utils.ts and migrate 3 usages?',
      icon: 'caution', // or 'stop' for critical actions
      confirmButton: 'Delete',
      cancelButton: 'Keep',
    },
  ],
});
```

## Pattern: Text Input for Custom Values

```typescript
ask_user({
  title: 'Configuration',
  steps: [
    {
      id: 'name',
      type: 'text',
      question: 'What should the new module be named?',
      defaultValue: 'analytics',
    },
  ],
});
```

## Guidelines

1. **Be specific** - "Which error type?" not "How should I handle this?"
2. **Provide context** - Include why you're asking in the question
3. **Limit options to 3-5** - More options = harder to decide
4. **Always include "Other"** - User might have a better idea
5. **Use `allowComment: true`** - Lets users explain their reasoning
6. **Batch related questions** - Don't ask 5 separate questions; use one multi-step if needed
7. **Respect the answer** - Don't ask again unless requirements changed
