---
name: "vaskel.com"
description: "The install file is the page: vaskel.'s own Lounge tokens set large, with the product itself as step 0."
colors:
  page: "oklch(96.5% 0.014 80)"
  surface: "oklch(98.6% 0.007 85)"
  sidebar: "oklch(92.5% 0.022 78)"
  sidebar-hover: "oklch(88.5% 0.03 78)"
  ink: "oklch(24% 0.02 60)"
  muted: "oklch(49% 0.022 65)"
  line: "oklch(87% 0.016 80)"
  subtle: "oklch(94% 0.013 80)"
  message-hover: "oklch(97% 0.011 80)"
  accent: "oklch(50% 0.16 35)"
  accent-hover: "oklch(45% 0.16 35)"
  on-accent: "oklch(99% 0.01 35)"
  live: "oklch(62% 0.16 150)"
  stage: "oklch(23.5% 0.014 60)"
  stage-raised: "oklch(31% 0.014 60)"
  stage-line: "oklch(40% 0.014 60)"
  stage-ink: "oklch(94% 0.01 80)"
  stage-muted: "oklch(70% 0.014 70)"
  stage-accent: "oklch(80% 0.13 75)"
  leave: "oklch(56% 0.2 25)"
  on-leave: "oklch(99% 0.01 35)"
  "off": "oklch(78% 0.1 25)"
  off-line: "oklch(50% 0.12 25)"
  terminal: "oklch(17% 0.012 60)"
typography:
  display:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(2rem, 1.2rem + 2.6vw, 3rem)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  wordmark:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.85rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.06em"
  headline:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.1rem"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  lede:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.0667rem"
    fontWeight: 450
    lineHeight: 1.5
  body:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.0667rem"
    fontWeight: 450
    lineHeight: 1.6
  console:
    fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "13px"
    fontWeight: 450
    lineHeight: 1.5
  chat:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.066667rem"
    fontWeight: 450
    lineHeight: 1.5
  ui:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.9333rem"
    fontWeight: 500
    lineHeight: 1.5
  ui-strong:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.9333rem"
    fontWeight: 600
    lineHeight: 1.5
  caption:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.866667rem"
    fontWeight: 450
    lineHeight: 1.5
  caption-strong:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.866667rem"
    fontWeight: 600
    lineHeight: 1.5
  fine:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.8rem"
    fontWeight: 450
    lineHeight: 1.5
  label:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.866667rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.06em"
  table:
    fontFamily: "'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.9333rem"
    fontWeight: 450
    lineHeight: 1.5
    fontFeature: "tnum"
  mono:
    fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "0.9333rem"
    fontWeight: 450
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  avatar: "30%"
  pill: "999px"
spacing:
  unit: "4px"
  page-gutter: "16px"
  control-compact: "28px"
  control-normal: "36px"
  control-tall: "40px"
  control-touch: "44px"
  target: "{spacing.control-normal}"
  para: "12px"
  band-gap: "20px"
  step-head: "28px"
  cols-row: "32px"
  cols-col: "48px"
  step-top: "56px"
  step-bottom: "64px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.ui-strong}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "{spacing.control-tall}"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-plain:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.ui-strong}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "{spacing.control-tall}"
  button-plain-hover:
    backgroundColor: "{colors.subtle}"
  link-quiet:
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    padding: "8px 6px"
  link-body:
    textColor: "{colors.accent}"
  wordmark:
    textColor: "{colors.ink}"
    typography: "{typography.wordmark}"
  step-heading:
    textColor: "{colors.ink}"
    typography: "{typography.display}"
  step-heading-numeral:
    textColor: "{colors.muted}"
    typography: "{typography.display}"
  install-prompt:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "{spacing.control-tall}"
  prompt-copy:
    backgroundColor: "{colors.subtle}"
    textColor: "{colors.ink}"
    typography: "{typography.caption-strong}"
    padding: "0 12px"
    width: "112px"
  prompt-copy-hover:
    backgroundColor: "{colors.sidebar-hover}"
  inline-code:
    backgroundColor: "{colors.subtle}"
    typography: "{typography.mono}"
    rounded: "{rounded.xs}"
    padding: "1px 6px"
  hairline-row:
    typography: "{typography.ui}"
    padding: "10px 0"
    height: "52px"
  console:
    backgroundColor: "{colors.terminal}"
    textColor: "{colors.stage-ink}"
    typography: "{typography.console}"
    rounded: "{rounded.lg}"
    padding: "16px 16px 14px"
  console-bar:
    backgroundColor: "{colors.stage-raised}"
    textColor: "{colors.stage-muted}"
    typography: "{typography.console}"
    padding: "0 12px"
    height: "28px"
  cost-table-head:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    padding: "10px 12px"
  cost-table-cell:
    typography: "{typography.table}"
    padding: "10px 12px"
  workspace-frame:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: "724px"
  nav-row:
    textColor: "{colors.muted}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
    height: "{spacing.target}"
  nav-row-current:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.ui-strong}"
  now-card:
    backgroundColor: "{colors.stage}"
    textColor: "{colors.stage-ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  now-card-hover:
    backgroundColor: "{colors.stage-raised}"
  pip-window:
    backgroundColor: "{colors.stage}"
    textColor: "{colors.stage-ink}"
    rounded: "{rounded.lg}"
    width: "280px"
  composer:
    typography: "{typography.chat}"
    rounded: "{rounded.xl}"
    padding: "16px 16px 8px"
  avatar:
    typography: "{typography.ui}"
    rounded: "{rounded.avatar}"
    size: "36px"
---

# Design System: vaskel.com

## Overview

**Creative North Star: "The Install File"**

The landing page is INSTALL.md with the product as step 0. It reads top to bottom in the order a host proceeds: what you get (the workspace itself, operable), what you need, the deploy, becoming the host, inviting people, what it costs. The wordmark band carries the sentence and the single action; nothing on the page is arranged the way the category arranges it. There is no hero slogan, no feature cards, no pricing grid, no logo wall, and the offer is never hidden behind the product.

The world is Lounge, the app's own, borrowed whole: warm cream page, sand sidebar, terracotta accent for the one action and for links, the dark stage only inside call surfaces, live green for presence, ID-derived person hues, IBM Plex everywhere. The site's own layer is typographic and structural rather than chromatic: IBM Plex set large with tight tracking for numbered step headings, hairline rows in place of cards, and a frame only where the page shows something (the workspace, the person's terminal while their agent follows INSTALL.md, an app screen). With all content removed the page is a cream ground, one terracotta word, hairlines and one dark rectangle.

Density is generous between steps and app-dense inside the exhibits, because the exhibit is the app at its real 15px type root rather than a picture of it. Light and dark come from the same tokens, resolved by `data-theme` or `prefers-color-scheme` exactly as in the app. Confirmed rejections: Discord marketing tells (blurple, mascots, character illustration), startup chrome (gradient blobs, glass cards, badge rows, logo walls, floating or 3D screenshots), fabricated proof, display faces and shipped rasters.

**Key Characteristics:**

- Tokens are consumed from the app's theme (`@vaskel/ui/theme.css`), never redefined; the site adds one colour (`terminal`).
- One filled accent control on the page (Deploy your own); every other control is hairline-and-surface, plain text, or ink-filled.
- Step headings read `N · Title` in IBM Plex Sans at clamp(2rem, 1.2rem + 2.6vw, 3rem), 700, -0.03em, the numeral in muted.
- Hairline rows, not cards; 12px frames with the row shadow are reserved for exhibits.
- The dark stage and its gold appear only inside call surfaces (Happening-now card, pinned bar, picture-in-picture window, stage, shared terminal).
- Exhibits are DOM built from the app's components, operable and localized through the four real catalogs in the visitor's browser language; no raster ships on the page. The favicon and the share card come from the shared brand master.
- Light and dark from the same tokens, with `data-theme` and `prefers-color-scheme` as in the app.

## Colors

Warm neutrals in the 60–85° hue band, one terracotta accent at 35°, a green reserved for presence, and a separate dark stage family that belongs to calls.

The site consumes `packages/ui/src/theme.css` (`@vaskel/ui/theme.css`) unchanged: both palettes, the `--color-*` aliases, the person-hue channels, the spacing unit, the control and target sizes, the page gutter and the three shadows, under the app's own names. The only site-defined colour is `terminal`, the screen of the shared terminal and of the agent session in step 2. The theme's error family (`error`, `error-line`, `error-soft`), `accent-soft` and `leave-hover` are declared but unused on the page, which has no failure, New or mention states; they stay defined by the app. In dark theme the same tokens re-resolve: the page drops to 19% lightness, the accent becomes the gold of `stage-accent` (oklch 80% 0.13 75) with a dark `on-accent`, the stage deepens to 14%, and `terminal` to 11%; the site never styles dark separately.

### Primary

- **Terracotta** (`accent`, hover `accent-hover`, text `on-accent`): the one filled action on the page (Deploy your own), body links, the 2px focus outline with 2px offset, unread dots and badges, the viewer's own reaction outline, and text selection at 22%. Its rarity on the page is the point.

### Secondary

- **Live green** (`live`): presence and broadcasting only: the live dot with its 22% halo, the presence ring on avatars, the speaking ring on the stage, and the passing lines in the shared terminal. Never decorative.

### Tertiary

- **Stage family** (`stage`, `stage-raised`, `stage-line`, `stage-ink`, `stage-muted`, `stage-accent`): the dark call surface. `stage` fills the Happening-now card, the pinned now-playing bar, the picture-in-picture window and the stage view; `stage-raised` is hover and the tiles on it; `stage-line` its hairlines; `stage-ink` and `stage-muted` its text; `stage-accent` gold marks the shell prompt in the shared terminal. `terminal` is the screen inside a share and the agent console, two steps darker than the stage; on the console, completed tool calls take their bullet from `live`, the person's own lines and tool output sit in `stage-muted`.
- **Leave and off** (`leave` with `on-leave`; `off` with `off-line`): the destructive Leave fill, and the muted-camera or muted-mic state on stage toggles and participant tiles.

### Neutral

- **Page cream** (`page`): the document ground and nothing else.
- **Surface** (`surface`): every framed thing: the workspace, the install prompt, plain buttons, the current nav row, entry screens, the dock card.
- **Sidebar sand** (`sidebar`, `sidebar-hover`): Home's column inside the exhibit; hover for its rows and for the Copy control.
- **Ink and muted** (`ink`, `muted`): headings, prose, current items and control labels in ink; ledes, captions, step numerals, table heads, hints and secondary nav rows in muted.
- **Line** (`line`): every hairline: the band's bottom, step separators, rows, frames, table rules. The cost table's head rule alone is `ink`.
- **Subtle and message hover** (`subtle`, `message-hover`): inline code and pre blocks, the Copy control, quotes and plain-button hover; the hovered message row.
- **Person hues**: eight hues (25, 60, 110, 160, 200, 250, 300, 340) chosen by FNV-1a hash of the account id, drawn as `oklch(85% 0.08 H)` backgrounds with `oklch(36% 0.11 H)` ink in light theme (34% / 0.07 and 86% / 0.09 in dark). Circles stay neutral: the monogram sits on `sidebar-hover`.

### Named Rules

**The Borrowed Palette Rule.** [The site stylesheet](src/styles.css) consumes the app's colour tokens and adds only `terminal`. Other colours belong to the shared theme.
**The One Filled Action Rule.** Outside the exhibits, exactly one control on the page is filled with `accent`: Deploy your own in the wordmark band. Everything else is surface-and-hairline, plain text, or ink-filled.
**The Stage Stays Inside the Call Rule.** `stage` and `stage-accent` appear only on call surfaces and on screens (the shared terminal, the agent console). The page never sets a dark band or section; dark on the cream page means a call is happening or a terminal is open.

## Typography

**Display Font:** IBM Plex Sans (`IBM Plex Sans Var`, IBM's variable release), with the regional stacks for zh-Hant, zh-Hans and ja as the app's base.css declares them: Plyra Sans TC, SC or JP (variable builds of IBM Plex Sans's CJK design) by language, the other two Plyra faces only for characters the reader's own face lacks, then the device's own font for the language, which draws CJK text until the Plyra slices arrive after first paint.
**Body Font:** the same stack.
**Label/Mono Font:** `--font-mono`, IBM Plex Mono (IBM's release, in the Text, SemiBold and Bold weights) ahead of the ui-monospace stack.

**Character:** One family, no display face. Hierarchy is made from the app's own Plex pushed to display size with tight tracking, so the page reads as the product speaking at a larger size. Regular text is Plex's Text weight, 450, which sits between Regular's light colour and Medium's heavy one at interface sizes. The root is 15px, as in the app, so 1rem is 15px and the app's text tokens land at 14, 13, 12 and 16px.

### Hierarchy

- **Display** (700, clamp(2rem, 1.2rem + 2.6vw, 3rem), 1.08, -0.03em, balanced wrapping): the six step headings; with the 15px root this resolves to 30px at 390 and 45px at 1440.
- **Wordmark** (700, 1.85rem, 1, -0.06em): "vaskel." in the band, the full stop in accent; 1.45rem in the footer and in the exhibit's Home head.
- **Headline** (650, 1.1rem, 1.35, -0.02em): sub-heads inside steps and the app's own page titles inside exhibits (the room header, the entry-screen title).
- **Lede** (450, 1.0667rem, 1.5, muted): the sentence under each step heading, in a 40rem measure (60rem under step 0); `<strong>` returns to ink at 600.
- **Body** (450, 1.0667rem, 1.6, 40rem measure, pretty wrapping): step prose.
- **Console** (mono, 13px, 1.5; 11px on phones): the agent session in step 2, wrapped like a terminal (`pre-wrap`, breaks anywhere) with a 2ch hanging indent for turns and 5ch for tool output.
- **Chat** (450, 1.066667rem, 1.5, 40rem measure): message bodies and the composer, as in the app.
- **UI / UI strong** (500 / 600, 0.9333rem): controls, nav rows, the band's GitHub link, the footer links, the cost table, the rows.
- **Caption / Caption strong** (450 / 600, 0.866667rem, muted): hints under controls, the workloads line, table sub-lines, quotes, chips, badges, the Copy control and Send.
- **Fine** (450, 0.8rem): timestamps, sub-lines in nav rows, counts, the composer hint.
- **Label** (600, 0.866667rem, 0.06em, uppercase): the app's section labels (Happening now, Unread, Your circles, Direct messages), the timeline's day divider (700 at fine size), and the cost table's column heads. Under zh-Hant, zh-Hans and ja the tracking is 0 and the case is untouched.
- **Mono**: the install-file link at ui size with the path at 600; inline code at 0.92em on `subtle` with 1px 6px padding; the shared terminal at 13px / 1.5 (8px on phones, 7px inside the picture-in-picture thumbnail), which is a picture of a screen and not interface text; the console at 13px / 1.5.
- **Numerals**: `tabular-nums` on step numerals, timestamps, durations, counts and the whole cost table.

### Named Rules

**The One Family Set Large Rule.** Type contrast comes from size, weight and tracking of IBM Plex, never from a second family. Tracking tightens as size grows (-0.02em at 1.1rem, -0.03em at display, -0.06em on the wordmark) and is zeroed under CJK languages.
**The Numbered Heading Rule.** Every step heading is `N · Title`: the numeral and the middle dot in muted at 600 tabular, the title in ink. The sequence starts at 0 with the product itself. Headings carry no eyebrow or kicker above them.
**The Mark Rule.** The product mark is the wordmark's initial and its full stop, drawn as geometry (`@vaskel/ui/brand`) on a `stage` tile at the avatar radius with the v in `stage-ink` and the period in `stage-accent`. It appears only where text cannot: the favicon, the home-screen icon and the share card, whose wordmark is set in IBM Plex Sans at the wordmark's weight and tracking. It never sits beside the wordmark on the page.

## Layout

Lengths in this document are CSS pixels measured on the shipped page, not instructions to type a pixel value. The shared sizes are the theme's tokens and are built by name (`page-gutter`, `control-tall`, `target` and the rest); `target` becomes `control-touch` for coarse pointers. Padding, margins and gaps in component classes are spacing units (`pt-8` is eight units), half units included (`gap-1.5`, `px-2.5`); fixed dimensions and positions stay explicit pixels (`w-[280px]`, `bottom-[158px]`), and the page's own rules live in its stylesheet.

One column of steps inside the page gutter (`--spacing-page-gutter`) with content capped at 1408px and centred. The wordmark band (56px minimum, 8px vertical padding, hairline below, 20px gaps) holds the wordmark, one sentence in muted, GitHub and Deploy your own. Step 0 opens 16px under the band with its heading row (heading left, install prompt right, ends aligned, 12px to the content), then the workspace exhibit at full content width; nothing sits under it. Steps 1 to 5 take 56px above and 64px below with a hairline between; the last step has none and the footer takes 32px above and 40px below.

Every step after 0 is two equal columns at 900px and wider, prose on the left in a 40rem measure and its evidence on the right (rows, the agent console, an entry screen, the table), with 32px row and 48px column gaps; the cost step widens the right column to 2fr / 3fr. The heading row is a two-cell grid (16px × 40px gaps) aligned to the end. Below 900px the columns stack and the heading's aside moves to the left edge. Below 640px the band wraps (sentence to its own line, nav beneath), steps tighten to 40px / 44px, the console drops to 11px with 12px × 10px padding, and the cost table drops to caption size with 8px × 6px cells.

Inside the exhibit the layout is the app's: a 264px Home column (240px between 640 and 899px) beside the room pane, 724px tall (740px on phones, where Home replaces the pane behind a Home button in the room header). The exhibit opens on the Lounge stage, whose shared screen is capped at 704px so the participants and the controls stay inside the frame; in a text room the picture-in-picture window sits 16px from the right edge and 158px above the bottom at 280px wide (150px on phones), clear of Send. Breakpoints are the app's: 640px (`sm`) and 900px (`lg`). Measures use rem, never `ch`, so CJK paragraphs keep their width; the one `65ch` clamp is the app's own quote measure inside the timeline.

## Elevation & Depth

Flat by default; depth is drawn with hairlines and tonal steps (page under surface, sidebar beside surface, stage-raised on stage). The app's three shadows are the only lift and the site adds none.

### Shadow Vocabulary

- **Row** (`box-shadow: 0 1px 2px oklch(30% 0.02 60 / 0.06)`): the lift under framed page chrome: the install prompt, the console, plain buttons, the current nav row, the dock card and the Happening-now card.
- **Composer** (`box-shadow: 0 1px 2px oklch(30% 0.02 60 / 0.05)`): the composer surface only.
- **Popover** (`box-shadow: 0 12px 35px oklch(30% 0.01 65 / 0.13), 0 2px 6px oklch(30% 0.01 65 / 0.05)`): things that float over content; on this page that is the picture-in-picture window alone.

Dark theme deepens the same three from 5% lightness ink at higher alpha. Rings are not elevation: the live dot's 22% halo, the 2px presence ring in the parent's colour, the 2px separators in an avatar stack, and the speaking ring (2px `stage-raised` then 4px `live`).

### Named Rules

**The Row Shadow Rule.** Page chrome lifts by at most the row shadow; the popover shadow belongs to things that float over content. No shadow is invented on the site.

## Shapes

Radius follows the app's scale: 4px for inline code, 6px for reaction pills and the circle monogram, 8px for buttons, fields, nav rows, quotes and the share, 12px for frames (the workspace, the console, the picture-in-picture window, the dock card, entry screens), 16px for the composer surface, and full pills for dots, badges, stage chips and stage toggles. Avatars are rounded squares (30%) in navigation and the timeline and circles on the stage. Borders are 1px `line` (1px `stage-line` on stage surfaces, 1.5px on stage toggles); frames clip their content so headers and terminals meet the corner. The band and the steps are separated by full-width hairlines, never by boxes, and page-level lists are rows with a hairline above the list and under each row.

## Components

Restrained and product-literal: the page's own controls are the app's controls at the app's sizes, and the exhibits are the app's components untouched.

### Buttons

- **Shape:** softly rounded (8px), `control-tall` minimum height (`control-touch` for coarse pointers), 8px 16px padding, ui size at 600.
- **Primary:** `accent` fill and border with `on-accent` text; hover `accent-hover`; background and border transition in 0.15s ease-out. One per page.
- **Plain:** shared `buttonStyles` with `surface` fill, `line` border, ink text, row shadow and the shared hover/press wash. The small variant takes the `target` height with 6px 12px padding at caption size.
- **Quiet links:** ink text at ui 500 with 8px 6px padding and no decoration; underline on hover. Footer links are ink and underlined at rest.
- **Focus:** a 2px `accent` outline with 2px offset on every link, button and focusable element.

### Install prompt

The install-file link and Copy prompt control share a hairline frame on `surface` with the row shadow. The control copies a complete setup request that asks the agent to guide prerequisites. The hint sits to the right on desktop and to the left once the heading stacks. Successful copying shows Copied for 1.6s; failed or unavailable clipboard access reveals and selects the full prompt in a read-only field. The control follows shared fine/coarse pointer heights.

### Hairline rows

Lists are rows: 52px minimum, 10px vertical padding, a hairline above the list and under each row, ui size with a caption sub-line in muted; a trailing control is the small plain button. No card, no background, no left padding.

### Agent console

The person's terminal while their agent follows INSTALL.md: a 12px frame on `terminal` with a `stage-line` border and the row shadow; a 28px title bar on `stage-raised` (11px mono in `stage-muted`, "wren@mbp — claude — ~/loft"); the body at 13px / 1.5 mono with 16px padding and one line of air between turns. Turns take a coding agent's transcript shapes: the person's lines behind `>` in `stage-muted`, the agent's prose and tool calls behind a bullet (`stage-ink` for prose, `live` when a tool has completed), the tool's name in 600 with its input in parentheses, output behind `⎿` at a 5ch indent in `stage-muted`, and folded output as "… +N lines (ctrl+o to expand)". It ends with the resting input line between two hairlines, a blinking 1ch caret, and "? for shortcuts". It is abridged to the four beats a host experiences: the request, the chosen addresses and guided setup, the folded build and deploy call, and the host handoff. Keep it abridged; account setup and verification belong in INSTALL.md, not additional transcript turns. Every command it runs is a line of INSTALL.md (the site's tests check this).

### Cost table

Full width, collapsed borders, tabular numerals at ui size; cells 10px 12px, right-aligned except the first column (left, no left padding), a hairline under each row; the head at label style with an `ink` rule beneath; sub-lines in caption muted; included usage in muted; the largest figure at 600; the planning-budget row at 700 and 1.2rem with 14px top padding and no rule. Below 640px it drops to caption size and 8px 6px cells, with text allowed to wrap. Show rounded reference costs and the planning ranges from docs/costs.md. Keep one short lead beside the table and one concise fine-print paragraph below it. Link to docs/costs.md for detailed workloads and assumptions; keep the rate date and allowance/tax qualifications in the fine print.

### Step heading

An `h2` at display with the numeral and middle dot in a span at muted, 600, tabular. The step 0 heading shares the style and sits in one row with the install prompt.

### Wordmark

"vaskel" in ink with the full stop in accent, 700 and -0.06em: 1.85rem in the band, 1.45rem in the footer and in the exhibit's Home head. Never a logo image.

### Workspace exhibit

The preview renders the application's own [Home](../../packages/ui/src/components/home.tsx),
[room](../../packages/ui/src/components/room.tsx) and
[call](../../packages/ui/src/components/call.tsx)
components with its fixture, under the app's
[font policy](../../docs/internationalization.md#typography-and-acceptance).
Where the app navigates, the preview's buttons switch the pane and span their
rows; controls it does not operate are inert. Empty composers retain the
disabled Send state.

The product rendered in its own components inside a 12px `surface` frame with a hairline. Home on `sidebar`: the app's section labels, nav rows (`target` height, 8px radius, ui 500 in muted; current is `surface` with the row shadow and ink at 600; unread is ink at 600 with a 6px accent dot; the Unread inbox uses a 20px accent badge at 11px), the Happening-now card (`stage` fill, 10px 12px, one link stacked in lines: the room name with "· Loft" and, at the right of the same line, "You’re in" in `live`; then 20px avatars stacked with 2px stage rings and a "+2" tile on `stage-raised` beside "5 in the call · 42:10"; then the share glyph and who is sharing; Join, offered in place of "You’re in" when the viewer is not in the call, takes a row of its own), the circle head (its 24px monogram, a name that wraps to two lines instead of truncating, and one ⋯ control for the owner's actions), and the call dock (a 12px card with 36px light toggles). The room pane opens on the stage; in a text room it shows the pinned now-playing bar only below the shared `sm` breakpoint (640px), on `stage` (6px 12px, ui 600 with a caption sub-line naming who is in the call, then the microphone, Open and Leave). Desktop uses the Home dock. The text room contains the room header (60px, hairline, the notification bell, a presence strip of 20px avatars counting the other people online, Invite and Search; a direct message shows Options and Join call), the timeline (36px avatar column with 12px gap, chat size in a 40rem measure, hover `message-hover`, quotes on `subtle` at caption within 65ch, 6px reaction pills with the viewer's in accent, the uppercase day divider), the composer (16px radius, 72px input at chat size, `target`-height toolbar, a 48px Send slot with a 40px by 28px arrow control, muted when empty) and the picture-in-picture window (280px, 12px radius, `stage` with a `stage-line` border and the popover shadow) showing the shared terminal on `terminal` in mono at 11px above the room's name. The stage view: `stage` ground, `stage-line` hairlines, participant tiles on `stage-raised`, pill chips, 40px circular toggles (on is a `stage-ink` fill, off an `off-line` border) and the `leave` fill. All of it inherits the app's geometry from `@vaskel/ui`; the site restyles none of it.

Interaction: nav rows, the Happening-now card, Open on the bar and the picture-in-picture window switch the pane; entering the stage hides the bar, the window and the dock; opening a room clears its unread mark; the stage's Picture in picture goes to #general; on phones a Home button opens Home as a pane. The first time #general opens, its transcript plays two scripted arrivals (the typing notice in the composer's status slot, then a message entering over 0.42s on cubic-bezier(0.16, 1, 0.3, 1) from 10px below), not under `prefers-reduced-motion`, where the still frame is complete. The exhibit's `lang` and strings follow the visitor's browser through the app's own rule (`@vaskel/ui/language`): the prerendered page is English and hydration re-renders it once in 简体中文, 繁體中文 or 日本語 when the browser asks for one of them; no control on the page chooses a language.

### Entry screens

The bootstrap form and the invitations section as the app draws them: a 12px frame on `surface` with 24px padding at 420px maximum (full width for the invitations section); field labels and boxes using `labelStyles` and `fieldStyles` from `@vaskel/ui`, including coarse-pointer sizing, the description line at caption in muted; the one submit as the app's primary button.

### Footer

The wordmark at 1.45rem on the left and the two ink links underlined on the right, 12px × 28px gaps, 32px above and 40px below, no rule of its own.

## Do's and Don'ts

### Do:

- **Do** consume `@vaskel/ui` unchanged (theme, base and the components' styles and timeline) under the app's own token names; add a site token only for something the app has no word for, as `terminal` was.
- **Do** keep one filled `accent` control per page and hairline-and-surface for the rest.
- **Do** number every step heading `N · Title` at the display style, numeral in muted tabular, with no eyebrow above it.
- **Do** lay lists out as hairline rows and reserve 12px frames with the row shadow for exhibits (the workspace, the agent console, an app screen).
- **Do** build exhibits from the app's own components in DOM, localized through the four catalogs with `lang` set on the exhibit from the visitor's browser; ship no raster.
- **Do** keep the dark stage, its gold and the popover shadow inside call surfaces and screens; the agent console is a screen.
- **Do** keep the 15px type root, the page gutter and spacing unit from the theme, the 1408px cap, the 40rem measure and the 640px / 900px breakpoints.
- **Do** set every number that lines up (costs, times, counts, step numerals) in tabular numerals.
- **Do** honour `prefers-reduced-motion`: transitions collapse to 0.01ms and scripted motion does not run; the still frame is complete.

### Don't:

- **Don't** load a display face or a second family; Plex at display size is the identity.
- **Don't** introduce Discord marketing tells: blurple, mascots, character illustration.
- **Don't** add startup chrome: gradient blobs, glass cards, badge rows, logo walls, floating or 3D screenshots.
- **Don't** add proof surfaces (testimonial cards, member counts, uptime, benchmarks); reference cost figures come from docs/cost-scenarios.json and planning ranges from docs/costs.md.
- **Don't** put a dark band or section on the page; dark means a call surface or a terminal.
- **Don't** invent a shadow, a radius or an additional colour in the site stylesheet; the shared theme owns those choices.
- **Don't** restyle the app's components inside an exhibit; the exhibit is proof because it is the app's geometry.
- **Don't** letter-space or uppercase under zh-Hant, zh-Hans or ja.
