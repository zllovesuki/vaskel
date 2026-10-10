import type { PresenceRequest } from "@vaskel/contracts/presence";
import { observeSql, selectStatements } from "@tests/helpers/sql-observer";
import { barrier } from "@tests/helpers/barrier";
import { ACTOR_RPC_TIMEOUT_MS } from "@/server/actors/shared/bounded-work";
import { describe, expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { MembersOutcomeSchema } from "@vaskel/contracts/resources";
import {
  PRESENCE_MEMBER_PAGE_SIZE,
  PresenceOutcomeSchema,
} from "@vaskel/contracts/presence";
import { sampleOwnerPresence } from "@/server/presence/compose";
import type { IdentityPrincipal } from "@/server/auth/principal";
import { applicationHarness } from "@tests/helpers/application-harness";
import { openAccountEvents } from "@tests/helpers/event-dispatch-harness";

function identity(userId: string): IdentityPrincipal {
  return {
    userId,
    sessionId: "presence-proof",
    expiresAt: Date.now() + 60_000,
    verifiedAt: Date.now(),
    authEpoch: 1,
    isOperator: false,
    displayName: "Proof",
    email: "proof@example.invalid",
  };
}

describe("owner-authorized sampled presence", () => {
  it("samples notification connections through HTTP and conceals inaccessible or unknown owners", async () => {
    const h = applicationHarness();
    const { operator, first, second, alice } = await h.twoServers();
    expect(
      (
        await operator.request("/api/account/presence", {
          scopes: [{ owner: first.owner, userIds: ["not-an-account-id"] }],
        })
      ).status,
    ).toBe(400);
    const viewer = await openAccountEvents(operator);
    const stream = await openAccountEvents(alice.member);
    try {
      const hint = {
        type: "presence",
        owner: first.owner,
        userId: alice.registered.userId,
      };
      await vi.waitFor(() => expect(viewer.frames).toContainEqual(hint));
      const transitions = () =>
        viewer.frames.filter(
          (frame) =>
            frame.type === "presence" &&
            frame.userId === alice.registered.userId,
        ).length;
      const beforeClose = transitions();
      await stream.close();
      await vi.waitFor(() =>
        expect(transitions()).toBeGreaterThan(beforeClose),
      );
      const disconnected = PresenceOutcomeSchema.parse(
        await (
          await operator.request("/api/account/presence", {
            scopes: [
              { owner: first.owner, userIds: [alice.registered.userId] },
            ],
          })
        ).json(),
      );
      expect(disconnected).toMatchObject({
        scopes: [{ samples: [{ state: "offline" }] }],
      });
      const reconnected = await openAccountEvents(alice.member);
      try {
        const response = await operator.request("/api/account/presence", {
          scopes: [{ owner: first.owner }],
        });
        expect(response.status).toBe(200);
        const result = PresenceOutcomeSchema.parse(await response.json());
        expect(result).toMatchObject({
          kind: "presence",
          scopes: [
            {
              kind: "sampled",
              owner: first.owner,
              nextCursor: null,
              samples: expect.arrayContaining([
                {
                  userId: alice.registered.userId,
                  state: "online",
                  sampledAt: expect.any(Number),
                },
                {
                  userId: operator.profile!.userId,
                  state: "online",
                  sampledAt: expect.any(Number),
                },
              ]),
            },
          ],
        });
        const denied = PresenceOutcomeSchema.parse(
          await (
            await alice.member.request("/api/account/presence", {
              scopes: [
                { owner: second.owner },
                { owner: { kind: "server", id: crypto.randomUUID() } },
              ],
            })
          ).json(),
        );
        expect(denied).toMatchObject({
          kind: "presence",
          scopes: [{ kind: "denied" }, { kind: "denied" }],
        });
        expect(
          (
            await operator.request("/api/account/presence", {
              userIds: [alice.registered.userId],
            })
          ).status,
        ).toBe(400);
        const members = MembersOutcomeSchema.parse(
          await (await operator.request(`${first.path}/members`)).json(),
        );
        if (members.kind !== "members") throw new Error(members.kind);
        expect(members.members.every((member) => !("online" in member))).toBe(
          true,
        );
      } finally {
        await reconnected.close();
      }
    } finally {
      await stream.close();
      await viewer.close();
    }
  });

  it("paginates current owner membership, rejects removed readers and retains no presence replica", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const owner = h.environment.SERVER_DO.getByName(server.owner.id);
    const expected = [operator.profile!.userId];
    await runInDurableObject(owner, (_instance, state) => {
      for (let index = 0; index < PRESENCE_MEMBER_PAGE_SIZE + 3; index++) {
        const userId = crypto.randomUUID();
        expected.push(userId);
        state.storage.sql.exec(
          "INSERT INTO members (user_id, role) VALUES (?, 'member')",
          userId,
        );
      }
      expect(
        state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name IN ('member_presence','presence_notice')",
          )
          .toArray(),
      ).toEqual([]);
    });
    const principal = identity(operator.profile!.userId);
    const first = await owner.presenceCandidates(principal);
    if (first.kind !== "presence_candidates") throw new Error(first.kind);
    expect(first.userIds).toHaveLength(PRESENCE_MEMBER_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    const last = await owner.presenceCandidates(principal, {
      after: first.nextCursor!,
    });
    if (last.kind !== "presence_candidates") throw new Error(last.kind);
    expect(last.nextCursor).toBeNull();
    expect([...first.userIds, ...last.userIds]).toEqual(expected.sort());
    const selected = expected[0]!;
    const outsider = crypto.randomUUID();
    const targeted = await runInDurableObject(owner, (instance, state) =>
      observeSql(state.storage.sql, () =>
        instance.presenceCandidates(principal, {
          userIds: [selected, outsider, selected],
        }),
      ),
    );
    expect(targeted.value).toEqual({
      kind: "presence_candidates",
      userIds: [selected],
      nextCursor: null,
    });
    expect(selectStatements(targeted.statements).length).toBeLessThanOrEqual(3);
    expect(
      (
        await operator.request("/api/account/presence", {
          scopes: [
            { owner: server.owner, after: selected, userIds: [selected] },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      PresenceOutcomeSchema.parse(
        await (
          await operator.request("/api/account/presence", {
            scopes: [{ owner: server.owner, userIds: [selected, outsider] }],
          })
        ).json(),
      ),
    ).toMatchObject({
      scopes: [{ nextCursor: null, samples: [{ userId: selected }] }],
    });
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM members WHERE user_id=?",
        principal.userId,
      );
    });
    expect(
      await owner.presenceCandidates(principal, { userIds: [selected] }),
    ).toEqual({
      kind: "forbidden",
    });
    expect(
      await owner.presenceCandidates({
        ...principal,
        expiresAt: Date.now() - 1,
      }),
    ).toEqual({ kind: "unauthenticated" });
  });

  it("deduplicates accounts across scopes and preserves partial owner and hub failures as unknown", async () => {
    const h = applicationHarness();
    const { operator, first, second, alice } = await h.twoServers();
    const sampled: string[] = [];
    const environment = {
      ...h.environment,
      EVENT_DISPATCH: {
        getByName: () => ({
          samplePresence: async (ids: string[]) => {
            sampled.push(...ids);
            return {
              kind: "presence_samples",
              samples: ids
                .filter((id) => id !== alice.registered.userId)
                .map((userId) => ({
                  userId,
                  state: "online",
                  sampledAt: Date.now(),
                })),
            };
          },
        }),
      } as unknown as Env["EVENT_DISPATCH"],
    };
    const result = await sampleOwnerPresence(
      environment,
      identity(operator.profile!.userId),
      { scopes: [{ owner: first.owner }, { owner: second.owner }] },
    );
    expect(
      sampled.filter((id) => id === operator.profile!.userId),
    ).toHaveLength(1);
    expect(result).toMatchObject({
      kind: "presence",
      scopes: [
        {
          kind: "sampled",
          samples: expect.arrayContaining([
            { userId: alice.registered.userId, state: "unknown" },
          ]),
        },
        { kind: "sampled" },
      ],
    });
    const unavailable = await sampleOwnerPresence(
      {
        ...environment,
        SERVER_DO: {
          getByName: (id: string) =>
            id === first.owner.id
              ? {
                  presenceCandidates: async () => {
                    throw new Error("owner unavailable");
                  },
                }
              : h.environment.SERVER_DO.getByName(id),
        } as unknown as Env["SERVER_DO"],
        EVENT_DISPATCH: {
          getByName: () => ({
            samplePresence: async () => {
              throw new Error("hub unavailable");
            },
          }),
        } as unknown as Env["EVENT_DISPATCH"],
      },
      identity(operator.profile!.userId),
      { scopes: [{ owner: first.owner }, { owner: second.owner }] },
    );
    if (unavailable.kind !== "presence") throw new Error(unavailable.kind);
    expect(unavailable.scopes[0]).toEqual({
      kind: "unavailable",
      owner: first.owner,
    });
    const partial = unavailable.scopes[1]!;
    if (partial.kind !== "sampled") throw new Error(partial.kind);
    expect(partial.samples.every((sample) => sample.state === "unknown")).toBe(
      true,
    );
  });

  it("rejects a result when the original authority expires during hub I/O", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const principal = identity(operator.profile!.userId);
    principal.verifiedAt = Date.now() - 29_900;
    const environment = {
      ...h.environment,
      EVENT_DISPATCH: {
        getByName: () => ({
          samplePresence: async () => {
            await new Promise((resolve) => setTimeout(resolve, 180));
            return { kind: "presence_samples", samples: [] };
          },
        }),
      } as unknown as Env["EVENT_DISPATCH"],
    };
    expect(
      await sampleOwnerPresence(environment, principal, {
        scopes: [{ owner: server.owner }],
      }),
    ).toEqual({ kind: "unauthenticated" });
  });
});

it("discovers 16 mixed presence scopes with one native D1 query while preserving duplicate page cursors", async () => {
  const h = applicationHarness();
  const operator = await h.bootstrap();
  const server = await h.createServer(operator);
  const userId = operator.profile!.userId;
  const dm = { kind: "conversation" as const, id: crypto.randomUUID() };
  await h.environment.CONVERSATION_DO.getByName(dm.id).initialize({
    conversationId: dm.id,
    participantIds: [userId, crypto.randomUUID()],
  });
  const pending = { kind: "server" as const, id: crypto.randomUUID() };
  for (const [owner, lifecycle] of [
    [dm, "ready"],
    [pending, "pending"],
  ] as const) {
    await h.environment.IDENTITY_DB.prepare(
      "INSERT INTO resource_directory(id,kind,name,creator_id,lifecycle,payload_hash,created_at) VALUES (?,?,'Presence fixture',?,?,'fixture',0)",
    )
      .bind(owner.id, owner.kind, userId, lifecycle)
      .run();
  }
  const actor = h.environment.SERVER_DO.getByName(server.owner.id);
  await runInDurableObject(actor, (_instance, state) => {
    for (let index = 0; index < PRESENCE_MEMBER_PAGE_SIZE + 3; index++)
      state.storage.sql.exec(
        "INSERT INTO members(user_id,role) VALUES (?,'member')",
        crypto.randomUUID(),
      );
  });
  const first = await actor.presenceCandidates(identity(userId));
  if (first.kind !== "presence_candidates") throw new Error(first.kind);
  const second = await actor.presenceCandidates(identity(userId), {
    after: first.nextCursor!,
  });
  if (second.kind !== "presence_candidates") throw new Error(second.kind);
  const scopes: PresenceRequest["scopes"] = [
    { owner: server.owner },
    { owner: dm },
    { owner: pending },
    { owner: { kind: "server", id: crypto.randomUUID() } },
    { owner: { kind: "conversation", id: server.owner.id } },
    { owner: server.owner, after: first.nextCursor! },
    ...Array.from({ length: 10 }, () => ({ owner: dm })),
  ];
  const session = h.environment.IDENTITY_DB.withSession("first-unconstrained");
  const prepare = vi.spyOn(session, "prepare");
  try {
    const result = PresenceOutcomeSchema.parse(
      await sampleOwnerPresence(
        h.environment,
        identity(userId),
        { scopes },
        session,
      ),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    if (result.kind !== "presence") throw new Error(result.kind);
    expect(result.scopes.map((scope) => scope.owner)).toEqual(
      scopes.map((scope) => scope.owner),
    );
    expect(result.scopes.map((scope) => scope.kind)).toEqual([
      "sampled",
      "sampled",
      "denied",
      "denied",
      "denied",
      ...Array(11).fill("sampled"),
    ]);
    expect(result.scopes[0]).toMatchObject({
      nextCursor: first.nextCursor,
      samples: first.userIds.map((userId) =>
        expect.objectContaining({ userId }),
      ),
    });
    expect(result.scopes[5]).toMatchObject({
      nextCursor: second.nextCursor,
      samples: second.userIds.map((userId) =>
        expect.objectContaining({ userId }),
      ),
    });
  } finally {
    prepare.mockRestore();
  }
});

// Inject directory wait failures at the native session boundary. Late results
// must never start owner calls, even if those directory rows would be ready.
function directoryWait(session: D1DatabaseSession, wait: () => Promise<void>) {
  const prepare = session.prepare.bind(session);
  return vi.spyOn(session, "prepare").mockImplementation((query) => {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...values: unknown[]) => wrap(target.bind(...values));
          if (property === "all")
            return async () => {
              const result = await target.all();
              await wait();
              return result;
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    return wrap(prepare(query));
  });
}

it.each(["exception", "timeout"] as const)(
  "marks the whole presence page unavailable after directory %s and discards late discovery",
  async (failure) => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const session = h.environment.IDENTITY_DB.withSession(
      "first-unconstrained",
    );
    const entered = barrier(),
      release = barrier(),
      settled = barrier();
    const lookup = directoryWait(session, async () => {
      entered.release();
      if (failure === "exception") throw new Error("directory unavailable");
      await release.promise;
      settled.release();
    });
    const candidate = vi.fn(async () => ({
      kind: "presence_candidates",
      userIds: [],
      nextCursor: null,
    }));
    const dispatch = vi
      .spyOn(h.environment.SERVER_DO, "getByName")
      .mockReturnValue({
        presenceCandidates: candidate,
      } as unknown as ReturnType<Env["SERVER_DO"]["getByName"]>);
    try {
      const scopes = [
        { owner: server.owner },
        { owner: { kind: "server" as const, id: crypto.randomUUID() } },
      ];
      const read = sampleOwnerPresence(
        h.environment,
        identity(operator.profile!.userId),
        { scopes },
        session,
      );
      await entered.promise;
      expect(await read).toEqual({
        kind: "presence",
        scopes: scopes.map(({ owner }) => ({ kind: "unavailable", owner })),
      });
      expect(dispatch).not.toHaveBeenCalled();
      if (failure === "timeout") {
        release.release();
        await settled.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(candidate).not.toHaveBeenCalled();
      }
    } finally {
      release.release();
      lookup.mockRestore();
      dispatch.mockRestore();
    }
  },
  ACTOR_RPC_TIMEOUT_MS + 10_000,
);

it.each(["during-discovery", "work-budget"] as const)(
  "does not dispatch presence owners after %s",
  async (stage) => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const session = h.environment.IDENTITY_DB.withSession(
      "first-unconstrained",
    );
    const principal = identity(operator.profile!.userId);
    const now = Date.now();
    // Keep spy setup time from moving the deadline beyond the 1 ms boundary.
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const lookup = directoryWait(session, async () => {
      clock.mockReturnValue(now + (stage === "work-budget" ? 5_001 : 30_001));
    });
    const candidate = vi.fn(async () => ({
      kind: "presence_candidates",
      userIds: [],
      nextCursor: null,
    }));
    const dispatch = vi
      .spyOn(h.environment.SERVER_DO, "getByName")
      .mockReturnValue({
        presenceCandidates: candidate,
      } as unknown as ReturnType<Env["SERVER_DO"]["getByName"]>);
    try {
      expect(
        await sampleOwnerPresence(
          h.environment,
          principal,
          { scopes: [{ owner: server.owner }] },
          session,
        ),
      ).toEqual(
        stage === "work-budget"
          ? {
              kind: "presence",
              scopes: [{ kind: "unavailable", owner: server.owner }],
            }
          : { kind: "unauthenticated" },
      );
      expect(candidate).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      lookup.mockRestore();
      dispatch.mockRestore();
    }
  },
);
