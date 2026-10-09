#!/usr/bin/env python3
"""Illustrative Cloudflare monthly subtotals, using rate cards checked 2026-09-16.

Run: python3 tools/cost_model.py
     python3 tools/cost_model.py --json
     python3 tools/cost_model.py --input workloads.json --json

The input is a JSON list with the same fields as the `workload` objects in JSON
output. Each scenario is an alternative whole-account month, not an additive
tenant bill. Included allowances must be shared with any other account usage.
Traffic counts are inputs, not predictions from MAU or message counts.

DO compute and R2 use the rate cards' unit rounding after allowances. SQL,
Workers, Queues, logs and email use proportional rates; actual invoice rounding
can differ. This is a planning model, not a Cloudflare quote. Source URLs and
assumptions are in docs/sources.json and docs/costs.md.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, fields
import json
import math
from pathlib import Path


@dataclass(frozen=True)
class Workload:
    name: str
    # Informational; no other counter is derived from this field.
    text_messages: float
    worker_requests: float
    worker_cpu_ms: float
    do_http_rpc_alarm_requests: float
    do_websocket_upgrades: float
    do_incoming_ws_messages: float
    # Sum of billable active wall seconds across objects, not socket seconds.
    do_active_object_seconds: float
    do_rows_read: float
    do_rows_written: float
    do_gb_month: float
    d1_rows_read: float
    d1_rows_written: float
    d1_gb_month: float
    r2_gb_month: float
    r2_class_a: float
    r2_class_b: float
    # Includes write/read/delete and retry operations, in 64 KB chunks.
    queue_operations: float
    log_events: float
    outbound_emails: float
    # These disjoint minute buckets count each participant once.
    # Audiovisual receive bitrate includes audio, camera AND screen subscriptions.
    audio_only_participant_minutes: float
    audio_only_received_mbps: float
    audiovisual_participant_minutes: float
    audiovisual_received_mbps: float
    media_overhead_multiplier: float
    other_realtime_egress_gb: float

    def validate(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("name must be a nonempty string")
        for field in fields(self):
            if field.name == "name":
                continue
            value = getattr(self, field.name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{field.name} must be numeric")
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{field.name} must be finite and nonnegative")
        if self.media_overhead_multiplier < 1:
            raise ValueError("media_overhead_multiplier must be at least 1")


def charge(usage: float, included: float, unit: float, rate: float,
           *, round_units: bool = False) -> float:
    units = max(usage - included, 0) / unit
    return (math.ceil(units) if round_units else units) * rate


def estimate(w: Workload) -> dict:
    w.validate()
    do_request_equivalents = (
        w.do_http_rpc_alarm_requests + w.do_websocket_upgrades
        + w.do_incoming_ws_messages / 20
    )
    do_gb_seconds = w.do_active_object_seconds * 0.128
    # Decimal GB: Mbps * 1e6 bits/s * 60 s / 8 bits/byte / 1e9 bytes/GB.
    media_gb = (
        (w.audio_only_participant_minutes * w.audio_only_received_mbps
         + w.audiovisual_participant_minutes * w.audiovisual_received_mbps)
        * 0.0075 * w.media_overhead_multiplier
        + w.other_realtime_egress_gb
    )
    parts = {
        "workers": 5 + charge(w.worker_requests, 10e6, 1e6, 0.30)
                     + charge(w.worker_cpu_ms, 30e6, 1e6, 0.02),
        "do_compute": charge(do_request_equivalents, 1e6, 1e6, 0.15,
                             round_units=True)
                      + charge(do_gb_seconds, 400_000, 1e6, 12.50,
                               round_units=True),
        "do_sql": charge(w.do_rows_read, 25e9, 1e6, 0.001)
                  + charge(w.do_rows_written, 50e6, 1e6, 1.00)
                  + charge(w.do_gb_month, 5, 1, 0.20),
        "d1": charge(w.d1_rows_read, 25e9, 1e6, 0.001)
              + charge(w.d1_rows_written, 50e6, 1e6, 1.00)
              + charge(w.d1_gb_month, 5, 1, 0.75),
        "r2": charge(w.r2_gb_month, 10, 1, 0.015, round_units=True)
              + charge(w.r2_class_a, 1e6, 1e6, 4.50, round_units=True)
              + charge(w.r2_class_b, 10e6, 1e6, 0.36, round_units=True),
        "queues": charge(w.queue_operations, 1e6, 1e6, 0.40),
        "logs": charge(w.log_events, 20e6, 1e6, 0.60),
        "email": charge(w.outbound_emails, 3_000, 1_000, 0.35),
        "sfu_and_turn": charge(media_gb, 1_000, 1, 0.05),
    }
    subtotal = sum(parts.values())
    return {
        "workload": asdict(w),
        "derived": {
            "do_request_equivalents": do_request_equivalents,
            "do_gb_seconds": do_gb_seconds,
            "realtime_egress_gb": media_gb,
        },
        "monthly_usd": {key: round(value, 4) for key, value in parts.items()},
        "modeled_subtotal_usd": round(subtotal, 2),
        "excluded": [
            "Workflows, KV, Images, Stream, Containers, Workers AI, Vectorize",
            "Extra recording, transcription, adapters, and standalone TURN unless entered",
            "Support plans, domains, taxes, client distribution and engineering",
            "Unmodeled retries, physical index writes, migrations and archival copies",
        ],
    }


def scenarios() -> list[Workload]:
    workloads = []
    for name, factor, active_seconds in [
        ("Small instance", 1, 50_000),
        ("Busy instance", 10, 1_000_000),
    ]:
        workloads.append(Workload(
            name=name,
            text_messages=30_000 * factor,
            worker_requests=500_000 * factor,
            worker_cpu_ms=2_500_000 * factor,
            do_http_rpc_alarm_requests=150_000 * factor,
            do_websocket_upgrades=10_000 * factor,
            do_incoming_ws_messages=0,
            do_active_object_seconds=active_seconds,
            do_rows_read=2_000_000 * factor,
            do_rows_written=300_000 * factor,
            do_gb_month=2 * factor,
            d1_rows_read=1_000_000 * factor,
            d1_rows_written=20_000 * factor,
            d1_gb_month=0.25 * factor,
            r2_gb_month=20 * factor,
            r2_class_a=20_000 * factor,
            r2_class_b=200_000 * factor,
            queue_operations=15_000 * factor,
            log_events=200_000 * factor,
            outbound_emails=1_000 * factor,
            audio_only_participant_minutes=72_000 * factor,
            audio_only_received_mbps=0.128,
            audiovisual_participant_minutes=12_000 * factor,
            audiovisual_received_mbps=2.5,
            media_overhead_multiplier=1.2,
            other_realtime_egress_gb=0,
        ))
    return workloads


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="JSON list of alternative workloads")
    parser.add_argument("--json", action="store_true", help="Emit assumptions and results")
    args = parser.parse_args()
    if args.input:
        payload = json.loads(args.input.read_text())
        if not isinstance(payload, list) or not payload:
            parser.error("input must be a nonempty JSON list of workload objects")
        workloads = [Workload(**item) for item in payload]
    else:
        workloads = scenarios()
    results = [estimate(w) for w in workloads]
    if args.json:
        print(json.dumps(results, indent=2))
        return
    print("Illustrative monthly USD subtotals; prices checked 2026-09-16.")
    print("See --json for all workload counters, assumptions and exclusions.\n")
    print("| Cost component | " + " | ".join(w.name for w in workloads) + " |")
    print("| --- | " + " | ".join("---:" for _ in workloads) + " |")
    for key in results[0]["monthly_usd"] if results else []:
        print("| " + key + " | " + " | ".join(
            f"${r['monthly_usd'][key]:,.2f}" for r in results) + " |")
    print("| Modeled subtotal | " + " | ".join(
        f"${r['modeled_subtotal_usd']:,.2f}" for r in results) + " |")


if __name__ == "__main__":
    main()
