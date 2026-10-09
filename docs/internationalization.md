# Language, Unicode and input

Chinese, Japanese and Korean content/input are core requirements. UI catalogs
are English, Simplified Chinese, Traditional Chinese and Japanese; Korean
translation and RTL are outside launch scope.

## Search contract

Body search uses one literal quoted query through native FTS5 trigram, with a
minimum of **three Unicode code points**. One/two-character `東京`, `设计` and
`공부` need an honest minimum-length explanation, not an unindexed fallback.
Short title/member pickers use separate bounded substring matching. UTF-16
string length is not the minimum-length rule; supplementary Han makes that
distinction observable.

Keep original text intact and native tokenizer analysis. No width/kana
conversion, Simplified/Traditional equivalence, transliteration or stemming is
adopted. A future analysis change needs separate derived text, matching
versioned ingest/query behavior and an index rebuild; UI language cannot choose
the index policy for a multilingual room. Permission filtering precedes
snippets/counts, and edits/deletion update FTS inside the message transaction.
[Messaging](messaging.md#search-admission-and-continuation) owns fanout and
continuation.

[Native tokenizer tests](../apps/server/tests/database-boundary.test.ts) cover
Chinese/Japanese/Korean, mixed script, literal FTS syntax and supplementary Han.
The selected trigram policy matches `東京都` within `東京都で会議を開催します`;
neither trigram nor default `unicode61` matches the shorter `東京` there. The
default tokenizer does not supply CJK linguistic segmentation.
[SQLite tokenizer contract](https://www.sqlite.org/fts5.html#tokenizers)

The [pinned bland reference](sources.json) uses literal trigram body search and
separate client title matching, but checks its minimum in UTF-16 units. vaskel.
uses Unicode code points. Measure representative relevance, index growth, write
amplification and latency before changing analysis; the tokenizer fixtures do
not establish those results.

## IME input and shortcuts

Candidate confirmation must never send a message. Composition events and
`isComposing` protect Enter, candidate navigation, mention selection, search and
media shortcuts. Keep text-node identity, focus and composer state stable during
composition/incoming messages. Enter inserts a newline; Shift+Enter sends after
composition ends. Call shortcuts defer to focused text/composition.

Synthetic events cannot establish native candidate ordering. Test Pinyin,
Zhuyin, Japanese conversion and Korean input on the supported desktop/mobile
matrix, including confirmation followed by newline/send.
[Shared mention field](../apps/client/src/features/chat/mention-field.tsx),
[message-input behavior](../tests/e2e/composer.spec.ts) and
[composition state reference](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing)
identify the boundary.

## Text limits and identity

Visible character limits use graphemes; storage/transport limits use UTF-8
bytes; body-search minimum uses code points. Preserve these separate units.
Client hints and owner enforcement share rules for combining marks, Hangul Jamo,
supplementary Han and emoji. [Message text](../packages/contracts/src/message-text.ts)
owns shared grammar and limits; `Intl.Segmenter` supplies grapheme behavior
subject to supported runtime validation.

Allow multilingual names, labels, filenames and mentions. Stable opaque IDs own
routing/permissions; Latin word boundaries and ASCII slugs must not restrict
display text. Preserve original content safely in rendering and any future
export/notification surface.

## Catalogs and account language

Account language is an identity preference synchronized across signed-in
devices. Pre-login language uses a supported browser choice with English
fallback and never overwrites the saved preference. The separate remembered
offline language shares account/generation fences and cannot become an
authenticated profile. Language changes preserve mounted drafts, calls and query
lifetimes.

[ICU JSON catalogs](../apps/client/src/features/i18n/locales) contain explicit IDs.
Lingui owns interpolation/plural/select grammar and Vite compilation; each
provider owns its runtime. Controllers retain untranslated descriptors and
notices translate on render. Every selected catalog ships with the offline
shell, so switching requires no fetch or page reload.

Edit JSON translations directly, preserving IDs/placeholders. English keys
define ID types; [messages.ts](../apps/client/src/features/i18n/messages.ts) defines
parameter arguments. [Language tests](../apps/client/tests/language.test.ts) check
coverage/arguments. `pnpm run i18n:compile` is strict optional CLI compilation;
generated TypeScript is ignored and application imports use the Vite plugin.
Extraction/source-location tooling is not required by the current workflow.

Use natural action-oriented copy, full translated sentences and
locale/timezone-aware date/number formatting. Keep timestamps independent of
display. Unknown Send outcomes must remain uncertain in every locale; clearing
local work must not imply retracting a message. Avoid exposing draft/storage
mechanics in ordinary product copy.

## Typography and acceptance

Text is set in IBM Plex from vaskel's own origin, never a third-party font
service: Plex Sans for Latin and Plex Mono for code with the application styles,
and [Plyra Sans](https://github.com/zllovesuki/plyra-sans) for CJK. Shared
[base styles](../packages/ui/src/base.css) select the regional SC, TC or JP face;
Traditional Chinese and Japanese must not prefer Simplified Chinese glyph
fallbacks. Plex's TC design mixes print and newer forms rather than following
Taiwan's MOE standard. The client and site load [CJK fonts](../packages/ui/src/fonts.css)
after mounting. Until they arrive, and offline without them, the device's own
font for the language draws the text. Plyra's outlines closely match IBM's
published fonts at its named weights, but they are unhinted and have not had
exhaustive visual review. The
[offline shell policy](client-storage.md#offline-application-shell) defines
font caching and fallback.
Preserve language-appropriate punctuation/line breaking, flexible
control widths and mixed-script readability; do not apply blanket `break-all`.
Test long URLs/code, Japanese/Chinese punctuation, Korean wrapping and variable
virtualized heights without clipping or font-load jumps. Any added webfont needs
coverage/loading/payload measurement. [Chinese](https://www.w3.org/TR/clreq/),
[Japanese](https://www.w3.org/TR/jlreq/) and
[Korean](https://www.w3.org/TR/klreq/) layout references remain useful.

Native tokenizer and [built-browser checks](../tests/e2e/README.md) cover bounded
search, text rendering, account language and layout. They do not establish native
IME behavior, physical-device rendering or native-speaker acceptance.

## Proposed tooling changes

Lingui and ICU catalogs are implemented. Extraction, translator context and
pseudolocalization remain optional workflow improvements. A library change must
preserve typed notices, saved account language, mounted drafts/calls and the
offline shell. Localized URLs and full-page language reloads are not required.

## Long-term RTL exploration

RTL/Arabic is deferred. Evaluate document versus per-message direction, logical
layout, directional icons, focus order and bidi isolation for names, files,
timestamps, IDs, URLs and code. Preserve original text/identity. Shaping,
combining marks, cursor/selection, composition, search and narrow
mixed-direction quotes/timelines need native-speaker and device acceptance
before claiming support.
