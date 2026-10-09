import { useState } from "react";
import type { CircleStatus } from "./model";

const circlesKey = (userId: string) => `vaskel.newCircles:${userId}`;

function read(userId: string): Map<string, CircleStatus> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(circlesKey(userId)) ?? "{}",
    );
    return new Map(
      typeof value === "object" && value !== null
        ? Object.entries(value).filter(
            (entry): entry is [string, CircleStatus] =>
              entry[1] === "new" || entry[1] === "done",
          )
        : [],
    );
  } catch {
    return new Map();
  }
}

/** Device-local start-here hints outlive the currently retained activity pages. */
export function useCircleStatus(userId: string) {
  const [status, setStatus] = useState(() => read(userId));
  function save(next: Map<string, CircleStatus>) {
    try {
      localStorage.setItem(
        circlesKey(userId),
        JSON.stringify(Object.fromEntries(next)),
      );
    } catch {
      // Refused storage leaves the hint usable for this account's mounted lifetime.
    }
    setStatus(next);
  }
  return {
    status,
    remember(newOwners: Iterable<string>, settledOwners: Iterable<string>) {
      const next = new Map(status);
      let changed = false;
      for (const identity of newOwners)
        if (!next.has(identity)) {
          next.set(identity, "new");
          changed = true;
        }
      for (const identity of settledOwners)
        if (next.get(identity) !== "done") {
          next.set(identity, "done");
          changed = true;
        }
      if (changed) save(next);
    },
    dismiss(identity: string) {
      save(new Map(status).set(identity, "done"));
    },
  };
}
