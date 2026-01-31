/**
 * Progress Bar Component
 *
 * A horizontal progress bar for displaying percentages (email-safe using tables).
 */

// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ProgressBarProps {
  /** Percentage value (0-100) */
  percentage: number;
  /** Bar fill color */
  color?: string;
  /** Bar background color */
  backgroundColor?: string;
  /** Bar height in pixels */
  height?: number;
  /** Bar width (CSS value) */
  width?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const ProgressBar = ({
  percentage,
  color = '#6366f1',
  backgroundColor = '#e5e7eb',
  height = 8,
  width = '100%',
}: ProgressBarProps): React.ReactElement => {
  // Clamp percentage between 0 and 100
  const clampedPercentage = Math.max(0, Math.min(100, percentage));

  return (
    <table
      width={width}
      cellPadding="0"
      cellSpacing="0"
      border={0}
      style={{ borderRadius: `${String(height / 2)}px`, overflow: 'hidden' }}
    >
      <tr>
        <td
          style={{
            backgroundColor: backgroundColor,
            borderRadius: `${String(height / 2)}px`,
            padding: 0,
          }}
        >
          <table
            width={`${String(clampedPercentage)}%`}
            cellPadding="0"
            cellSpacing="0"
            border={0}
          >
            <tr>
              <td
                height={height}
                style={{
                  backgroundColor: color,
                  borderRadius: `${String(height / 2)}px`,
                }}
              />
            </tr>
          </table>
        </td>
      </tr>
    </table>
  );
};

export default ProgressBar;
