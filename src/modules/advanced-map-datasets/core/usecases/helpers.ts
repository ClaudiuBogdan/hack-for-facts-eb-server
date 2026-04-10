import { Value } from '@sinclair/typebox/value';
import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { createInvalidInputError, type AdvancedMapDatasetError } from '../errors.js';
import {
  ADVANCED_MAP_DATASET_MAX_ROW_COUNT,
  ADVANCED_MAP_DATASET_DESCRIPTION_MAX_LENGTH,
  ADVANCED_MAP_DATASET_MARKDOWN_MAX_LENGTH,
  ADVANCED_MAP_DATASET_TITLE_MAX_LENGTH,
  ADVANCED_MAP_DATASET_UNIT_MAX_LENGTH,
  ADVANCED_MAP_DATASET_JSON_LINK_LABEL_MAX_LENGTH,
  AdvancedMapDatasetJsonItemSchema,
  type AdvancedMapDatasetJsonItem,
  type AdvancedMapDatasetRow,
} from '../types.js';

export function normalizeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeNullableText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const SAFE_LINK_PROTOCOL_REGEX = /^https?:\/\//i;
function sanitizeMarkdownUrl(url: string): string | null {
  const trimmed = url.trim();
  return SAFE_LINK_PROTOCOL_REGEX.test(trimmed) ? trimmed : null;
}

function htmlToMarkdownLinks(input: string): string {
  return input.replace(
    /<a\s+[^>]*href=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote: string, href: string, text: string) => {
      const safeUrl = sanitizeMarkdownUrl(href);
      const cleanText = text.replace(/<\/?[^>]+>/g, '').trim();
      if (safeUrl === null || cleanText === '') {
        return cleanText;
      }
      return `[${cleanText}](${safeUrl})`;
    }
  );
}

function sanitizeMarkdownInlineLinks(input: string): string {
  return input.replace(
    /(!?)\[([^\]]*?)\]\(((?:[^()]|\([^)]*\))+?)(\s+"[^"]*")?\)/g,
    (_match, imageMarker: string, text: string, rawUrl: string, rawTitle: string | undefined) => {
      const url = rawUrl.trim();
      const title = rawTitle?.trim() ?? '';
      const unwrappedUrl = url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1).trim() : url;
      const safeUrl = sanitizeMarkdownUrl(unwrappedUrl);
      const cleanText = text.trim();

      if (safeUrl === null || cleanText === '') {
        return cleanText;
      }

      const normalizedTitle = title !== '' ? ` ${title}` : '';
      return `${imageMarker}[${cleanText}](${safeUrl}${normalizedTitle})`;
    }
  );
}

function sanitizeMarkdownReferenceDefinitions(input: string): string {
  return input.replace(
    /^\[([^\]]+)\]:\s*(\S+)(.*)$/gm,
    (_match, label: string, rawUrl: string, suffix: string) => {
      const safeUrl = sanitizeMarkdownUrl(rawUrl);
      if (safeUrl === null) {
        return '';
      }

      return `[${label.trim()}]: ${safeUrl}${suffix}`;
    }
  );
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function sanitizeMarkdownText(value: string): string {
  const normalizedNewlines = value.replace(/\r\n?/g, '\n');
  const withMarkdownLinks = htmlToMarkdownLinks(normalizedNewlines);
  const withSanitizedMarkdownLinks = sanitizeMarkdownInlineLinks(withMarkdownLinks);
  const withSanitizedReferenceLinks = sanitizeMarkdownReferenceDefinitions(
    withSanitizedMarkdownLinks
  );
  const withoutBreakTags = withSanitizedReferenceLinks.replace(/<br\s*\/?>/gi, '\n');
  const withoutHtml = withoutBreakTags.replace(/<\/?[^>]+>/g, '');
  const decoded = decodeBasicHtmlEntities(withoutHtml);
  const withoutControlChars = decoded.replace(/[^\P{C}\n\t]/gu, '');
  const trimmedLines = withoutControlChars
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');

  return trimmedLines.replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeNullableMarkdown(
  value: string | null | undefined
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const sanitized = sanitizeMarkdownText(value);
  return sanitized !== '' ? sanitized : null;
}

export function validateTitle(
  value: string,
  fieldName: string
): Result<string, AdvancedMapDatasetError> {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return err(createInvalidInputError(`${fieldName} cannot be empty`));
  }

  if (trimmed.length > ADVANCED_MAP_DATASET_TITLE_MAX_LENGTH) {
    return err(
      createInvalidInputError(
        `${fieldName} exceeds maximum length of ${String(ADVANCED_MAP_DATASET_TITLE_MAX_LENGTH)}`
      )
    );
  }

  return ok(trimmed);
}

export function validateDescription(
  value: string | null,
  fieldName: string
): Result<string | null, AdvancedMapDatasetError> {
  if (value === null) {
    return ok(null);
  }

  if (value.length > ADVANCED_MAP_DATASET_DESCRIPTION_MAX_LENGTH) {
    return err(
      createInvalidInputError(
        `${fieldName} exceeds maximum length of ${String(
          ADVANCED_MAP_DATASET_DESCRIPTION_MAX_LENGTH
        )}`
      )
    );
  }

  return ok(value);
}

export function validateMarkdown(
  value: string | null,
  fieldName: string
): Result<string | null, AdvancedMapDatasetError> {
  if (value === null) {
    return ok(null);
  }

  if (value.length > ADVANCED_MAP_DATASET_MARKDOWN_MAX_LENGTH) {
    return err(
      createInvalidInputError(
        `${fieldName} exceeds maximum length of ${String(ADVANCED_MAP_DATASET_MARKDOWN_MAX_LENGTH)}`
      )
    );
  }

  return ok(value);
}

export function validateUnit(
  value: string | null | undefined
): Result<string | null, AdvancedMapDatasetError> {
  const normalized = normalizeNullableText(value);
  if (normalized === undefined || normalized === null) {
    return ok(null);
  }

  if (normalized.length > ADVANCED_MAP_DATASET_UNIT_MAX_LENGTH) {
    return err(
      createInvalidInputError(
        `unit exceeds maximum length of ${String(ADVANCED_MAP_DATASET_UNIT_MAX_LENGTH)}`
      )
    );
  }

  return ok(normalized);
}

export function validateRowCount(rowCount: number): Result<number, AdvancedMapDatasetError> {
  if (rowCount <= 0) {
    return err(createInvalidInputError('Dataset must contain at least one row'));
  }

  if (rowCount > ADVANCED_MAP_DATASET_MAX_ROW_COUNT) {
    return err(
      createInvalidInputError(
        `Dataset exceeds maximum row count of ${String(ADVANCED_MAP_DATASET_MAX_ROW_COUNT)}`
      )
    );
  }

  return ok(rowCount);
}

function validateDatasetJsonValue(
  value: AdvancedMapDatasetJsonItem
): Result<AdvancedMapDatasetJsonItem, AdvancedMapDatasetError> {
  if (!Value.Check(AdvancedMapDatasetJsonItemSchema, value)) {
    return err(
      createInvalidInputError(
        'Dataset rows require valueJson payloads that match a supported schema'
      )
    );
  }

  if (value.type === 'text') {
    const text = value.value.text.trim();
    if (text === '') {
      return err(createInvalidInputError('Dataset text payloads require non-empty text'));
    }

    return ok({
      type: 'text',
      value: {
        text,
      },
    });
  }

  if (value.type === 'markdown') {
    const markdown = sanitizeMarkdownText(value.value.markdown);
    if (markdown === '') {
      return err(createInvalidInputError('Dataset markdown payloads require non-empty markdown'));
    }

    return ok({
      type: 'markdown',
      value: {
        markdown,
      },
    });
  }

  const url = value.value.url.trim();
  if (!SAFE_LINK_PROTOCOL_REGEX.test(url)) {
    return err(createInvalidInputError('Dataset link payloads require http/https urls'));
  }

  const label = normalizeNullableText(value.value.label);
  if (
    label !== undefined &&
    label !== null &&
    label.length > ADVANCED_MAP_DATASET_JSON_LINK_LABEL_MAX_LENGTH
  ) {
    return err(
      createInvalidInputError(
        `Dataset link labels exceed maximum length of ${String(
          ADVANCED_MAP_DATASET_JSON_LINK_LABEL_MAX_LENGTH
        )}`
      )
    );
  }

  return ok({
    type: 'link',
    value: {
      url,
      label: label === undefined ? null : label,
    },
  });
}

export function validateDatasetRows(
  rows: readonly AdvancedMapDatasetRow[]
): Result<AdvancedMapDatasetRow[], AdvancedMapDatasetError> {
  const normalizedRows: AdvancedMapDatasetRow[] = [];
  const seenSirutaCodes = new Set<string>();

  for (const row of rows) {
    const sirutaCode = row.sirutaCode.trim();
    if (sirutaCode.length === 0) {
      return err(createInvalidInputError('Dataset rows require non-empty sirutaCode values'));
    }

    if (seenSirutaCodes.has(sirutaCode)) {
      return err(
        createInvalidInputError(`Dataset rows contain duplicate sirutaCode: ${sirutaCode}`)
      );
    }

    const normalizedValueNumber = normalizeNullableText(row.valueNumber);
    let valueNumber: string | null = null;
    if (normalizedValueNumber !== undefined && normalizedValueNumber !== null) {
      let decimal: Decimal;
      try {
        decimal = new Decimal(normalizedValueNumber);
      } catch {
        return err(createInvalidInputError('Dataset rows require finite numeric values'));
      }

      if (!decimal.isFinite()) {
        return err(createInvalidInputError('Dataset rows require finite numeric values'));
      }

      valueNumber = decimal.toString();
    }

    let valueJson: AdvancedMapDatasetJsonItem | null = null;
    if (row.valueJson !== null) {
      const jsonResult = validateDatasetJsonValue(row.valueJson);
      if (jsonResult.isErr()) {
        return err(jsonResult.error);
      }

      valueJson = jsonResult.value;
    }

    if (valueNumber === null && valueJson === null) {
      return err(
        createInvalidInputError('Dataset rows require at least one of valueNumber or valueJson')
      );
    }

    seenSirutaCodes.add(sirutaCode);
    normalizedRows.push({
      sirutaCode,
      valueNumber,
      valueJson,
    });
  }

  return ok(normalizedRows);
}
