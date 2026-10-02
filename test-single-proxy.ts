/**
 * Test script: runs a SINGLE proxy service in a separate process.
 * Does NOT touch the running manager or any existing proxy ports.
 *
 * Usage:
 *   bun run test-single-proxy.ts
 *
 * Tests the new waitForUpstream + connectWithRetry logic by proxying
 * port 19736 → localhost:6379 (Redis).
 *
 * Press Ctrl+C to stop.
 */
import { ProxyServiceRuntime } from "./src/proxy";

const runtime = new ProxyServiceRuntime({
  id: "test_health_check",
  name: "Test-Redis-HealthCheck",
  protocol: "tcp",
  listenHost: "0.0.0.0",  // bind to all interfaces for network testing
  listenPort: 19736,
  targetHost: "localhost",
  targetPort: 6379,
  enabled: true,
});

runtime.onStatusChange = () => {
  const snap = runtime.snapshot();
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] status: ${snap.status} | active: ${snap.activeConnections} | total: ${snap.totalConnections} | error: ${snap.lastError ?? "none"}`);
};

runtime.onChange = () => {
  const snap = runtime.snapshot();
  console.log(`  connections: ${snap.activeConnections} active / ${snap.totalConnections} total`);
};

console.log("Starting test proxy: 127.0.0.1:19736 → localhost:6379 (Redis)");
console.log("This will wait for Redis to be reachable before accepting connections.\n");

runtime.start().then(() => {
  console.log("\nProxy is RUNNING. Test with:");
  console.log("  redis-cli -p 19736 ping");
  console.log("\nPress Ctrl+C to stop.\n");
}).catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\nStopping test proxy...");
  runtime.stop();
  process.exit(0);
});
