/**
 * Records the calls made to one method of an in-memory fake — the project's
 * replacement for `vi.spyOn` (no mocking libraries, T-10). The method keeps
 * its behaviour unless `override` is given, in which case the override answers
 * and the calls are still recorded.
 */
type AnyMethod = (...args: never[]) => unknown;

export interface RecordedCalls<M extends AnyMethod> {
  readonly calls: Parameters<M>[];
}

export const recordCalls = <T extends object, K extends keyof T & string>(
  target: T,
  method: K,
  override?: T[K] & AnyMethod
): RecordedCalls<Extract<T[K], AnyMethod>> => {
  type M = Extract<T[K], AnyMethod>;
  const calls: Parameters<M>[] = [];
  const original = target[method] as unknown as M;
  const answer = (override ?? original) as unknown as M;
  const recording = (...args: Parameters<M>): ReturnType<M> => {
    calls.push(args);
    return answer.apply(target, args) as ReturnType<M>;
  };
  (target as Record<K, unknown>)[method] = recording;
  return { calls };
};
