export interface FaultRule<E> {
  error: E;
  /** 'once' (default), 'always', or an exact consecutive-failure budget. */
  times?: number | 'once' | 'always';
  /** 1-indexed call number at which the fault starts. */
  onCall?: number;
}

export interface FaultPlan<M extends string, E> {
  fail(method: M, rule: FaultRule<E>): void;
  clear(method?: M): void;
  intercept(method: M): E | undefined;
  callCount(method: M): number;
}

interface ScheduledFault<E> {
  readonly error: E;
  readonly startCall: number;
  remaining: number | 'always';
}

export function makeFaultPlan<M extends string, E>(): FaultPlan<M, E> {
  const rules = new Map<M, ScheduledFault<E>>();
  const callCounts = new Map<M, number>();

  return {
    fail: (method: M, rule: FaultRule<E>): void => {
      const times = rule.times ?? 'once';
      rules.set(method, {
        error: rule.error,
        startCall: rule.onCall ?? 1,
        remaining: times === 'once' ? 1 : times,
      });
    },
    clear: (method?: M): void => {
      if (method === undefined) {
        rules.clear();
        callCounts.clear();
      } else {
        rules.delete(method);
        callCounts.delete(method);
      }
    },
    intercept: (method: M): E | undefined => {
      const call = (callCounts.get(method) ?? 0) + 1;
      callCounts.set(method, call);

      const scheduled = rules.get(method);
      if (scheduled === undefined || call < scheduled.startCall) {
        return undefined;
      }
      if (scheduled.remaining === 'always') {
        return scheduled.error;
      }
      if (scheduled.remaining <= 0) {
        rules.delete(method);
        return undefined;
      }

      scheduled.remaining -= 1;
      if (scheduled.remaining === 0) {
        rules.delete(method);
      }
      return scheduled.error;
    },
    callCount: (method: M): number => callCounts.get(method) ?? 0,
  };
}
