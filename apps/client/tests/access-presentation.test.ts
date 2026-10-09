import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { deferred } from "@tests/shared/deferred";
import { accessSnapshot } from "@/client/features/cache/access/presentation";
import { message } from "@/client/features/i18n/messages";
import {
  authenticated,
  fixture,
  loadAccessModules,
  remembered,
  user,
} from "./helpers/cache-access";

const active: ReturnType<typeof fixture>["access"][] = [];
function setup() {
  const result = fixture();
  active.push(result.access);
  return {
    ...result,
    snapshot: () => accessSnapshot(result.access.getSnapshot()),
  };
}

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  await loadAccessModules();
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  for (const access of active.splice(0)) access.stop();
});

describe("account presentation", () => {
  it("keeps an admitted account without history storage through checking and failed reconnect", async () => {
    const { access, cache, dependencies, snapshot } = setup();
    vi.mocked(cache.captureAccount).mockResolvedValue({
      kind: "unavailable",
      reason: "blocked",
    });
    await authenticated(access);
    expect(snapshot()).toMatchObject({
      view: { kind: "account", user, connection: { kind: "ready" } },
      canUseNetwork: true,
      accountFence: null,
    });

    const maintenance =
      deferred<Awaited<ReturnType<typeof dependencies.identity>>>();
    dependencies.identity.mockReturnValueOnce(maintenance.promise);
    const checking = access.checkSession();
    expect(snapshot().view).toMatchObject({
      kind: "account",
      user,
      connection: { kind: "ready" },
    });
    maintenance.resolve({ status: "authenticated", user });
    await checking;

    access.disconnected();
    expect(snapshot()).toMatchObject({
      view: {
        kind: "account",
        user,
        connection: { kind: "unavailable", error: null },
      },
      canUseNetwork: false,
    });
    const identity =
      deferred<Awaited<ReturnType<typeof dependencies.identity>>>();
    dependencies.identity.mockReturnValueOnce(identity.promise);
    const retrying = access.retry();
    expect(snapshot().view).toMatchObject({
      kind: "account",
      user,
      connection: { kind: "checking" },
    });
    // The failure is a stopped identity check, not an in-flight reconnect.
    identity.reject(new Error("Identity response unavailable"));
    await retrying;
    expect(snapshot().view).toMatchObject({
      kind: "account",
      user,
      connection: { kind: "unavailable", error: expect.any(Object) },
    });
  });

  it("keeps remembered history passive while identity is being checked", async () => {
    const { access, dependencies, snapshot } = setup();
    access.start(false);
    await vi.waitFor(() =>
      expect(snapshot().view).toMatchObject({
        kind: "cached",
        account: remembered,
      }),
    );
    const identity =
      deferred<Awaited<ReturnType<typeof dependencies.identity>>>();
    dependencies.identity.mockReturnValueOnce(identity.promise);
    const reconnecting = access.retry();
    expect(snapshot()).toMatchObject({
      view: {
        kind: "cached",
        account: remembered,
        connection: { kind: "checking" },
      },
      canUseNetwork: false,
    });
    identity.resolve({ status: "authenticated", user });
    await reconnecting;
    expect(snapshot().view).toMatchObject({ kind: "account", user });
  });

  it("distinguishes an empty offline view from initial admission and a stopped failure", async () => {
    const { access, cache, dependencies, snapshot } = setup();
    expect(snapshot().view).toEqual({ kind: "opening" });
    vi.mocked(cache.readAccount).mockResolvedValue({ kind: "miss" });
    access.start(false);
    expect(snapshot().view).toEqual({
      kind: "cached",
      account: null,
      connection: { kind: "unavailable", error: null },
    });
    dependencies.identity.mockRejectedValueOnce(
      new Error("Invalid identity response"),
    );
    const retrying = access.retry();
    expect(snapshot().view).toEqual({ kind: "opening" });
    await retrying;
    expect(snapshot().view).toMatchObject({
      kind: "failed",
      error: expect.any(Object),
    });
  });

  it("closes the account before durable sign-out cleanup settles", async () => {
    const { access, cache, snapshot } = setup();
    await authenticated(access);
    const removal =
      deferred<Awaited<ReturnType<typeof cache.invalidateAccount>>>();
    vi.mocked(cache.invalidateAccount).mockReturnValueOnce(removal.promise);
    const notice = message("api.unauthenticated");
    const retiring = access.logout(notice);
    expect(snapshot()).toMatchObject({
      view: { kind: "signed-out", notice },
      canUseNetwork: false,
      accountFence: null,
    });
    removal.resolve({ kind: "ok", value: undefined });
    await retiring;
    expect(snapshot().view).toEqual({ kind: "signed-out", notice });
  });
});
