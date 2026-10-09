/**
 * Reference figures from docs/cost-scenarios.json, with planning budgets from
 * docs/costs.md. Rates rechecked 23 September 2026. The existing preview test
 * keeps the reference figures equal to the JSON.
 */
export const scenarios = {
  small: {
    workers: 5,
    durable: 0,
    d1: 0,
    r2: 0.15,
    email: 0,
    sfu: 0,
    egressGb: 353,
    subtotal: 5.15,
    budget: "$5–10",
  },
  busy: {
    workers: 5,
    durable: 3.15,
    d1: 0,
    r2: 2.85,
    email: 2.45,
    sfu: 126.47,
    egressGb: 3529,
    subtotal: 139.92,
    budget: "$140–180",
  },
} as const;
