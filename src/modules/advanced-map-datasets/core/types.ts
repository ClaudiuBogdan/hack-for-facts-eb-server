import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const ADVANCED_MAP_DATASET_TITLE_MAX_LENGTH = 255;
export const ADVANCED_MAP_DATASET_DESCRIPTION_MAX_LENGTH = 2000;
export const ADVANCED_MAP_DATASET_MARKDOWN_MAX_LENGTH = 10_000;
export const ADVANCED_MAP_DATASET_UNIT_MAX_LENGTH = 100;
export const ADVANCED_MAP_DATASET_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const ADVANCED_MAP_DATASET_MAX_ROW_COUNT = 50_000;
export const ADVANCED_MAP_DATASET_DEFAULT_LIMIT = 20;
export const ADVANCED_MAP_DATASET_MAX_LIMIT = 100;

export type AdvancedMapDatasetVisibility = 'private' | 'unlisted' | 'public';
export const ADVANCED_MAP_DATASET_JSON_TEXT_MAX_LENGTH = 10_000;
export const ADVANCED_MAP_DATASET_JSON_LINK_URL_MAX_LENGTH = 2_000;
export const ADVANCED_MAP_DATASET_JSON_LINK_LABEL_MAX_LENGTH = 255;

export type AdvancedMapDatasetJsonItemType = 'text' | 'link' | 'markdown';

export const ADVANCED_MAP_DATASET_JSON_ITEM_TYPES = ['text', 'link', 'markdown'] as const;

export const AdvancedMapDatasetJsonTextValueSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: ADVANCED_MAP_DATASET_JSON_TEXT_MAX_LENGTH }),
  },
  { additionalProperties: false }
);

export const AdvancedMapDatasetJsonLinkValueSchema = Type.Object(
  {
    url: Type.String({ minLength: 1, maxLength: ADVANCED_MAP_DATASET_JSON_LINK_URL_MAX_LENGTH }),
    label: Type.Union([
      Type.String({ maxLength: ADVANCED_MAP_DATASET_JSON_LINK_LABEL_MAX_LENGTH }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false }
);

export const AdvancedMapDatasetJsonMarkdownValueSchema = Type.Object(
  {
    markdown: Type.String({ minLength: 1, maxLength: ADVANCED_MAP_DATASET_MARKDOWN_MAX_LENGTH }),
  },
  { additionalProperties: false }
);

export const AdvancedMapDatasetJsonTextItemSchema = Type.Object(
  {
    type: Type.Literal('text'),
    value: AdvancedMapDatasetJsonTextValueSchema,
  },
  { additionalProperties: false }
);

export const AdvancedMapDatasetJsonLinkItemSchema = Type.Object(
  {
    type: Type.Literal('link'),
    value: AdvancedMapDatasetJsonLinkValueSchema,
  },
  { additionalProperties: false }
);

export const AdvancedMapDatasetJsonMarkdownItemSchema = Type.Object(
  {
    type: Type.Literal('markdown'),
    value: AdvancedMapDatasetJsonMarkdownValueSchema,
  },
  { additionalProperties: false }
);

export const AdvancedMapDatasetJsonItemSchema = Type.Union([
  AdvancedMapDatasetJsonTextItemSchema,
  AdvancedMapDatasetJsonLinkItemSchema,
  AdvancedMapDatasetJsonMarkdownItemSchema,
]);

export type AdvancedMapDatasetJsonTextItem = Static<typeof AdvancedMapDatasetJsonTextItemSchema>;
export type AdvancedMapDatasetJsonLinkItem = Static<typeof AdvancedMapDatasetJsonLinkItemSchema>;
export type AdvancedMapDatasetJsonMarkdownItem = Static<
  typeof AdvancedMapDatasetJsonMarkdownItemSchema
>;
export type AdvancedMapDatasetJsonItem = Static<typeof AdvancedMapDatasetJsonItemSchema>;

export interface AdvancedMapDatasetRow {
  sirutaCode: string;
  valueNumber: string | null;
  valueJson: AdvancedMapDatasetJsonItem | null;
}

export interface AdvancedMapDatasetReference {
  mapId: string;
  title: string;
  snapshotId: string | null;
}

export interface AdvancedMapDatasetSummary {
  id: string;
  publicId: string;
  userId: string;
  title: string;
  description: string | null;
  markdown: string | null;
  unit: string | null;
  visibility: AdvancedMapDatasetVisibility;
  rowCount: number;
  replacedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdvancedMapDatasetDetail extends AdvancedMapDatasetSummary {
  rows: AdvancedMapDatasetRow[];
}

export interface AdvancedMapDatasetPageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface AdvancedMapDatasetConnection {
  nodes: AdvancedMapDatasetSummary[];
  pageInfo: AdvancedMapDatasetPageInfo;
}

export interface CreateAdvancedMapDatasetInput {
  userId: string;
  title: string;
  description?: string | null;
  markdown?: string | null;
  unit?: string | null;
  visibility?: AdvancedMapDatasetVisibility;
  rows: readonly AdvancedMapDatasetRow[];
}

export interface UpdateAdvancedMapDatasetInput {
  userId: string;
  datasetId: string;
  title?: string;
  description?: string | null;
  markdown?: string | null;
  unit?: string | null;
  visibility?: AdvancedMapDatasetVisibility;
  allowPublicWrite?: boolean;
}

export interface ReplaceAdvancedMapDatasetRowsInput {
  userId: string;
  datasetId: string;
  rows: readonly AdvancedMapDatasetRow[];
  allowPublicWrite?: boolean;
}

export function isAdvancedMapDatasetJsonItemType(
  value: string
): value is AdvancedMapDatasetJsonItemType {
  return ADVANCED_MAP_DATASET_JSON_ITEM_TYPES.includes(value as AdvancedMapDatasetJsonItemType);
}

export function isAdvancedMapDatasetJsonItem(value: unknown): value is AdvancedMapDatasetJsonItem {
  return Value.Check(AdvancedMapDatasetJsonItemSchema, value);
}
