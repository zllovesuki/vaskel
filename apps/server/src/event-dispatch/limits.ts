// Fixed topology: changing the partition count requires fresh development state.
// Native workload evidence: docs/engineering.md#event-dispatch-sizing.
export const EVENT_DISPATCH_PARTITIONS = 4;
export const EVENT_DISPATCH_SOCKET_LIMIT = 16_384;
export const EVENT_DISPATCH_TICKET_LIMIT = 4_096;
export const EVENT_DISPATCH_RECIPIENT_LIMIT = 256;
