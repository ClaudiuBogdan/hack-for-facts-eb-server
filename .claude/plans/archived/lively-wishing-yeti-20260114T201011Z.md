# Entity Newsletter Email Template Redesign Plan

## Overview

Redesign the newsletter email template to be visually beautiful and information-rich, matching the transparenta.eu client design aesthetic while including comprehensive budget data.

**Scope**: Full implementation including all proposed sections + data fetching layer updates.

---

## Current State

The current email template is minimal:

- Simple greeting and intro text
- Basic summary box with 3 metrics (income, expenses, balance)
- Single CTA button
- Plain styling

---

## Design Goals

1. **Visual Consistency**: Match the client's clean, modern design
2. **Information Density**: Include more useful data without overwhelming
3. **Email Compatibility**: Work across all major email clients
4. **Mobile Responsive**: Look good on phones and tablets
5. **Actionable**: Clear CTAs to drive engagement

---

## Proposed Email Structure

### Section 1: Header

- **Transparenta.eu** brand with logo styling
- Period badge (e.g., "Ianuarie 2025" or "T1 2025")

### Section 2: Entity Info Card

- Entity name (large, bold)
- Entity type badge (Primărie Municipiu, Consiliu Județean, etc.)
- CUI code
- Location: County, UAT
- Population (if available)

### Section 3: Financial Summary (3-Column Grid)

Three cards matching client design:

| Total Venituri      | Total Cheltuieli    | Sold Bugetar       |
| ------------------- | ------------------- | ------------------ |
| ↗ Green icon        | ↘ Red icon          | ⚖ Blue icon        |
| **280,05 mil. RON** | **182,37 mil. RON** | **97,68 mil. RON** |
| +12,3% vs prev      | +8,7% vs prev       | +23,1% vs prev     |

### Section 4: Period Comparison (New!)

Mini comparison showing change from previous period:

- Compact visual indicator (↑ or ↓ with percentage)
- Color-coded: green for improvement, red for concern

### Section 5: Top Spending Categories (New!)

Top 5 expense categories with horizontal bars:

```
1. Învățământ          ████████████░░░ 45,2 mil. RON (28%)
2. Sănătate            ██████████░░░░░ 32,1 mil. RON (20%)
3. Administrație       ████████░░░░░░░ 25,8 mil. RON (16%)
4. Cultură             ██████░░░░░░░░░ 18,3 mil. RON (11%)
5. Transport           █████░░░░░░░░░░ 15,2 mil. RON (9%)
```

### Section 6: Funding Sources Breakdown (New!)

Pie/donut representation or simple list:

- Buget local: 65%
- Buget de stat: 25%
- Fonduri UE: 10%

### Section 7: Call to Action

Primary button: "Vezi raportul complet →"
Secondary link: "Explorează pe hartă"

### Section 8: Footer

- Unsubscribe link
- Preferences link
- Copyright

---

## Visual Design Specifications

### Color Palette (matching client)

```
Primary Blue:     #1a1a2e (dark navy - buttons, headers)
Income Green:     #10b981 (teal-500)
Expense Red:      #f43f5e (rose-500)
Balance Blue:     #6366f1 (indigo-500)
Background:       #f6f9fc (light gray)
Card Background:  #ffffff (white)
Text Primary:     #1a1a2e (dark)
Text Secondary:   #525f7f (slate)
Text Muted:       #8898aa (light gray)
```

### Typography

```
Font Family:      system-ui, -apple-system, 'Segoe UI', sans-serif
Entity Name:      24px, bold, #1a1a2e
Card Title:       14px, medium, #525f7f
Card Value:       28px, bold, #1a1a2e
Percentage:       14px, semibold, green/red based on direction
Body Text:        16px, regular, #525f7f
```

### Spacing

```
Container Width:  600px (email standard)
Card Padding:     24px
Section Gap:      32px
Border Radius:    8px (cards), 4px (buttons)
```

---

## Extended Props Interface

```typescript
export interface NewsletterEntityProps extends BaseTemplateProps {
  templateType: 'newsletter_entity';

  // Entity Info
  entityName: string;
  entityCui: string;
  entityType?: string; // NEW: "Primărie Municipiu", "UAT", etc.
  countyName?: string; // NEW
  population?: number; // NEW

  // Period
  periodType: NewsletterPeriodType;
  periodLabel: string;

  // Core Summary
  summary: BudgetSummary;

  // NEW: Period Comparison
  previousPeriodComparison?: {
    incomeChangePercent: number;
    expensesChangePercent: number;
    balanceChangePercent: number;
  };

  // NEW: Top Categories
  topExpenseCategories?: Array<{
    name: string;
    amount: number;
    percentage: number;
  }>;

  // NEW: Funding Sources
  fundingSources?: Array<{
    name: string;
    percentage: number;
  }>;

  // NEW: Per Capita (for UATs)
  perCapita?: {
    income: number;
    expenses: number;
  };

  // Links
  detailsUrl?: string;
  mapUrl?: string; // NEW
}
```

---

## Implementation Files

| File                                                                  | Changes                                      |
| --------------------------------------------------------------------- | -------------------------------------------- |
| `src/modules/email-templates/core/types.ts`                           | Extend NewsletterEntityProps with new fields |
| `src/modules/email-templates/core/i18n.ts`                            | Add new translation keys                     |
| `src/modules/email-templates/shell/templates/newsletter-entity.tsx`   | Complete redesign                            |
| `src/modules/email-templates/shell/templates/components/`             | NEW: Reusable components                     |
| `src/modules/notification-delivery/core/usecases/compose-delivery.ts` | Fetch additional data                        |

### New Components to Create

1. **`metric-card.tsx`** - Reusable financial metric card
2. **`progress-bar.tsx`** - Horizontal progress bar for categories
3. **`change-indicator.tsx`** - % change with arrow and color
4. **`entity-header.tsx`** - Entity info section

---

## Data Fetching Changes

The `compose-delivery` use case will need to fetch additional data:

```typescript
// Current: Only fetches basic summary
const summary = await entityAnalyticsRepo.getSummary(entityCui, period);

// Extended: Fetch rich data
const [summary, topCategories, fundingSources, previousPeriod] = await Promise.all([
  entityAnalyticsRepo.getSummary(entityCui, period),
  aggregatedLineItemsRepo.getTopByFunctional(entityCui, period, 5),
  aggregatedLineItemsRepo.getByFundingSource(entityCui, period),
  entityAnalyticsRepo.getSummary(entityCui, previousPeriod),
]);
```

---

## Email Client Compatibility

### Tested Clients

- Gmail (web, iOS, Android)
- Apple Mail (macOS, iOS)
- Outlook (web, desktop, iOS)
- Yahoo Mail
- Thunderbird

### Compatibility Techniques

- Inline styles (no external CSS)
- Table-based layout for critical sections
- MSO conditional comments for Outlook
- Fallback fonts
- Image alt text
- VML for rounded corners in Outlook

---

## Verification Plan

1. **Preview Server**: Run `pnpm email:dev` and verify all sections render
2. **TypeScript**: Run `pnpm typecheck` to verify type safety
3. **Unit Tests**: Update tests for new props structure
4. **Email Testing**: Send test emails to:
   - Gmail
   - Outlook
   - Apple Mail
5. **Mobile Testing**: Verify responsive layout on phone simulators
6. **Litmus/Email on Acid**: Optional - cross-client rendering test

---

## Summary of Changes

| Current               | Redesigned                                                   |
| --------------------- | ------------------------------------------------------------ |
| 3 metrics only        | Entity info + 3 metrics + comparisons + categories + funding |
| Plain gray box        | Styled cards with icons and colors                           |
| No historical context | Period-over-period comparison                                |
| Single CTA            | Multiple action links                                        |
| Basic typography      | Client-matching design system                                |

---

## Implementation Steps

### Step 1: Extend Types

**File**: `src/modules/email-templates/core/types.ts`

- Add new optional fields to `NewsletterEntityProps`
- Add `TopExpenseCategory`, `FundingSourceBreakdown` interfaces

### Step 2: Update i18n

**File**: `src/modules/email-templates/core/i18n.ts`

- Add translations for new section titles
- Add "vs previous period" text
- Add category/funding source labels

### Step 3: Create Reusable Components

**Directory**: `src/modules/email-templates/shell/templates/components/`

- `metric-card.tsx` - Financial metric with icon, value, change indicator
- `progress-bar.tsx` - HTML-based horizontal bar (email-safe)
- `category-list.tsx` - Top 5 spending categories section
- `funding-breakdown.tsx` - Funding sources section

### Step 4: Redesign Main Template

**File**: `src/modules/email-templates/shell/templates/newsletter-entity.tsx`

- Implement new layout with all sections
- Apply client-matching styles
- Mobile-responsive table layout

### Step 5: Update Data Fetching

**File**: `src/modules/notification-delivery/core/usecases/compose-delivery.ts`

- Add port for aggregated line items repository
- Fetch top 5 expense categories by functional classification
- Fetch funding source breakdown
- Fetch previous period summary for comparison calculation

### Step 6: Add Repository Methods

**Files**:

- `src/modules/notification-delivery/core/ports.ts` - Add interfaces
- `src/modules/notification-delivery/shell/repo/newsletter-data-repo.ts` - Implement fetchers

### Step 7: Update Preview Props

**File**: `src/modules/email-templates/shell/templates/newsletter-entity.tsx`

- Add realistic sample data for all new sections
- Ensure preview renders complete email

### Step 8: Update Tests

**Files**:

- `tests/unit/notification-delivery/` - Update compose tests
- Add snapshot tests for email rendering

---

## Critical Files

```
src/modules/email-templates/core/types.ts
src/modules/email-templates/core/i18n.ts
src/modules/email-templates/shell/templates/newsletter-entity.tsx
src/modules/email-templates/shell/templates/components/metric-card.tsx
src/modules/email-templates/shell/templates/components/progress-bar.tsx
src/modules/email-templates/shell/templates/components/category-list.tsx
src/modules/notification-delivery/core/usecases/compose-delivery.ts
src/modules/notification-delivery/core/ports.ts
```
