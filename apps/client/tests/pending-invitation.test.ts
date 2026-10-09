import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetInvitation,
  pendingInvitation,
  rememberInvitation,
} from "@/client/features/auth/pending-invitation";

function storage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

describe("pending invitation", () => {
  afterEach(() => vi.unstubAllGlobals());
  const invitation = {
    token: "server-a.token",
    email: "robin@example.test",
    expiresAt: 2_000,
  };

  it("continues only the registering account before the invitation expires", () => {
    storage();
    expect(pendingInvitation("robin@example.test", 1_000)).toBeNull();
    rememberInvitation(invitation);
    expect(pendingInvitation("Robin@Example.test", 1_000)).toBe(
      "server-a.token",
    );
    expect(pendingInvitation("someone@example.test", 1_000)).toBeNull();
    expect(pendingInvitation("robin@example.test", 2_000)).toBeNull();
  });

  it("forgets only the invitation that was joined or refused", () => {
    storage();
    rememberInvitation(invitation);
    forgetInvitation("server-b.token");
    expect(pendingInvitation("robin@example.test", 1_000)).toBe(
      "server-a.token",
    );
    forgetInvitation("server-a.token");
    expect(pendingInvitation("robin@example.test", 1_000)).toBeNull();
  });

  it("reads malformed or unavailable storage as nothing pending", () => {
    const store = storage();
    for (const value of [
      "not json",
      "[]",
      '"server-a.token"',
      '{"token":"server-a.token","email":"robin@example.test"}',
    ]) {
      store.set("vaskel.invitation", value);
      expect(pendingInvitation("robin@example.test", 1_000)).toBeNull();
      expect(() => forgetInvitation("server-a.token")).not.toThrow();
    }
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Storage unavailable");
      },
      setItem: () => {
        throw new Error("Storage unavailable");
      },
    });
    expect(() => rememberInvitation(invitation)).not.toThrow();
    expect(pendingInvitation("robin@example.test", 1_000)).toBeNull();
    expect(() => forgetInvitation("server-a.token")).not.toThrow();
  });
});
