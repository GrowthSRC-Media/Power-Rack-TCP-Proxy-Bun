import net from "node:net";
import { logger } from "./logger";

const LOG_PAYLOAD = process.env.PROXY_LOG_PAYLOAD === "1";

export type ServiceStatus = "stopped" | "starting" | "waiting" | "running" | "error";

export type ProxyProtocol = "tcp" | "udp";

export type ProxyServiceConfig = {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  enabled: boolean;
};

export type ProxyServiceSnapshot = ProxyServiceConfig & {
  status: ServiceStatus;
  activeConnections: number;
  totalConnections: number;
  lastError: string | null;
  lastEventAt: string | null;
};

type ListenerLike = {
  stop(closeActiveConnections?: boolean): void;
};

type SocketLike = {
  write(data: Uint8Array): void;
  end(): void;
};

type RuntimeState = {
  listener: ListenerLike | null;
  status: ServiceStatus;
  activeConnections: number;
  totalConnections: number;
  lastError: string | null;
  lastEventAt: string | null;
  clientSockets: Set<SocketLike>;
  upstreamSockets: Set<SocketLike>;
  upstreamByClient: WeakMap<SocketLike, Promise<SocketLike>>;
};

function toMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function createServiceId() {
  return `svc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultService(): ProxyServiceConfig {
  return {
    id: createServiceId(),
    name: "new-service",
    protocol: "tcp",
    listenHost: "0.0.0.0",
    listenPort: 9000,
    targetHost: "localhost",
    targetPort: 9001,
    enabled: true,
  };
}

export function validateService(
  service: ProxyServiceConfig,
  existingServices: ProxyServiceConfig[],
) {
  const errors: string[] = [];

  if (!service.name.trim()) {
    errors.push("Service name is required.");
  }

  for (const [label, value] of [
    ["listenPort", service.listenPort],
    ["targetPort", service.targetPort],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      errors.push(`${label} must be an integer between 1 and 65535.`);
    }
  }

  if (!service.listenHost.trim()) {
    errors.push("listenHost is required.");
  }

  if (!service.targetHost.trim()) {
    errors.push("targetHost is required.");
  }

  const duplicateName = existingServices.find(
    (item) =>
      item.id !== service.id &&
      item.name.trim().toLowerCase() === service.name.trim().toLowerCase(),
  );

  if (duplicateName) {
    errors.push(`Service name "${service.name}" already exists.`);
  }

  if (service.protocol !== "tcp" && service.protocol !== "udp") {
    errors.push("protocol must be either 'tcp' or 'udp'.");
  }

  const duplicatePort = existingServices.find(
    (item) =>
      item.id !== service.id &&
      item.protocol === service.protocol &&
      item.listenHost === service.listenHost &&
      item.listenPort === service.listenPort,
  );

  if (duplicatePort) {
    errors.push(
      `Listen port ${service.listenHost}:${service.listenPort} is already in use by "${duplicatePort.name}".`,
    );
  }

  return errors;
}

export class ProxyServiceRuntime {
  readonly config: ProxyServiceConfig;
  private readonly state: RuntimeState;
  onChange: (() => void) | null = null;
  onStatusChange: (() => void) | null = null;
  private _prevStatus: ServiceStatus = "stopped";
  private log: ReturnType<typeof logger.child>;
  private bytesIn = 0;
  private bytesOut = 0;
  private _startAbort: AbortController | null = null;

  constructor(config: ProxyServiceConfig) {
    this.config = { ...config };
    this.log = logger.child({ service: config.name, svcId: config.id });
    this.state = {
      listener: null,
      status: "stopped",
      activeConnections: 0,
      totalConnections: 0,
      lastError: null,
      lastEventAt: null,
      clientSockets: new Set(),
      upstreamSockets: new Set(),
      upstreamByClient: new WeakMap(),
    };
  }

  snapshot(): ProxyServiceSnapshot {
    return {
      ...this.config,
      status: this.state.status,
      activeConnections: this.state.activeConnections,
      totalConnections: this.state.totalConnections,
      lastError: this.state.lastError,
      lastEventAt: this.state.lastEventAt,
    };
  }

  async start() {
    if (this.state.listener || this.state.status === "starting" || this.state.status === "waiting") {
      return;
    }

    this._startAbort = new AbortController();
    this.mark("starting");
    this.log.info("proxy.listen.attempt", {
      protocol: this.config.protocol,
      listenHost: this.config.listenHost,
      listenPort: this.config.listenPort,
      targetHost: this.config.targetHost,
      targetPort: this.config.targetPort,
    });

    if (this.config.protocol === "udp") {
      await this.startUdp();
      return;
    }

    // TCP path: use node:net so stream.pipe() handles backpressure correctly.
    // The previous Bun.listen-based path silently dropped bytes when the
    // destination kernel buffer was full (Bun's socket.write returns a short
    // count under backpressure). That corrupted Next.js JS chunks and produced
    // ERR_INVALID_CHUNKED_ENCODING in the browser.
    await this.startTcpNodeNet();
    return;

    try {
      const listener = Bun.listen({
        hostname: this.config.listenHost,
        port: this.config.listenPort,
        socket: {
          open: (clientSocket) => {
            const socket = clientSocket as unknown as SocketLike;
            this.state.clientSockets.add(socket);
            this.state.activeConnections += 1;
            this.state.totalConnections += 1;
            this.state.lastEventAt = new Date().toISOString();
            this.log.info("proxy.client.open", {
              activeConnections: this.state.activeConnections,
              totalConnections: this.state.totalConnections,
              remoteAddress: (clientSocket as { remoteAddress?: string }).remoteAddress,
            });
            this.onChange?.();

            const upstreamPromise = this.connectUpstream(socket);
            // Prevent unhandled-rejection if the client never sends data before upstream fails.
            upstreamPromise.catch(() => socket.end());
            this.state.upstreamByClient.set(socket, upstreamPromise);
          },
          data: (clientSocket, data) => {
            const socket = clientSocket as unknown as SocketLike;
            const upstream = this.state.upstreamByClient.get(socket);
            this.bytesIn += data.byteLength;
            this.log.debug("proxy.client.data", {
              bytes: data.byteLength,
              bytesInTotal: this.bytesIn,
              ...(LOG_PAYLOAD && {
                preview: Buffer.from(data.slice(0, 64)).toString("hex"),
              }),
            });

            // CRITICAL: Bun reuses the underlying buffer across reads. Since we
            // forward via a microtask (.then), we MUST copy before yielding or
            // subsequent reads will overwrite this chunk mid-flight — corrupts
            // HTTP/1.1 chunked responses (ERR_INVALID_CHUNKED_ENCODING).
            const copy = new Uint8Array(data.byteLength);
            copy.set(data);

            upstream
              ?.then((upstreamSocket) => {
                upstreamSocket.write(copy);
              })
              .catch((error) => {
                this.markError(
                  `Failed to forward client data for "${this.config.name}": ${toMessage(error)}`,
                );
                socket.end();
              });
          },
          close: (clientSocket) => {
            const socket = clientSocket as unknown as SocketLike;
            this.closeClient(socket);
          },
          error: (_, error) => {
            this.markError(
              `Client error on "${this.config.name}": ${toMessage(error)}`,
            );
          },
        },
      }) as unknown as ListenerLike;

      this.state.listener = listener;
      this.mark("running");
      this.log.info("proxy.listen.ok", {
        listenHost: this.config.listenHost,
        listenPort: this.config.listenPort,
      });
    } catch (error) {
      this.state.listener = null;
      this.markError(
        `Unable to start "${this.config.name}" on ${this.config.listenHost}:${this.config.listenPort}: ${toMessage(error)}`,
      );
      throw error;
    }
  }

  private async startTcpNodeNet() {
    await this.waitForUpstream(
      this.config.targetHost,
      this.config.targetPort,
      this._startAbort!.signal,
    );

    return new Promise<void>((resolve, reject) => {
      const server = net.createServer(async (clientSocket) => {
        this.state.activeConnections += 1;
        this.state.totalConnections += 1;
        this.state.lastEventAt = new Date().toISOString();
        this.log.info("proxy.client.open", {
          activeConnections: this.state.activeConnections,
          totalConnections: this.state.totalConnections,
          remoteAddress: clientSocket.remoteAddress,
        });
        this.onChange?.();

        const controller = new AbortController();
        clientSocket.on("close", () => controller.abort());
        clientSocket.on("error", () => controller.abort());

        // Pause client until upstream is ready (prevents unbounded buffering during retry)
        clientSocket.pause();

        let upstream: net.Socket;
        try {
          upstream = await this.connectWithRetry(
            this.config.targetPort,
            this.config.targetHost,
            controller.signal,
          );
        } catch {
          this.log.warn("proxy.upstream.gaveUp", {
            name: this.config.name,
            targetHost: this.config.targetHost,
            targetPort: this.config.targetPort,
          });
          clientSocket.destroy();
          this.state.activeConnections = Math.max(0, this.state.activeConnections - 1);
          this.onChange?.();
          return;
        }

        if (clientSocket.destroyed) {
          upstream.destroy();
          this.state.activeConnections = Math.max(0, this.state.activeConnections - 1);
          this.onChange?.();
          return;
        }

        clientSocket.resume();

        const cleanup = () => {
          this.state.activeConnections = Math.max(0, this.state.activeConnections - 1);
          this.state.lastEventAt = new Date().toISOString();
          this.onChange?.();
        };

        // pipe() handles backpressure: pauses source when destination is full,
        // resumes on drain. No manual buffering, no dropped bytes.
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);

        clientSocket.on("error", (err) => {
          this.log.debug("proxy.client.error", { err: err.message });
          upstream.destroy();
        });
        upstream.on("error", (err) => {
          this.markError(`Upstream error on "${this.config.name}": ${err.message}`);
          clientSocket.destroy();
        });

        let closed = false;
        const onClose = () => {
          if (closed) return;
          closed = true;
          cleanup();
        };
        clientSocket.on("close", onClose);
        upstream.on("close", onClose);

        if (LOG_PAYLOAD) {
          clientSocket.on("data", (d) => {
            this.bytesIn += d.byteLength;
            this.log.debug("proxy.client.data", { bytes: d.byteLength });
          });
          upstream.on("data", (d) => {
            this.bytesOut += d.byteLength;
            this.log.debug("proxy.upstream.data", { bytes: d.byteLength });
          });
        } else {
          clientSocket.on("data", (d) => { this.bytesIn += d.byteLength; });
          upstream.on("data", (d) => { this.bytesOut += d.byteLength; });
        }
      });

      server.on("error", (err) => {
        this.state.listener = null;
        this.markError(
          `Unable to start "${this.config.name}" on ${this.config.listenHost}:${this.config.listenPort}: ${err.message}`,
        );
        reject(err);
      });

      server.listen(this.config.listenPort, this.config.listenHost, () => {
        this.state.listener = {
          stop: () => {
            server.close();
          },
        };
        this.mark("running");
        this.log.info("proxy.listen.ok", {
          protocol: "tcp",
          listenHost: this.config.listenHost,
          listenPort: this.config.listenPort,
        });
        resolve();
      });
    });
  }

  private async startUdp() {
    await this.waitForUpstream(
      this.config.targetHost,
      this.config.targetPort,
      this._startAbort!.signal,
    );

    try {
      const upstreamByClient = new Map<string, { send: (buf: Uint8Array) => void; close: () => void }>();
      const self = this;

      const serverSocket: any = await (Bun as any).udpSocket({
        hostname: this.config.listenHost,
        port: this.config.listenPort,
        socket: {
          data(_socket: any, buf: Uint8Array, port: number, address: string) {
            const key = `${address}:${port}`;
            self.bytesIn += buf.byteLength;
            self.state.lastEventAt = new Date().toISOString();

            // Copy: Bun may reuse this buffer before our async forward runs.
            const datagram = new Uint8Array(buf.byteLength);
            datagram.set(buf);

            let upstream = upstreamByClient.get(key);
            if (!upstream) {
              self.state.totalConnections += 1;
              self.state.activeConnections += 1;
              self.onChange?.();

              const pending: Uint8Array[] = [datagram];
              let ready: any = null;

              const idleMs = 30_000;
              let idleTimer: ReturnType<typeof setTimeout>;
              const resetIdle = () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                  upstream?.close();
                }, idleMs);
              };
              resetIdle();

              (Bun as any).udpSocket({
                socket: {
                  data(_s: any, rbuf: Uint8Array) {
                    self.bytesOut += rbuf.byteLength;
                    self.state.lastEventAt = new Date().toISOString();
                    resetIdle();
                    try {
                      serverSocket.send(rbuf, port, address);
                    } catch (err) {
                      self.markError(`UDP reply send failed: ${toMessage(err)}`);
                    }
                  },
                },
              })
                .then((u: any) => {
                  ready = u;
                  for (const p of pending) {
                    u.send(p, self.config.targetPort, self.config.targetHost);
                  }
                  pending.length = 0;
                })
                .catch((err: unknown) => {
                  self.markError(`UDP upstream connect failed: ${toMessage(err)}`);
                  upstreamByClient.delete(key);
                });

              upstream = {
                send(b: Uint8Array) {
                  resetIdle();
                  if (ready) {
                    ready.send(b, self.config.targetPort, self.config.targetHost);
                  } else {
                    pending.push(b);
                  }
                },
                close() {
                  clearTimeout(idleTimer);
                  try { ready?.close(); } catch {}
                  if (upstreamByClient.delete(key)) {
                    self.state.activeConnections = Math.max(0, self.state.activeConnections - 1);
                    self.onChange?.();
                  }
                },
              };
              upstreamByClient.set(key, upstream);
              return;
            }

            upstream.send(datagram);
          },
        },
      });

      this.state.listener = {
        stop: () => {
          for (const u of upstreamByClient.values()) u.close();
          upstreamByClient.clear();
          try { serverSocket.close(); } catch {}
        },
      };
      this.mark("running");
      this.log.info("proxy.listen.ok", {
        protocol: "udp",
        listenHost: this.config.listenHost,
        listenPort: this.config.listenPort,
      });
    } catch (error) {
      this.state.listener = null;
      this.markError(
        `Unable to start "${this.config.name}" (udp) on ${this.config.listenHost}:${this.config.listenPort}: ${toMessage(error)}`,
      );
      throw error;
    }
  }

  private async waitForUpstream(
    targetHost: string,
    targetPort: number,
    signal: AbortSignal,
    timeoutMs = 120_000,
    intervalMs = 2_000,
  ): Promise<void> {
    this.mark("waiting");
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("Start aborted");

      const reachable = await new Promise<boolean>((resolve) => {
        const sock = net.connect(targetPort, targetHost);
        const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 3_000);
        sock.on("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
        sock.on("error", () => { clearTimeout(timer); resolve(false); });
      });

      if (reachable) {
        this.log.info("proxy.upstream.ready", { targetHost, targetPort });
        return;
      }

      this.log.debug("proxy.upstream.notReady", { targetHost, targetPort });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, intervalMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Start aborted"));
        }, { once: true });
      });
    }

    throw new Error(`Upstream ${targetHost}:${targetPort} not reachable after ${timeoutMs / 1000}s`);
  }

  private async connectWithRetry(
    targetPort: number,
    targetHost: string,
    signal: AbortSignal,
    maxRetries = 3,
    initialDelayMs = 1_000,
  ): Promise<net.Socket> {
    let delay = initialDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) throw new Error("Client disconnected");

      try {
        return await new Promise<net.Socket>((resolve, reject) => {
          const sock = net.connect(targetPort, targetHost);
          sock.on("connect", () => resolve(sock));
          sock.on("error", (err) => { sock.destroy(); reject(err); });
        });
      } catch (err) {
        if (attempt === maxRetries) throw err;

        this.log.info("proxy.upstream.retry", {
          attempt: attempt + 1,
          maxRetries,
          delay,
          targetHost,
          targetPort,
        });

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Client disconnected"));
          }, { once: true });
        });

        delay = Math.min(delay * 2, 8_000);
      }
    }

    throw new Error("Unreachable");
  }

  stop() {
    this._startAbort?.abort();
    this._startAbort = null;

    this.log.info("proxy.stop", {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      totalConnections: this.state.totalConnections,
    });
    this.state.listener?.stop(true);
    this.state.listener = null;

    for (const socket of this.state.clientSockets) {
      socket.end();
    }

    for (const socket of this.state.upstreamSockets) {
      socket.end();
    }

    this.state.clientSockets.clear();
    this.state.upstreamSockets.clear();
    this.state.activeConnections = 0;
    this.mark("stopped");
  }

  private connectUpstream(clientSocket: SocketLike) {
    return Bun.connect({
      hostname: this.config.targetHost,
      port: this.config.targetPort,
      socket: {
        // Forward responses from the upstream service back to the client.
        open: (upstreamSocket) => {
          this.state.upstreamSockets.add(upstreamSocket as unknown as SocketLike);
          this.state.lastEventAt = new Date().toISOString();
          this.log.info("proxy.upstream.open", {
            targetHost: this.config.targetHost,
            targetPort: this.config.targetPort,
          });
        },
        data: (_, data) => {
          this.bytesOut += data.byteLength;
          this.log.debug("proxy.upstream.data", {
            bytes: data.byteLength,
            bytesOutTotal: this.bytesOut,
            ...(LOG_PAYLOAD && {
              preview: Buffer.from(data.slice(0, 64)).toString("hex"),
            }),
          });
          // CRITICAL: same buffer-reuse hazard as the client→upstream path.
          // Bun reuses the underlying memory for the next read, and even though
          // clientSocket.write looks synchronous it can defer under backpressure
          // (kernel buffer full), so the bytes we hand it may be overwritten
          // before they leave the box. This corrupts large/streamed responses
          // (Next.js JS chunks → ERR_INVALID_CHUNKED_ENCODING). Copy first.
          const copy = new Uint8Array(data.byteLength);
          copy.set(data);
          clientSocket.write(copy);
        },
        close: (upstreamSocket) => {
          this.state.upstreamSockets.delete(
            upstreamSocket as unknown as SocketLike,
          );
          clientSocket.end();
        },
        error: (upstreamSocket, error) => {
          this.state.upstreamSockets.delete(
            upstreamSocket as unknown as SocketLike,
          );
          this.markError(
            `Upstream error on "${this.config.name}": ${toMessage(error)}`,
          );
          clientSocket.end();
        },
      },
    }).catch((error) => {
      this.markError(
        `Unable to connect to upstream ${this.config.targetHost}:${this.config.targetPort} for "${this.config.name}": ${toMessage(error)}`,
      );
      throw error;
    }) as Promise<SocketLike>;
  }

  private closeClient(clientSocket: SocketLike) {
    if (this.state.clientSockets.delete(clientSocket)) {
      this.state.activeConnections = Math.max(0, this.state.activeConnections - 1);
      this.state.lastEventAt = new Date().toISOString();
      this.onChange?.();
    }

    this.state.upstreamByClient
      .get(clientSocket)
      ?.then((upstreamSocket) => {
        upstreamSocket.end();
        this.state.upstreamSockets.delete(upstreamSocket);
      })
      .catch(() => {
        // The connect attempt already recorded an error, so nothing else is needed here.
      });
  }

  private mark(status: ServiceStatus) {
    const changed = this._prevStatus !== status;
    this._prevStatus = status;
    this.state.status = status;
    this.state.lastEventAt = new Date().toISOString();

    if (status !== "error") {
      this.state.lastError = null;
    }

    this.onChange?.();
    if (changed) this.onStatusChange?.();
  }

  private markError(message: string) {
    const changed = this._prevStatus !== "error";
    this._prevStatus = "error";
    this.state.status = "error";
    this.state.lastError = message;
    this.log.error("proxy.error", { message });
    this.state.lastEventAt = new Date().toISOString();
    this.onChange?.();
    if (changed) this.onStatusChange?.();
  }
}
