export const ADMIN_EVENT_JOB_NAME = 'admin-event';

export const getAdminEventJobOptions = (jobId: string) => ({
  jobId,
  attempts: 1,
  removeOnComplete: false,
  removeOnFail: false,
});
