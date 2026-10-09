/**
 * Interface strings the preview switches between, copied verbatim from the
 * client's catalogs (apps/client/src/features/i18n/locales). The site's tests
 * compare them against those files so the preview cannot drift.
 */
export const LANGUAGES = ["en", "zh-Hans", "zh-Hant", "ja"] as const;
export type Language = (typeof LANGUAGES)[number];

type Catalog = Record<Language, string>;

export const STRINGS = {
  "search.title": {
    en: "Search messages",
    "zh-Hans": "搜索消息",
    "zh-Hant": "搜尋訊息",
    ja: "メッセージを検索",
  },
  "workspace.happeningNow": {
    en: "Happening now",
    "zh-Hans": "现在进行中",
    "zh-Hant": "現在進行中",
    ja: "進行中",
  },
  "workspace.inTheCall": {
    en: "{count} in the call",
    "zh-Hans": "{count} 人在通话中",
    "zh-Hant": "{count} 人在通話中",
    ja: "{count} 人が通話中",
  },
  "workspace.isSharing": {
    en: "{name} is sharing",
    "zh-Hans": "{name} 正在共享屏幕",
    "zh-Hant": "{name} 正在分享畫面",
    ja: "{name} が画面共有中",
  },
  "activity.unread": {
    en: "Unread",
    "zh-Hans": "未读",
    "zh-Hant": "未讀",
    ja: "未読",
  },
  "workspace.servers": {
    en: "Your circles",
    "zh-Hans": "你的圈子",
    "zh-Hant": "你的圈子",
    ja: "参加中のサークル",
  },
  "workspace.people": {
    en: "People",
    "zh-Hans": "成员",
    "zh-Hant": "成員",
    ja: "メンバー",
  },
  "workspace.onlineCount": {
    en: "{count} online",
    "zh-Hans": "{count} 人在线",
    "zh-Hant": "{count} 人線上",
    ja: "{count} 人がオンライン",
  },
  "workspace.directMessages": {
    en: "Direct messages",
    "zh-Hans": "私信",
    "zh-Hant": "私訊",
    ja: "DM",
  },
  "media.participantCount": {
    en: "{count} in call",
    "zh-Hans": "{count} 人正在通话",
    "zh-Hant": "{count} 人通話中",
    ja: "{count}人が通話中",
  },
  "media.openRoom": {
    en: "Open",
    "zh-Hans": "打开",
    "zh-Hant": "開啟",
    ja: "開く",
  },
  "media.atTheTable": {
    en: "In the call",
    "zh-Hans": "通话中",
    "zh-Hant": "通話中",
    ja: "通話中",
  },
  "media.screens": {
    en: "Screens",
    "zh-Hans": "屏幕",
    "zh-Hant": "螢幕",
    ja: "共有画面",
  },
  "media.voiceChannelName": {
    en: "{name} · Voice room",
    "zh-Hans": "{name} · 语音聊天室",
    "zh-Hant": "{name} · 語音聊天室",
    ja: "{name}・ボイスルーム",
  },
  "media.pictureInPicture": {
    en: "Picture in picture",
    "zh-Hans": "画中画",
    "zh-Hant": "子母畫面",
    ja: "ピクチャインピクチャ",
  },
  "media.leave": {
    en: "Leave",
    "zh-Hans": "离开",
    "zh-Hant": "離開",
    ja: "退出",
  },
  "media.yourName": {
    en: "{name} (you)",
    "zh-Hans": "{name}（你）",
    "zh-Hant": "{name}（你）",
    ja: "{name}（自分）",
  },
  "chat.messageTo": {
    en: "Message {label}",
    "zh-Hans": "发送消息至 {label}",
    "zh-Hant": "傳送訊息至 {label}",
    ja: "{label} にメッセージを送信",
  },
  "chat.composerShortcut": {
    en: "Shift + Enter to send",
    "zh-Hans": "Shift + Enter 发送",
    "zh-Hant": "按 Shift + Enter 傳送",
    ja: "Shift + Enter で送信",
  },
  "chat.send": {
    en: "Send",
    "zh-Hans": "发送",
    "zh-Hant": "傳送",
    ja: "送信",
  },
  "chat.typing": {
    en: "{names} is typing…",
    "zh-Hans": "{names} 正在输入…",
    "zh-Hant": "{names} 正在輸入…",
    ja: "{names} が入力中…",
  },
  "blocking.options": {
    en: "Options",
    "zh-Hans": "选项",
    "zh-Hant": "選項",
    ja: "オプション",
  },
  "chat.directConversation": {
    en: "Direct message",
    "zh-Hans": "私信对话",
    "zh-Hant": "私訊對話",
    ja: "DM",
  },
  "chat.invite": {
    en: "Invite",
    "zh-Hans": "邀请",
    "zh-Hant": "邀請",
    ja: "招待",
  },
  "chat.moreActions": {
    en: "More",
    "zh-Hans": "更多",
    "zh-Hant": "更多",
    ja: "その他",
  },
  "chat.openConversations": {
    en: "Open conversations",
    "zh-Hans": "打开对话列表",
    "zh-Hant": "開啟對話清單",
    ja: "会話一覧を開く",
  },
  "chat.openOriginal": {
    en: "Open original",
    "zh-Hans": "打开原消息",
    "zh-Hant": "開啟原始訊息",
    ja: "元のメッセージを開く",
  },
  "chat.quotedReply": {
    en: "Quoted message",
    "zh-Hans": "引用的消息",
    "zh-Hant": "引用的訊息",
    ja: "引用メッセージ",
  },
  "chat.search": {
    en: "Search",
    "zh-Hans": "搜索",
    "zh-Hant": "搜尋",
    ja: "検索",
  },
  "media.camera": {
    en: "Camera",
    "zh-Hans": "摄像头",
    "zh-Hant": "攝影機",
    ja: "カメラ",
  },
  "media.deafenSelf": {
    en: "Deafen",
    "zh-Hans": "拒听",
    "zh-Hant": "拒聽",
    ja: "スピーカーをミュート",
  },
  "media.devices": {
    en: "Devices",
    "zh-Hans": "设备",
    "zh-Hant": "裝置",
    ja: "デバイス",
  },
  "media.inCall": {
    en: "In call",
    "zh-Hans": "通话中",
    "zh-Hant": "通話中",
    ja: "通話中",
  },
  "media.joinCall": {
    en: "Join call",
    "zh-Hans": "加入通话",
    "zh-Hant": "加入通話",
    ja: "通話に参加",
  },
  "media.mute": {
    en: "Mute",
    "zh-Hans": "静音",
    "zh-Hant": "靜音",
    ja: "ミュート",
  },
  "media.mutedByOwner": {
    en: "Muted by owner",
    "zh-Hans": "已被圈主静音",
    "zh-Hant": "已被圈主靜音",
    ja: "主催者によりミュート中",
  },
  "media.nowPlaying": {
    en: "Current call",
    "zh-Hans": "当前通话",
    "zh-Hant": "目前的通話",
    ja: "現在の通話",
  },
  "media.shareScreen": {
    en: "Share screen",
    "zh-Hans": "共享屏幕",
    "zh-Hant": "分享螢幕",
    ja: "画面を共有",
  },
  "media.speaking": {
    en: "Speaking",
    "zh-Hans": "正在说话",
    "zh-Hant": "正在說話",
    ja: "発言中",
  },
  "workspace.closeConversations": {
    en: "Close conversations",
    "zh-Hans": "关闭对话列表",
    "zh-Hant": "關閉對話清單",
    ja: "会話一覧を閉じる",
  },
  "workspace.unreadCount": {
    en: "{count} unread",
    "zh-Hans": "{count} 条未读",
    "zh-Hant": "{count} 則未讀",
    ja: "未読 {count} 件",
  },
  "workspace.voiceChannel": {
    en: "Voice room",
    "zh-Hans": "语音聊天室",
    "zh-Hant": "語音聊天室",
    ja: "ボイスルーム",
  },
  "workspace.youAreIn": {
    en: "You’re in",
    "zh-Hans": "你在通话中",
    "zh-Hant": "你在通話中",
    ja: "参加中",
  },
} satisfies Record<string, Catalog>;

export type StringKey = keyof typeof STRINGS;

/** Fills `{placeholders}` the way the app's catalog messages do. */
export function t(
  language: Language,
  key: StringKey,
  values: Record<string, string | number> = {},
) {
  return STRINGS[key][language].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values[name] ?? ""),
  );
}

/** The timeline's day marker for today, as the app formats it. */
export function today(language: Language) {
  return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(
    0,
    "day",
  );
}
