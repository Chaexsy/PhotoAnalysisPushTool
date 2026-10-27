// One queue covers API operations and the scheduler, including the shared browser profile.
let tail = Promise.resolve();
export function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = tail.then(operation);
  tail = result.then(() => undefined, () => undefined);
  return result;
}
