# Release preparation

Releases currently target personal use with friends. Upgrade and
downgrade support follow the [upgrade policy](operations.md#upgrades-and-supported-tooling).

## Remaining acceptance

Confirm passing results from the [existing local checks](../IMPLEMENTATION.md#validation)
for the chosen revision, then follow the
[publication workflow](../AGENTS.md#git-workflow). Publish the tag pinned by the
installation guide before deploying the updated website and its copy of
[INSTALL.md](../INSTALL.md).

Wider device coverage and workload measurements can follow actual use.

## Evidence limits

Staging has exercised bootstrap completion, host sign-in and verification email
delivery. Real-device calls have also been exercised; [media evidence](media.md#verification-and-references)
distinguishes those calls from local fixtures and synthetic live-SFU probes.

Local browser coverage is Chromium-based. It does not establish Firefox/Safari
behavior, native IME or assistive-technology behavior, physical storage pressure,
or deployed upgrades during an active call. Browser push and message sounds have
local protocol/fixture coverage; provider delivery and browser/OS listening
acceptance remain unverified. These limits are not a claim that the features fail.

Configured admission defaults and the call cap are engineering bounds, not a
demonstrated production workload. Deployed throughput, delivery latency and log
lookup remain unmeasured here; [Operations](operations.md#observability) describes
the diagnostic boundaries.

## Deferred engineering proposals

Tooling proposals remain optional under
[Frontend](frontend.md#proposed-tooling-changes),
[Engineering](engineering.md#proposed-tooling-changes) and
[Internationalization](internationalization.md#proposed-tooling-changes).
[Product policies](product-review.md#deferred-scope) own deferred product scope.
