# Browser acceptance

From the repository root, build the current application before running the
maintained Chromium cases in `tests/e2e/`:

```sh
pnpm run build
pnpm run test:browser
```

Run `pnpm run test:browser:measure` after the build to record local cold-entry
timings explicitly. These observations have no latency threshold and are separate
from the default browser checks.

On a fresh machine, install compatible Chromium with
`pnpm exec playwright install chromium`, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chrome`. Browser
installation is separate from `pnpm install --frozen-lockfile --ignore-scripts`. The suite uses the
official [Playwright runner](https://playwright.dev/docs/test-configuration) and
[Wrangler harness](https://developers.cloudflare.com/workers/testing/test-harness/).

## Isolation and execution

Run `pnpm run build:site && pnpm run test:browser:site` for the separate
[site suite](../site): built headers, clipboard failures and development mounting.

Application cases get an unused port, fresh native D1/DO/R2 under ignored
`.local/browser-runs/`, synthetic configuration, a local mail receiver and fresh
browser contexts. They register/verify/sign in and seed through built HTTP
APIs. No preview data or credentials are copied. Teardown closes the runtime and
removes its temporary directory. Independent files run on up to four Playwright
workers, capped by available CPUs; cases within each file stay sequential.
Use `pnpm run test:browser --workers=1` on hosts that need a lower resource limit.
Fresh accounts prevent earlier cases consuming admission/rate allowances or
carrying over language/roles/history.

Most cases exercise mounted React, real application HTTP/sockets and native
IndexedDB. Media routes alone are intercepted for UI tests: startup publication
uses a native loopback receiver and synthetic signaling. Those checks do not
establish SFU/device delivery. Dedicated transfer and offline-shell fixtures
below have different boundaries.

Tests read current `apps/client/dist/`; rebuild after application/contract changes and never
rewrite it during a run. `tsconfig.browser.json` checks browser specs
separately; ordinary workerd Vitest excludes them. Failed cases retain
screenshots, traces and diagnostics in `.local/browser-results/`.

`files/clip.webm` is a silent one-second 64×64 VP8 clip for the attachment
viewer; VP8 plays in Playwright's Chromium, which ships without H.264. It was
generated once with:

```sh
ffmpeg -f lavfi -i "color=c=0x2266aa:s=64x64:r=10:d=1" -an -c:v libvpx -b:v 40k -pix_fmt yuv420p tests/e2e/files/clip.webm
```

## Choose the affected cases

List executable cases with `pnpm run test:browser --list`, then pass a spec
path or `--grep` to select the affected behavior. For example:

```sh
pnpm run test:browser tests/e2e/drafts.spec.ts
```

The specs own case coverage. Choose the environment that can establish the
changed behavior: mounted application tests, native browser fixtures and live
provider/device acceptance have different limits.

Native media and storage fixtures share immutable compiled modules per worker;
each case gets a fresh static server, origin and browser context. Compilation
uses temporary directories without rewriting `apps/client/dist/`. Native media
cases test local playback/SDP ordering, not account admission, live SFU closure
or physical audibility.

Shell tests build distinct asset versions in temporary directories and verify
that accepting an update loads the new bytes. Mounted draft, media and notice
tests use another worker URL for the same build to exercise activation and
reload through the real UI. Those cases establish recovery, not deployment of
changed application code. Device storage pressure and deployed upgrades remain
separate acceptance work.

Synthetic composition keys establish shortcut admission, not native
Pinyin/Zhuyin/Japanese/Korean candidate behavior. Touch emulation is not
physical-phone or assistive-technology acceptance.
See [Readiness](../../docs/readiness.md) for outstanding acceptance.
