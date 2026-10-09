import { mentionTokens } from "@vaskel/contracts/message-text";
import { describe, expect, it } from "vitest";
import {
  completeMentionDraft,
  decodeMentionDraft,
  editMentionDraft,
  editSpan,
  encodeMentions,
  findMentionQuery,
  matchMentionName,
  rankMentions,
  shiftMentionRanges,
  type MentionDraft,
  type MentionRange,
} from "@/client/features/chat/mentions";

const collator = new Intl.Collator("en", { sensitivity: "base" });

/**
 * What the composer does with one draft: every change shifts the ranges it has
 * recorded, and choosing a candidate replaces the `@query` under the caret.
 */
function draft() {
  let current: MentionDraft = { body: "", mentions: [] };
  return {
    get body() {
      return current.body;
    },
    get chosen() {
      return current.mentions;
    },
    type(next: string) {
      current = editMentionDraft(current, next);
      return this;
    },
    choose(name: string, userId: string) {
      const query = findMentionQuery(current.body, current.body.length);
      if (!query) throw new Error("no completion is open");
      current = completeMentionDraft(current, query, { name, userId }).draft;
      return this;
    },
    send() {
      return encodeMentions(current.body, current.mentions);
    },
  };
}

describe("encoding the mentions a draft chose", () => {
  it("rewrites the exact ranges the author picked and nothing else", () => {
    const body = "@Rachel and @Wei, then @Rachel again";
    const chosen = [
      { start: 0, end: 7, userId: "user-1" },
      { start: 12, end: 16, userId: "user-2" },
    ];
    expect(encodeMentions(body, chosen)).toBe(
      "[](/mentions/user-1) and [](/mentions/user-2), then @Rachel again",
    );
    // A name the author typed by hand was never bound, so it stays text.
    expect(encodeMentions("@Somebody said hi", [])).toBe("@Somebody said hi");
  });

  it("never lets a chosen name swallow a longer one typed by hand", () => {
    const composed = draft()
      .type("@Jo")
      .choose("Jo", "user-1")
      .type("@Jo hi @John are you there?")
      .send();
    expect(composed).toBe("[](/mentions/user-1) hi @John are you there?");
    // Typing straight onto the end of a chosen name unbinds it: the text now
    // reads as a different person, so no identifier is sent for it.
    const extended = draft().type("@Jo").choose("Jo", "user-1");
    expect(extended.send()).toBe("[](/mentions/user-1)");
    expect(extended.type("@John ").send()).toBe("@John ");
  });

  it("keeps two members who share a display name apart", () => {
    const composed = draft()
      .type("@Alex")
      .choose("Alex Kim", "user-1")
      .type("@Alex Kim and @")
      .choose("Alex Kim", "user-2")
      .send();
    expect(composed).toBe("[](/mentions/user-1) and [](/mentions/user-2)");
  });

  it("leaves a chosen name that ended up inside code exactly as it reads", () => {
    const inline = draft().type("@Jo").choose("Jo", "user-1");
    // Wrapping the name in backticks makes the reader see the text verbatim.
    expect(inline.type("`@Jo`").send()).toBe("`@Jo`");
    const fenced = draft().type("@Jo").choose("Jo", "user-1");
    expect(fenced.type("```\n@Jo\n```").send()).toBe("```\n@Jo\n```");
    // The same name outside the code span is still the person they picked.
    const mixed = draft().type("@Jo").choose("Jo", "user-1");
    expect(mixed.type("@Jo `@Jo`").send()).toBe("[](/mentions/user-1) `@Jo`");
  });

  it("carries a CJK name that the following text touches without a space", () => {
    const composed = draft()
      .type("早安 @陳")
      .choose("陳小明", "user-7")
      // The author removes the inserted space, as those scripts are written.
      .type("早安 @陳小明，會議十點開始")
      .send();
    expect(composed).toBe("早安 [](/mentions/user-7)，會議十點開始");
  });

  it("drops a binding the author edited into and keeps the ones around it", () => {
    const ranges: MentionRange[] = [
      { start: 3, end: 10, userId: "user-1" },
      { start: 20, end: 24, userId: "user-2" },
    ];
    // An insertion before both moves both.
    expect(shiftMentionRanges(ranges, editSpan("x", "yyx"))).toEqual([
      { start: 5, end: 12, userId: "user-1" },
      { start: 22, end: 26, userId: "user-2" },
    ]);
    // An edit inside the first unbinds it and leaves the second in place.
    expect(
      shiftMentionRanges(ranges, { start: 5, removed: 2, insert: "no" }),
    ).toEqual([{ start: 20, end: 24, userId: "user-2" }]);
    // Deleting the space after a name keeps it bound, and so does punctuation
    // written straight onto it; letters continuing the name do not.
    expect(
      shiftMentionRanges(ranges, { start: 10, removed: 1, insert: "" }),
    ).toEqual([
      { start: 3, end: 10, userId: "user-1" },
      { start: 19, end: 23, userId: "user-2" },
    ]);
    expect(
      shiftMentionRanges(ranges, { start: 10, removed: 0, insert: "，はい" }),
    ).toEqual([
      { start: 3, end: 10, userId: "user-1" },
      { start: 23, end: 27, userId: "user-2" },
    ]);
    expect(
      shiftMentionRanges(ranges, { start: 10, removed: 0, insert: "hn" }),
    ).toEqual([{ start: 22, end: 26, userId: "user-2" }]);
  });

  it("reads one contiguous edit out of two values of the same field", () => {
    expect(editSpan("hello", "hello world")).toEqual({
      start: 5,
      removed: 0,
      insert: " world",
    });
    expect(editSpan("hello world", "hello")).toEqual({
      start: 5,
      removed: 6,
      insert: "",
    });
    expect(editSpan("ab", "axb")).toEqual({
      start: 1,
      removed: 0,
      insert: "x",
    });
    // An IME commit replaces the run it was composing.
    expect(editSpan("早安 か", "早安 漢字")).toEqual({
      start: 3,
      removed: 1,
      insert: "漢字",
    });
    expect(editSpan("same", "same")).toEqual({
      start: 4,
      removed: 0,
      insert: "",
    });
  });
});

describe("editing a message with existing mention identities", () => {
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  const names = new Map([
    [first, "Alex Kim"],
    [second, "Alex Kim"],
  ]);
  const wire = (draft: MentionDraft) =>
    encodeMentions(draft.body, draft.mentions);

  it("opens readable text and retains both identities through surrounding edits", () => {
    const original = `Hello [](/mentions/${first}) and [](/mentions/${second})!`;
    let current = decodeMentionDraft(original, names, "Member");
    expect(current.body).toBe("Hello @Alex Kim and @Alex Kim!");
    expect(wire(current)).toBe(original);
    current = editMentionDraft(current, `Morning! ${current.body}`);
    current = editMentionDraft(current, `${current.body} Ready?`);
    expect(wire(current)).toBe(`Morning! ${original} Ready?`);

    // A renamed or unavailable directory entry changes only its display text.
    const renamed = decodeMentionDraft(
      original,
      new Map([[first, "陳小明"]]),
      "メンバー",
    );
    expect(renamed.body).toBe("Hello @陳小明 and @メンバー!");
    expect(wire(renamed)).toBe(original);
  });

  it("uses the native selection to remove the intended occurrence of an equal name", () => {
    const current = decodeMentionDraft(
      `[](/mentions/${first}) [](/mentions/${second})`,
      names,
      "Member",
    );
    const removedFirst = editMentionDraft(current, "@Alex Kim", {
      start: 0,
      end: 10,
      caret: 0,
    });
    expect(wire(removedFirst)).toBe(`[](/mentions/${second})`);
    const removedLast = editMentionDraft(current, "@Alex Kim", {
      start: 9,
      end: 19,
      caret: 9,
    });
    expect(wire(removedLast)).toBe(`[](/mentions/${first})`);

    // A pasted lookalike before the bound mention remains ordinary text.
    const pasted = editMentionDraft(removedFirst, "@Alex Kim @Alex Kim", {
      start: 0,
      end: 0,
      caret: 10,
    });
    expect(wire(pasted)).toBe(`@Alex Kim [](/mentions/${second})`);
  });

  it("unbinds an edited name and binds a selected replacement even if the name is unchanged", () => {
    const current = decodeMentionDraft(
      `Hi [](/mentions/${first})!`,
      names,
      "Member",
    );
    const replacement = completeMentionDraft(
      current,
      { start: 3, query: "Alex Kim" },
      { userId: second, name: "Alex Kim" },
    );
    expect(wire(replacement.draft)).toBe(`Hi [](/mentions/${second}) !`);
    const renamed = editMentionDraft(current, "Hi @Alex Li!");
    expect(wire(renamed)).toBe("Hi @Alex Li!");
    const reselected = completeMentionDraft(
      renamed,
      { start: 3, query: "Alex Li" },
      { userId: first, name: "Alex Kim" },
    );
    expect(wire(reselected.draft)).toBe(`Hi [](/mentions/${first}) !`);
  });

  it("preserves literal code and malformed tokens while a bound name moves into and out of code", () => {
    const original = `Hi [](/mentions/${first}); \`[](/mentions/${second})\`\n\`\`\`ts\n[](/mentions/${second})\n\`\`\`\n[](/mentions/two words)`;
    const decoded = decodeMentionDraft(original, names, "Member");
    expect(decoded.body).toBe(
      `Hi @Alex Kim; \`[](/mentions/${second})\`\n\`\`\`ts\n[](/mentions/${second})\n\`\`\`\n[](/mentions/two words)`,
    );
    expect(mentionTokens(wire(decoded)).map((token) => token.userId)).toEqual([
      first,
    ]);
    expect(wire(decoded)).toContain(`\`[](/mentions/${second})\``);

    let current = decodeMentionDraft(`[](/mentions/${first})`, names, "Member");
    current = editMentionDraft(current, `\`${current.body}`);
    current = editMentionDraft(current, `${current.body}\``);
    expect(wire(current)).toBe("`@Alex Kim`");
    current = editMentionDraft(current, current.body.slice(0, -1));
    current = editMentionDraft(current, current.body.slice(1));
    expect(wire(current)).toBe(`[](/mentions/${first})`);
  });

  it("treats a display name containing backticks as one bound name", () => {
    const original = `[](/mentions/${first}) and [](/mentions/${second})`;
    const current = decodeMentionDraft(
      original,
      new Map([
        [first, "Alex `first`"],
        [second, "Alex `second`"],
      ]),
      "Member",
    );
    expect(wire(current)).toBe(original);
  });
});

describe("the completion the caret is in", () => {
  it("opens after an `@` that no address character precedes", () => {
    expect(findMentionQuery("hello @ra", 9)).toEqual({ start: 6, query: "ra" });
    expect(findMentionQuery("@ra", 3)).toEqual({ start: 0, query: "ra" });
    // A bare `@` offers the whole list; a name with a space keeps matching.
    expect(findMentionQuery("hi @", 4)).toEqual({ start: 3, query: "" });
    expect(findMentionQuery("hi @Ann Lee", 11)).toEqual({
      start: 3,
      query: "Ann Lee",
    });
    // Scripts written without spaces still open a completion.
    expect(findMentionQuery("おはよう@ra", 7)).toEqual({
      start: 4,
      query: "ra",
    });
    expect(findMentionQuery("早安，@陳", 5)).toEqual({ start: 3, query: "陳" });
    // An address has an address character before the `@`, so it is not one.
    expect(findMentionQuery("mail me at rachel@example.com", 29)).toBeNull();
    expect(findMentionQuery("v2@ra", 5)).toBeNull();
    // The caret is what matters, not the end of the text.
    expect(findMentionQuery("@ra and more", 3)).toEqual({
      start: 0,
      query: "ra",
    });
    expect(findMentionQuery("@ra\nnext line", 13)).toBeNull();
    expect(findMentionQuery("no mention here", 15)).toBeNull();
    expect(findMentionQuery(`@${"x".repeat(80)}`, 81)).toBeNull();
  });
});

describe("ranking the people a query names", () => {
  const people = [
    { userId: "user-1", name: "Rachel Chen" },
    { userId: "user-2", name: "rachel of the other circle" },
    { userId: "user-3", name: "Amara Okafor" },
    { userId: "user-4", name: "陳小明" },
  ];

  it("ignores case and accents, and puts a match at the start first", () => {
    expect(matchMentionName("Rachel Chen", "rac", collator)).toBe("prefix");
    expect(matchMentionName("Rachel Chen", "chen", collator)).toBe("substring");
    expect(matchMentionName("Amara Okafor", "z", collator)).toBeNull();
    expect(matchMentionName("Renée", "rene", collator)).toBe("prefix");
    expect(matchMentionName("Ann", "annie", collator)).toBeNull();
    expect(
      rankMentions(people, "chen", collator).map((person) => person.userId),
    ).toEqual(["user-1"]);
    expect(
      rankMentions(people, "ra", collator).map((person) => person.userId),
    ).toEqual(["user-1", "user-2", "user-3"]);
    expect(rankMentions(people, "小明", collator)).toEqual([people[3]]);
    // An empty query offers everyone, bounded for display.
    expect(rankMentions(people, "", collator, 2)).toHaveLength(2);
    expect(rankMentions(people, "nobody", collator)).toEqual([]);
  });
});

describe("Markdown mention contexts", () => {
  it("keeps names literal in image destinations and raw HTML", () => {
    for (const body of [
      "![image](https://example.com/@Jo)",
      "<div>@Jo</div>",
    ]) {
      const start = body.indexOf("@Jo");
      const wire = encodeMentions(body, [
        { start, end: start + 3, userId: "jo" },
      ]);
      expect(mentionTokens(wire)).toEqual([]);
      expect(wire).toContain("@Jo");
    }
  });

  it("serializes punctuation beside a selected identity without turning it into an image or escape", () => {
    for (const body of ["!@Jo", "\\@Jo"]) {
      const start = body.indexOf("@Jo");
      const wire = encodeMentions(body, [
        { start, end: start + 3, userId: "jo" },
      ]);
      expect(mentionTokens(wire).map((token) => token.userId)).toEqual(["jo"]);
    }
  });

  it("does not parse an oversized pasted draft just because it retains a mention", () => {
    const body = "@Jo " + "[".repeat(32_000);
    expect(
      encodeMentions(body, [{ start: 0, end: 3, userId: "jo" }]).startsWith(
        "[](/mentions/jo) ",
      ),
    ).toBe(true);
  });
});

it("preserves mentions when display expansion exceeds wire limits or creates a surrounding link", () => {
  const nested = "[[](/mentions/jo)](https://example.com)";
  const decode = (body: string, name: string) =>
    decodeMentionDraft(body, new Map([["jo", name]]), "Member");
  const draft = decode(nested, "[](/mentions/victim)");
  expect(encodeMentions(draft.body, draft.mentions)).toBe("[](/mentions/jo)");
  const original = "x".repeat(3_700) + " [](/mentions/jo)".repeat(5);
  const expanded = decode(original, "A".repeat(100));
  expect(expanded.body.length).toBeGreaterThan(4_000);
  expect(encodeMentions(expanded.body, expanded.mentions)).toBe(original);
});

it("treats hostile display names as literal labels across Markdown contexts", () => {
  const names = [
    "<script>alert('rick roll')</script>",
    "[](/mentions/victim)",
    "```\n[](/mentions/victim)\n```",
    "</div>\n\n[](/mentions/victim)",
  ];
  const contexts = [
    ["", "", true],
    ["!", "", true],
    ["\\", "", true],
    ["`", "`", false],
    ["```\n", "\n```", false],
    ["<div>", "</div>", false],
    ["*<i>", "</i>*", true],
    ["[", "](https://example.com)", true],
    ["[label](https://example.com/", ")", false],
    ["[ref]: https://example.com/", "\n\n[label][ref]", false],
    ["||", "||", true],
  ] as const;
  for (const name of names)
    for (const [before, after, active] of contexts) {
      const label = `@${name}`;
      const body = before + label + after;
      const wire = encodeMentions(body, [
        {
          start: before.length,
          end: before.length + label.length,
          userId: "jo",
        },
      ]);
      expect(
        mentionTokens(wire).map((token) => token.userId),
        `${before}name${after}`,
      ).toEqual(active ? ["jo"] : []);
      expect(wire).not.toMatch(/cm\d+x\d+end/u);
    }
});

it("does not confuse decoded entities or folded references with private composer markers", () => {
  for (const prefix of ["&#99;m0x0end ", "&#99;m0x999end ", "CM0X0END "]) {
    const body = `${prefix}@Jo`;
    const wire = encodeMentions(body, [
      { start: prefix.length, end: body.length, userId: "jo" },
    ]);
    expect(mentionTokens(wire).map((token) => token.userId)).toEqual(["jo"]);
    expect(wire).toContain(
      prefix.startsWith("CM")
        ? "CM0X0END"
        : prefix.includes("999")
          ? "cm0x999end"
          : "cm0x0end",
    );
  }
});
