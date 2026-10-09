import { deferred } from "@tests/shared/deferred";

export function barrier() {
  const { promise, resolve: release } = deferred();
  return { promise, release };
}
