import type { REACTION_EMOJIS } from "@vaskel/contracts/messaging";
import type { Hue } from "@vaskel/ui/components/avatar";

/**
 * The circle the preview shows: a Friday night in "Loft". Display names follow
 * how people actually name themselves in small friend servers; hues come from
 * the app's eight-hue set, chosen so the five people in the call differ.
 */
export type Person = { name: string; hue: Hue };

export const people = {
  wren: { name: "wren", hue: 200 },
  soren: { name: "s0ren", hue: 110 },
  cass: { name: "Cass", hue: 250 },
  tangyuan: { name: "汤圆", hue: 60 },
  oolong: { name: "烏龍半糖", hue: 340 },
  shirasu: { name: "しらす", hue: 25 },
} satisfies Record<string, Person>;

export type PersonKey = keyof typeof people;

export type Message = {
  author: PersonKey;
  at: string;
  body: string;
  quote?: { author: PersonKey; at: string; body: string };
  /** Reactions come from the app's fixed palette (REACTION_EMOJIS). */
  reactions?: {
    emoji: (typeof REACTION_EMOJIS)[number];
    count: number;
    mine?: boolean;
  }[];
};

export type Room = "general" | "memes" | "lounge" | "shirasu";

export const circle = { name: "Loft", initial: "L" };

export const call = {
  room: "Lounge",
  duration: "42:10",
  sharer: "soren" as PersonKey,
  participants: ["soren", "wren", "oolong", "tangyuan", "cass"] as PersonKey[],
  muted: ["oolong"] as PersonKey[],
};

export const online: PersonKey[] = ["soren", "oolong", "tangyuan", "cass"];

export const transcripts: Record<Exclude<Room, "lounge">, Message[]> = {
  general: [
    {
      author: "cass",
      at: "2026-09-18T20:58:00",
      body: "pizza's here, call in five?",
    },
    { author: "tangyuan", at: "2026-09-18T21:02:00", body: "推一下我看看 👀" },
    {
      author: "soren",
      at: "2026-09-18T21:03:00",
      body: "pushing now, watch the share",
    },
    {
      author: "soren",
      at: "2026-09-18T21:03:30",
      body: "if this goes green I'm done for tonight",
    },
    {
      author: "oolong",
      at: "2026-09-18T21:05:00",
      body: "一小時前你也這樣說 🙂",
      quote: {
        author: "soren",
        at: "2026-09-18T21:03:30",
        body: "if this goes green I'm done for tonight",
      },
      reactions: [
        { emoji: "😂", count: 3, mine: true },
        { emoji: "👀", count: 1 },
      ],
    },
  ],
  memes: [
    {
      author: "cass",
      at: "2026-09-18T18:40:00",
      body: "soren's test suite, live footage:",
    },
    {
      author: "cass",
      at: "2026-09-18T18:40:20",
      body: "🐢🐢🐢🐢🐢",
      reactions: [
        { emoji: "😢", count: 4 },
        { emoji: "😂", count: 2, mine: true },
      ],
    },
    { author: "tangyuan", at: "2026-09-18T18:42:00", body: "笑死，我截图了" },
    {
      author: "soren",
      at: "2026-09-18T20:51:00",
      body: "the turtles are in the commit message now. you did this.",
    },
    { author: "oolong", at: "2026-09-18T20:52:00", body: "🫡" },
  ],
  shirasu: [
    { author: "shirasu", at: "2026-09-18T20:41:00", body: "今夜くる？" },
    {
      author: "shirasu",
      at: "2026-09-18T20:41:30",
      body: "we're waiting on soren's build 🙃",
    },
    {
      author: "wren",
      at: "2026-09-18T20:43:00",
      body: "in! reading the thread first",
    },
    {
      author: "shirasu",
      at: "2026-09-18T21:04:00",
      body: "了解、9時ね。土曜も集まる？",
    },
  ],
};

/** Where the unread marker sits: the first message the viewer has not read. */
export const unreadFrom: Partial<Record<Room, string>> = {
  memes: "2026-09-18T20:51:00",
  shirasu: "2026-09-18T21:04:00",
};

/** Two messages that arrive in #general after the page opens. */
export const arrivals: {
  author: PersonKey;
  at: string;
  body: string;
  after: number;
}[] = [
  {
    author: "tangyuan",
    at: "2026-09-18T21:06:00",
    body: "绿了绿了绿了 🟢",
    after: 3000,
  },
  {
    author: "soren",
    at: "2026-09-18T21:06:20",
    body: "ok merging. nobody touch anything",
    after: 6000,
  },
];

/** Messages closer than five minutes from the same author share one header. */
export function grouped(previous: Message | undefined, message: Message) {
  return (
    previous !== undefined &&
    previous.author === message.author &&
    new Date(message.at).getTime() - new Date(previous.at).getTime() <
      5 * 60 * 1000
  );
}
