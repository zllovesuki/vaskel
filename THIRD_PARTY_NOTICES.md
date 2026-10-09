# Third-party notices

The MIT license in `LICENSE` covers vaskel-owned code. Dependencies retain their
own copyright notices and licenses. The lockfile pins the installed versions.

App, Worker and site builds generate `licenses/dependencies.md` from the
JavaScript packages actually bundled by Vite. The app also generates
`licenses/service-worker.md` for its separately built service worker. These
include Lucide's ISC license and the MIT notice for icons derived from Feather.
Browser builds also include vaskel's license as `LICENSE.txt`.

## Fonts

The browser app and site ship IBM Plex Sans Variable, IBM Plex Mono and Plyra
Sans SC, TC and JP. These fonts retain the SIL Open Font License 1.1 and IBM's
copyright notice and reserved font name. Their original license texts accompany
the browser builds in `licenses/fonts/`. Plyra is an independent derivative of
IBM Plex; its build tooling's Apache license does not replace the fonts' OFL.

## Server-side video thumbnails

The Worker uses [ffmpeg-tiny](https://github.com/zllovesuki/ffmpeg-tiny), an
LGPL-2.1-or-later FFmpeg decoder. The decoder is not delivered to browsers.

The [published package archive](https://registry.npmjs.org/ffmpeg-tiny/-/ffmpeg-tiny-0.1.0.tgz)
includes the matching source, license notices and rebuild instructions. Follow
those instructions to replace the decoder. When redistributing the decoder or
a built Worker containing it, preserve its corresponding source and notices.
