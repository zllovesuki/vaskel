/*
 * The product mark: the wordmark's initial and its accent period, drawn as
 * geometry so it renders alike where the wordmark's system font varies.
 * Browsers and operating systems receive it as favicon, home-screen icon,
 * manifest icons and push badge; vaskel.com adds the share card. Every file
 * under packages/ui/brand is emitted from these numbers by the root brand
 * command, and the package tests hold the committed master to them.
 */

export type Surface = "site" | "app";

const favicon = ["favicon.svg", "favicon.ico", "apple-touch-icon.png"] as const;
/** Which master files each application ships at its origin root. */
export const SURFACES: Record<Surface, readonly string[]> = {
  site: [...favicon, "og.png"],
  app: [
    ...favicon,
    "manifest.webmanifest",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/maskable-512.png",
    "icons/badge-96.png",
  ],
};
export const ICO = { path: "favicon.ico", sizes: [16, 32, 48] } as const;
export const SHARE_CARD = { path: "og.png", width: 1200, height: 630 } as const;
export const SHARE_CARD_FONT = "IBM Plex Sans Var";

const TOKENS = {
  page: "page",
  ink: "ink",
  muted: "muted",
  accent: "accent",
  stage: "stage",
  stageInk: "stage-ink",
  stageAccent: "stage-accent",
} as const;
export type Colours = Record<keyof typeof TOKENS, string>;

/** Hex values of the light theme tokens the mark uses, read from theme.css so icons cannot drift from it. */
export function brandColours(themeCss: string): Colours {
  return Object.fromEntries(
    Object.entries(TOKENS).map(([key, token]) => {
      const match = new RegExp(
        `--t-${token}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`,
      ).exec(themeCss);
      if (!match) throw new Error(`theme.css lacks --t-${token}`);
      return [key, oklchToHex(+match[1]! / 100, +match[2]!, +match[3]!)];
    }),
  ) as Colours;
}

function oklchToHex(lightness: number, chroma: number, hue: number) {
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channel = (linear: number) => {
    const c =
      linear <= 0.0031308
        ? 12.92 * linear
        : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return (
    "#" +
    channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
    channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
    channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  );
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The `v.` in a 64-unit box: two 9.5-unit strokes meeting on a 5-unit flat
 * apex, as an 800-weight sans draws them, and a ⌀10 period on the baseline
 * 1.5 from the arm, the wordmark's tracking.
 */
export function monogram() {
  const box = 64;
  const height = 34;
  const width = 38;
  const stroke = 9.5;
  const flat = 5;
  const gap = 1.5;
  const dot = 10;
  const top = (box - height) / 2;
  const base = top + height;
  const span = width + gap + dot;
  const left = (box - span) / 2;
  const centre = left + width / 2;
  const slope = (width / 2 - flat / 2) / height;
  const inner = top + (width / 2 - stroke) / slope;
  const points: [number, number][] = [
    [left, top],
    [left + stroke, top],
    [centre, inner],
    [left + width - stroke, top],
    [left + width, top],
    [centre + flat / 2, base],
    [centre - flat / 2, base],
  ];
  return {
    box,
    path: `M${points.map(([x, y]) => `${round(x)} ${round(y)}`).join("L")}Z`,
    dot: {
      cx: round(left + width + gap + dot / 2),
      cy: round(base - dot / 2),
      r: dot / 2,
    },
    span,
  };
}

interface Tile {
  /** Composition width as a share of the tile width; tab sizes take more. */
  ratio: number;
  /** Optical shift down, in monogram units: the v is top-heavy. */
  dy: number;
  /** Rounded corners at the app's avatar radius, or full bleed for masks. */
  rounded: boolean;
  background: string | null;
  ink: string;
  accent: string;
}

/** A 512-unit tile carrying the monogram. */
function tile({ ratio, dy, rounded, background, ink, accent }: Tile) {
  const size = 512;
  const mark = monogram();
  const scale = (size * ratio) / mark.span;
  const offset = (size - mark.box * scale) / 2;
  const ground = background
    ? `<rect width="${size}" height="${size}"${rounded ? ` rx="${round(size * 0.3)}"` : ""} fill="${background}"/>`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${ground}` +
    `<g transform="translate(${round(offset)} ${round(offset + dy * scale)}) scale(${round(scale)})">` +
    `<path fill="${ink}" d="${mark.path}"/>` +
    `<circle fill="${accent}" cx="${mark.dot.cx}" cy="${mark.dot.cy}" r="${mark.dot.r}"/></g></svg>`
  );
}

const stage = (
  colours: Colours,
  options: Pick<Tile, "ratio" | "dy" | "rounded">,
) =>
  tile({
    ...options,
    background: colours.stage,
    ink: colours.stageInk,
    accent: colours.stageAccent,
  });
const icon = { ratio: 0.6, dy: 1 };

/** Master files whose bytes are text: the favicon and the web app manifest. */
export function textFiles(colours: Colours): Record<string, string> {
  const manifest = {
    name: "vaskel.",
    short_name: "vaskel.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: colours.page,
    theme_color: colours.page,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
  return {
    "favicon.svg": stage(colours, { ratio: 0.68, dy: 1.5, rounded: true }),
    "manifest.webmanifest": `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

/** Square rasters of the master, with the SVG each is rendered from. */
export function pngFiles(colours: Colours) {
  return [
    {
      path: "apple-touch-icon.png",
      size: 180,
      svg: stage(colours, { ...icon, rounded: false }),
    },
    {
      path: "icons/icon-192.png",
      size: 192,
      svg: stage(colours, { ...icon, rounded: true }),
    },
    {
      path: "icons/icon-512.png",
      size: 512,
      svg: stage(colours, { ...icon, rounded: true }),
    },
    {
      path: "icons/maskable-512.png",
      size: 512,
      svg: stage(colours, { ...icon, rounded: false }),
    },
    // Status bars flatten the badge to one colour, so it is the silhouette alone.
    {
      path: "icons/badge-96.png",
      size: 96,
      svg: tile({
        ratio: 0.8,
        dy: 1,
        rounded: false,
        background: null,
        ink: "#ffffff",
        accent: "#ffffff",
      }),
    },
  ];
}

/** The share card at its rendered size; the caller supplies the @font-face for SHARE_CARD_FONT. */
export function shareCardHtml(colours: Colours, fontFace: string) {
  const family = `"${SHARE_CARD_FONT}", ui-sans-serif, system-ui, sans-serif`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${fontFace}` +
    `body{margin:0;background:${colours.page};color:${colours.ink};font-family:${family}}</style></head>` +
    `<body><div style="width:${SHARE_CARD.width}px;height:${SHARE_CARD.height}px;box-sizing:border-box;padding:72px 80px 64px;display:flex;flex-direction:column;justify-content:space-between">` +
    `<div style="display:flex;flex-direction:column;gap:28px">` +
    `<p style="margin:0;font-size:168px;line-height:1;font-weight:700;letter-spacing:-0.06em">vaskel<span style="color:${colours.accent}">.</span></p>` +
    `<p style="margin:0;max-width:20ch;font-size:44px;line-height:1.2;letter-spacing:-0.02em;color:${colours.muted}">A private place for your people, on your own Cloudflare account.</p></div>` +
    `<div style="display:flex;align-items:center;gap:16px"><div style="width:44px;height:44px">${stage(colours, { ...icon, rounded: true })}</div>` +
    `<span style="font-size:26px;font-weight:600;letter-spacing:-0.02em">vaskel.com</span></div></div></body></html>`
  );
}
