/**
 * Kernel-owned MCP App widget resources (SEP-1865).
 *
 * Each `ui://` resource is a self-contained HTML document generated from
 * `widgets/src/` by `pnpm widgets:build`. Tools opt in by declaring
 * `ui: { resourceUri }` (see `KernelMcpToolUi`); hosts without MCP Apps
 * support ignore the metadata and fall back to the text content.
 */

import { entitySearchWidgetHtml, entitySearchWidgetUri } from './entity-search.gen.js';
import { entitySnapshotWidgetHtml, entitySnapshotWidgetUri } from './entity-snapshot.gen.js';

import type { KernelMcpResource } from '../types.js';

/**
 * Content-hashed by the build (hosts treat the URI as a cache key — a changed
 * widget must change its URI to invalidate host caches).
 */
export const ENTITY_SEARCH_WIDGET_URI = entitySearchWidgetUri;
export const ENTITY_SNAPSHOT_WIDGET_URI = entitySnapshotWidgetUri;

/**
 * Widgets draw their own 2px card border (the site's visual language), so
 * hosts should not add another frame around the iframe.
 */
const WIDGET_UI_META = { ui: { prefersBorder: false } } as const;

export const makeKernelMcpResources = (): readonly KernelMcpResource[] => [
  {
    name: 'entity-search-widget',
    uri: ENTITY_SEARCH_WIDGET_URI,
    title: 'Căutare entități — Transparenta.eu',
    description: 'Interactive result list for the search_entities tool.',
    meta: WIDGET_UI_META,
    text: entitySearchWidgetHtml,
  },
  {
    name: 'entity-snapshot-widget',
    uri: ENTITY_SNAPSHOT_WIDGET_URI,
    title: 'Profil entitate — Transparenta.eu',
    description: 'Entity card for the get_entity_snapshot tool.',
    meta: WIDGET_UI_META,
    text: entitySnapshotWidgetHtml,
  },
];
