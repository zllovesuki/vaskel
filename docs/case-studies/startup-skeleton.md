# Case study: when a loading fix needed a smaller product problem

17 September 2026. A design exchange between the user, Claude and Codex changed
how vaskel. opens a conversation. The
[frontend guide](../frontend.md#startup-and-reconnect) owns current startup
behavior, and [frontend verification](../frontend.md#verification) explains
the evidence limits.

Sources are the planning exchange and the relevant user/assistant messages in
Claude Code session `d9a7eaa6-3410-4cf2-90f7-c2406ed12fca`. The account below is
self-contained; the raw session is not required reading.

## The actual problem

Claude recorded a warm reload of a DM deep link in the local development build.
Between roughly 0.8 and 2.4 seconds after navigation, the screen passed through
an opening page, another loading message, the workspace with a premature “This
conversation isn't available” message and reconnect banner, a chat skeleton,
then messages. The header moved when the banner disappeared. This was a reported
warm-development observation, not a cold-production measurement independently
repeated by Codex.

The product problem was that an ordinary reload looked unstable and sometimes
suggested a failure. The user wanted vaskel. to feel like one coherent application
opening a conversation.

## How the discussion grew

The user's first message asked whether an initial loading overlay would help.
Claude's first response already identified the right goals: render the
application's own frame and make “unavailable” a claim backed by a completed
check. It rejected an overlay partly on the assumption that it would merely hide
false messages for a fixed time. The user had not requested a timer. That
assumed implementation narrowed the options too early.

The first plan proposed a shared opening frame, a predicate deciding whether a
destination was still being checked, a flag distinguishing first load from later
reconnection, and optional early chunk loading.

Codex found valid implementation concerns. A network interruption cleared the
startup phase without proving that the lookup had succeeded. Static markup tests
could not establish layout stability. Resetting a loader's own memo would not by
itself reset a rejected React.lazy component, consistent with the
[React lazy contract](https://react.dev/reference/react/lazy). These were useful
observations, but they kept the discussion within the proposed design.

The user suggested skeletons for both the sidebar and conversation area. The
agents adopted that visual idea while retaining progressive pane reveal: first
the sidebar and header, then the messages. The revised plan consequently
introduced separate definitions of directory completeness, active lookup and
stalled lookup.

Another review found that those definitions disagreed with the existing
automatic paging condition, could mistake retained data for a fresh result, and
disabled mobile navigation during loading. The proposed browser setup also
warmed the assets before testing what it called a cold load.

The user interrupted the repeated revisions and asked the agents to reconsider
the product problem.

## The reset

The useful question was no longer “Which predicate makes progressive reveal
correct?” It was “Does revealing each pane a little earlier matter enough to
justify that coordination?”

For this task, the answer was no. The desired behavior reduced to three cases:

| Product situation              | Presentation                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| First load                     | One complete workspace skeleton until the initial usable view is ready, then reveal it together. |
| Startup fails                  | A clear explanation and Retry within the same frame.                                             |
| Connection drops after opening | Keep the conversation, draft, navigation and call controls visible with connection feedback.     |

vaskel. already had an access coordinator responsible for identity, authorized
navigation and the selected conversation's initial snapshot. Its successful
completion supplied the readiness decision. A second definition based on
directory pagination was unnecessary.

The revised plan kept a small account-lifetime flag to distinguish first opening
from later reconnection. It removed independent pane readiness and deferred
chunk preloading. Initialization must continue under the visual cover: replacing
Workspace with a skeleton would prevent the very effects needed to finish
startup. Hidden content must also stay out of interaction and accessibility
until revealed.

The final cover ended on actual coordinator success, not a timer. Both agents
had identified useful technical ingredients earlier; the missing decision was
whether early pane-by-pane interaction was worth preserving.

## What future agents should learn

Describe what the person should see during success, waiting and failure before
designing flags or component APIs. An internal phase needs its own presentation
only when that helps the person use the application.

Check an approach's actual requirements before rejecting it. Here, an overlay
could keep initialization running and appear only during first opening; it did
not require a timer or a cover on every reconnect. The existing coordinator
already supplied the readiness result, so the view could observe that result
without reconstructing it.

Check whether early pane interaction is worth its coordination cost. Dropping
progressive reveal removed the separate pane-readiness conditions. Moving them
into a helper would have kept the same responsibility. When reviews keep adding
exceptions around a modest benefit, reconsider that behavior before refining
another predicate.

Test a built-browser cold load, an interrupted startup with Retry and a
reconnect that preserves drafts and calls. CSS-class assertions cannot establish
those outcomes. Fresh fixture cookies in a fresh context exercise a different
boundary from signing in and reloading warm assets.

## Limits of the lesson

vaskel.'s initial destination has a bounded readiness check. Waiting for every
background roster, activity query or call negotiation would delay usable work.
Other features may benefit from progressive disclosure when useful work becomes
available substantially earlier; they need their own readiness and presentation
choices.

Later feedback in the same session was productive: the skeleton rows were moved
down to match the real timeline, conflicting button-radius classes were
corrected, and touch input observations led to Enter inserting a newline with a
separate send shortcut. Those were concrete refinements within the settled
model. Repeated conversation alone is not a failure signal; the warning sign is
multiplying obligations around a benefit whose value has not been established.

Authorization, durable command identity, stale-response rejection and provider
cleanup protect real failure boundaries. Their complexity cannot be dismissed
because the code is long. A proposed simplification should identify the user
benefit it preserves, the responsibility it removes and any guarantee it
deliberately gives up.
