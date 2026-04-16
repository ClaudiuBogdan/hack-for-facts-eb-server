import { Value } from '@sinclair/typebox/value';

import {
  AdminWorkflowSchema,
  type AdminResponseEvent,
  type AdminWorkflow,
  type CampaignAdminResponseStatus,
  type CampaignAdminThreadState,
  type CorrespondenceThreadRecord,
  type ThreadPhase,
  type ThreadRecord,
} from './types.js';

const PENDING_LOW_LEVEL_PHASES = new Set<ThreadPhase>([
  'reply_received_unreviewed',
  'manual_follow_up_needed',
]);

const RESOLVED_LOW_LEVEL_PHASES = new Set<ThreadPhase>([
  'resolved_positive',
  'resolved_negative',
  'closed_no_response',
]);

export interface CampaignAdminThreadProjection {
  threadState: CampaignAdminThreadState;
  currentResponseStatus: CampaignAdminResponseStatus | null;
  latestResponseAt: string | null;
  responseEvents: AdminResponseEvent[];
  responseEventCount: number;
}

export function readAdminWorkflow(record: CorrespondenceThreadRecord): AdminWorkflow | null {
  const candidate = record.adminWorkflow;
  if (candidate === undefined) {
    return null;
  }

  return Value.Check(AdminWorkflowSchema, candidate) ? candidate : null;
}

export function readAdminResponseEvents(record: CorrespondenceThreadRecord): AdminResponseEvent[] {
  return readAdminWorkflow(record)?.responseEvents ?? [];
}

export function getLatestAdminResponseEvent(
  record: CorrespondenceThreadRecord
): AdminResponseEvent | null {
  const responseEvents = readAdminResponseEvents(record);
  return responseEvents.at(-1) ?? null;
}

export function appendAdminResponseEvent(input: {
  record: CorrespondenceThreadRecord;
  event: AdminResponseEvent;
}): CorrespondenceThreadRecord {
  const responseEvents = readAdminResponseEvents(input.record);

  return {
    ...input.record,
    adminWorkflow: {
      currentResponseStatus: input.event.responseStatus,
      responseEvents: [...responseEvents, input.event],
    },
  };
}

export function deriveCampaignAdminThreadStateFromResponseStatus(
  responseStatus: CampaignAdminResponseStatus
): CampaignAdminThreadState {
  return responseStatus === 'registration_number_received' ? 'pending' : 'resolved';
}

export function deriveCampaignAdminThreadStateFromLowLevelPhase(
  phase: ThreadPhase
): CampaignAdminThreadState {
  if (PENDING_LOW_LEVEL_PHASES.has(phase)) {
    return 'pending';
  }

  if (RESOLVED_LOW_LEVEL_PHASES.has(phase)) {
    return 'resolved';
  }

  return 'started';
}

export function projectCampaignAdminThread(thread: ThreadRecord): CampaignAdminThreadProjection {
  const latestResponseEvent = getLatestAdminResponseEvent(thread.record);
  if (latestResponseEvent !== null) {
    const responseEvents = readAdminResponseEvents(thread.record);

    return {
      threadState: deriveCampaignAdminThreadStateFromResponseStatus(
        latestResponseEvent.responseStatus
      ),
      currentResponseStatus: latestResponseEvent.responseStatus,
      latestResponseAt: latestResponseEvent.responseDate,
      responseEvents,
      responseEventCount: responseEvents.length,
    };
  }

  return {
    threadState: deriveCampaignAdminThreadStateFromLowLevelPhase(thread.phase),
    currentResponseStatus: null,
    latestResponseAt: null,
    responseEvents: [],
    responseEventCount: 0,
  };
}

export function isCampaignAdminThreadInScope(thread: ThreadRecord): boolean {
  return thread.record.submissionPath === 'platform_send' && thread.phase !== 'failed';
}
