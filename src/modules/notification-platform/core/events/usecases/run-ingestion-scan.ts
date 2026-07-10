import { err, ok, type Result } from 'neverthrow';

import { recordNotificationEvent } from './record-notification-event.js';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { KindRegistry } from '../../registry/registry.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { EventError, EventSourceError } from '../errors.js';
import type {
  EventFanOutScheduler,
  EventSourcePort,
  NotificationEventRepo,
  SourceWatermarkRepo,
} from '../ports.js';

export interface RunIngestionScanDeps {
  source: EventSourcePort;
  watermarks: SourceWatermarkRepo;
  events: NotificationEventRepo;
  registry: KindRegistry;
  audit: AuditLedgerPort;
  fanOutScheduler: EventFanOutScheduler;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface RunIngestionScanInput {
  batchLimit: number;
}

export interface RunIngestionScanResult {
  recorded: number;
  duplicates: number;
  watermarkAdvanced: boolean;
}

export type RunIngestionScanError = EventError | EventSourceError | AuditError;

export const runIngestionScan = async (
  deps: RunIngestionScanDeps,
  input: RunIngestionScanInput
): Promise<Result<RunIngestionScanResult, RunIngestionScanError>> => {
  const currentWatermark = await deps.watermarks.get(deps.source.sourceId);
  if (currentWatermark.isErr()) {
    return err(currentWatermark.error);
  }
  const page = await deps.source.readOccurrences({
    watermark: currentWatermark.value,
    limit: input.batchLimit,
  });
  if (page.isErr()) {
    return err(page.error);
  }

  let recorded = 0;
  let duplicates = 0;
  for (const occurrence of page.value.occurrences) {
    const result = await recordNotificationEvent(
      {
        events: deps.events,
        registry: deps.registry,
        audit: deps.audit,
        fanOutScheduler: deps.fanOutScheduler,
        clock: deps.clock,
        ids: deps.ids,
        logger: deps.logger,
      },
      {
        source: deps.source.sourceId,
        eventType: occurrence.eventType,
        eventSchemaVersion:
          deps.registry.getByEventType(occurrence.eventType)?.eventSchemaVersion ?? 1,
        occurrenceKey: occurrence.occurrenceKey,
        occurredAt: occurrence.occurredAt,
        facts: occurrence.facts,
        ...(occurrence.correlationId === undefined
          ? {}
          : { correlationId: occurrence.correlationId }),
      }
    );
    if (result.isErr()) {
      return err(result.error);
    }
    if (result.value.outcome === 'created') {
      recorded += 1;
    } else {
      duplicates += 1;
    }
  }

  if (page.value.nextWatermark === null) {
    return ok({ recorded, duplicates, watermarkAdvanced: false });
  }
  const advanced = await deps.watermarks.compareAndSet({
    sourceId: deps.source.sourceId,
    expected: currentWatermark.value,
    next: page.value.nextWatermark,
  });
  if (advanced.isErr()) {
    return err(advanced.error);
  }
  return ok({ recorded, duplicates, watermarkAdvanced: advanced.value });
};
