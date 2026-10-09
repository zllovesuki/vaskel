/** Acknowledge a peer close without writing a runtime-only status to the wire. */
export function acknowledgeSocketClose(socket: WebSocket, code: number) {
  // An abnormal disconnect or TLS failure leaves no peer to acknowledge.
  if (code === 1006 || code === 1015) return;
  // 1005 represents an empty Close frame; close() sends the same empty frame.
  socket.close(code === 1005 ? undefined : code);
}
