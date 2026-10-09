# Costs

For the example workloads below, budget about **US$5–10 a month for a small
group** or **US$140–180 for the busier instance**. These ranges use Cloudflare's
Workers paid plan and assume the account's included allowances are available.
Other projects on the account share those allowances. Domains and taxes are extra.

## Example months

| Monthly use                   | Small instance | Busy instance |
| ----------------------------- | -------------: | ------------: |
| Text messages                 |         30,000 |       300,000 |
| Audio-only participant-hours  |          1,200 |        12,000 |
| Audiovisual participant-hours |            200 |         2,000 |
| DO message storage            |           2 GB |         20 GB |
| D1 identity/directory storage |        0.25 GB |        2.5 GB |
| R2 attachments                |          20 GB |        200 GB |
| Estimated monthly bill        |      **$5–10** |  **$140–180** |

One participant-hour is one person in a call for an hour. Four people talking
for an hour use four participant-hours. These examples assume average total
receive rates of 128 kbps for audio-only calls and 2.5 Mbps for calls with video
or screen sharing, plus 20% transport overhead. The audiovisual bucket includes
all received audio; someone watching a camera and a screen occupies one bucket
at their combined bitrate.

The [calculator](../tools/cost_model.py) produces about $5 and $140 for the
[reference inputs](cost-scenarios.json). Increasing their backend request, CPU,
SQL row, R2 operation, Queue, log and active-object-time counters tenfold gives
about $5 and $180, with storage, email and media held fixed. The planning ranges
round those results and leave some room for the small example. They are
illustrative budgets, not spending caps or measured deployments.

Media usage changes the estimate more than that backend sensitivity. Halving
the audiovisual receive rate moves the busy reference example to about $70;
doubling it brings the bill to about $275 before extra backend headroom.
Several simultaneous screen or camera subscriptions add to each viewer's
receive rate.

## What gets billed

D1 and Durable Objects are metered even when a scenario falls within the
included allowance. D1 holds identity and directory data; message SQL and search
indexes live in Durable Objects. Writes also include indexes, receipts, replay,
outbox and cleanup records. Stored GB-month measures retained data, not just
the bytes added that month.

Durable Object compute includes HTTP/RPC calls, alarms, socket upgrades and
incoming application WebSocket messages. Incoming messages use the documented
20:1 request ratio; outgoing WebSocket messages and protocol pings have no
request charge. Duration sums billable active time across objects at 0.128 GB
per object. Hibernating sockets do not imply continuous duration charges.

Current owner reads batch message details and reuse broadcast lookups. Presence
sampling is read-only, changes can trigger targeted samples, and ordinary
authentication does not write activity timestamps. These choices avoid redundant
work, but SQL statement counts and billed row counts remain different measures.
[Repair reads and media heartbeats](synchronization.md#private-activity-and-repair-reads),
authorization renewals, fan-out, retries and cleanup still contribute usage.

The example counters omit typing frames. Include them for a workload with typing
activity. The [contentless trigram index](messaging.md#deletion-and-derived-text)
also adds physical writes and storage; its overhead depends on message content.
The examples are useful for budgeting, while platform usage reports show the
billable workload of a running instance.

## Rates

Rates as of 23 September 2026.

| Service       | Paid-plan allowance and overage                                                                                     | Source                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Workers       | $5/month; 10M requests and 30M CPU-ms included; then $0.30/M requests and $0.02/M CPU-ms                            | [Workers](https://developers.cloudflare.com/workers/platform/pricing/)                 |
| DO compute    | 1M request equivalents and 400,000 GB-s included; then $0.15/M requests and $12.50/M GB-s                           | [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| DO SQLite     | 25B rows read, 50M written and 5 GB included; then $0.001/M reads, $1/M writes and $0.20/GB-month                   | [DO storage](https://developers.cloudflare.com/durable-objects/platform/pricing/)      |
| D1            | 25B rows read, 50M written and 5 GB included; then $0.001/M reads, $1/M writes and $0.75/GB-month                   | [D1](https://developers.cloudflare.com/d1/platform/pricing/)                           |
| R2 Standard   | 10 GB, 1M Class A and 10M Class B operations included; then $0.015/GB-month, $4.50/M A and $0.36/M B; no egress fee | [R2](https://developers.cloudflare.com/r2/pricing/)                                    |
| Queues        | 1M operations included, then $0.40/M; a successful delivery usually uses write, read and delete                     | [Queues](https://developers.cloudflare.com/queues/platform/pricing/)                   |
| SFU/TURN      | Shared 1,000 GB/month allowance, then $0.05/GB egress                                                               | [Realtime](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)           |
| Email Sending | 3,000 emails included, then $0.35/1,000                                                                             | [Email](https://developers.cloudflare.com/email-service/platform/pricing/)             |
| Workers Logs  | 20M log events included, then $0.60/M                                                                               | [Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)     |

The calculator applies documented DO compute/R2 unit rounding and proportional
rates elsewhere; invoice rounding can differ. It excludes support, engineering,
client distribution and services absent from its counters, such as recording,
transcription and AI processing. Each object must also stay within its own
[capacity limits](operations.md#capacity-boundaries).

## Calculate another workload

```sh
python3 tools/cost_model.py
python3 tools/cost_model.py --json
python3 tools/cost_model.py --input workloads.json --json
```

Custom input is a nonempty JSON list of workload objects using the fields under
`workload` in [the reference output](cost-scenarios.json). Each object represents
a separate account-month. Enter usage counters directly; the message count does
not generate the other inputs.

Media egress uses decimal GB:

```text
egress_GB = participant_minutes × average_received_Mbps × 0.0075 × overhead_factor
SFU_cost = max(total_account_egress_GB − 1,000, 0) × $0.05
```

Use the sum of subscribed audio, camera and screen bitrates. Publishing bitrate
alone does not describe what every viewer receives. Count each participant-minute
once and avoid charging a qualifying SFU-plus-TURN path twice; see
[TURN billing](https://developers.cloudflare.com/realtime/turn/faq/).
