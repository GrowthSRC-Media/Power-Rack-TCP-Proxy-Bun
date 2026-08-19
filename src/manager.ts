import chalk from "chalk";
import readline from "node:readline";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  createDefaultService,
  ProxyServiceRuntime,
  type DomainRoute,
  type ProxyServiceConfig,
  type ProxyServiceSnapshot,
  validateService,
} from "./proxy";
import { logger } from "./logger";

process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { err: err instanceof Error ? { message: err.message, stack: err.stack } : err });
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason });
});

const CONFIG_FILE = join(import.meta.dir, "..", "services.json");

class ProxyManagerApp {
  private services: ProxyServiceConfig[] = [];
  private runtimes = new Map<string, ProxyServiceRuntime>();
  private selectedIndex = 0;
  private _statusMessage = "";
  private shuttingDown = false;
  private suspended = false;
  private activeAction: string | null = null;
  private lastScreenContent = "";
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  private get statusMessage() {
    return this._statusMessage;
  }

  private set statusMessage(value: string) {
    this._statusMessage = value;
    this.renderNow();
  }

  async start() {
    logger.info("manager.start");
    // Enter alternate screen buffer (like htop/vim) and hide cursor
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    await this.loadServices();
    await this.startEnabledServices();
    this.setupInput();
    this.render();
    // Refresh stats (connection counts) every 2 seconds instead of on every event
    this.statsInterval = setInterval(() => {
      if (!this.suspended && !this.shuttingDown) {
        this.lastScreenContent = "";
        this.render();
      }
    }, 2000);
  }

  private renderNow() {
    if (this.suspended || this.shuttingDown) return;
    this.lastScreenContent = "";
    this.render();
  }

  private async loadServices() {
    this.services = await this.readConfigFile();
    this.ensureSelectionInBounds();
  }

  private async readConfigFile() {
    try {
      const content = await fs.readFile(CONFIG_FILE, "utf8");
      const parsed = JSON.parse(content) as unknown;

      if (!Array.isArray(parsed)) {
        throw new Error("services.json must contain an array.");
      }

      return parsed.map((item) => this.normalizeService(item));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.writeConfigFile([]);
        return [];
      }

      this.statusMessage = `Config load error: ${message}`;
      return [];
    }
  }

  private normalizeService(raw: unknown): ProxyServiceConfig {
    const item = (raw ?? {}) as Record<string, unknown>;

    return {
      id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
      name: typeof item.name === "string" ? item.name : "unnamed-service",
      protocol: item.protocol === "udp" ? "udp" : "tcp",
      listenHost:
        typeof item.listenHost === "string" && item.listenHost.trim()
          ? item.listenHost
          : "0.0.0.0",
      listenPort: this.toPort(item.listenPort, 9000),
      targetHost:
        typeof item.targetHost === "string" && item.targetHost.trim()
          ? item.targetHost
          : "localhost",
      targetPort: this.toPort(item.targetPort, 9001),
      enabled: typeof item.enabled === "boolean" ? item.enabled : true,
      domainRoutes: this.normalizeDomainRoutes(item.domainRoutes),
    };
  }

  private toPort(value: unknown, fallback: number) {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 1 && numeric <= 65535
      ? numeric
      : fallback;
  }

  private normalizeDomainRoutes(raw: unknown): DomainRoute[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const routes: DomainRoute[] = [];
    for (const r of raw) {
      if (r && typeof r === "object" && typeof (r as Record<string, unknown>).domain === "string") {
        const item = r as Record<string, unknown>;
        routes.push({
          domain: String(item.domain),
          targetHost: typeof item.targetHost === "string" && item.targetHost.trim() ? item.targetHost : "localhost",
          targetPort: this.toPort(item.targetPort, 80),
        });
      }
    }
    return routes.length > 0 ? routes : undefined;
  }

  private async writeConfigFile(services: ProxyServiceConfig[]) {
    const content = `${JSON.stringify(services, null, 2)}\n`;
    await fs.writeFile(CONFIG_FILE, content, "utf8");
  }

  private async persistServices() {
    await this.writeConfigFile(this.services);
  }

  private setupInput() {
    readline.emitKeypressEvents(process.stdin);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdin.on("keypress", async (_, key) => {
      if (this.suspended || this.shuttingDown) {
        return;
      }

      if (!key) {
        return;
      }

      if (key.ctrl && key.name === "c") {
        this.shutdown("ctrl-c");
        return;
      }

      switch (key.name) {
        case "up":
        case "k":
          this.moveSelection(-1);
          break;
        case "down":
        case "j":
          this.moveSelection(1);
          break;
        case "a":
          await this.withSuspendedUI("a", () => this.addServiceFlow());
          break;
        case "e":
          await this.withSuspendedUI("e", () => this.editSelectedFlow());
          break;
        case "s":
          await this.toggleSelectedService();
          break;
        case "d":
          await this.withSuspendedUI("d", () => this.deleteSelectedFlow());
          break;
        case "r":
          await this.reloadServices();
          break;
        case "q":
          this.shutdown("key-q");
          break;
      }

      this.renderNow();
    });

    process.on("SIGINT", () => {
      this.shutdown("sigint");
    });
  }

  private async withSuspendedUI(actionKey: string, action: () => Promise<void>) {
    this.suspended = true;
    this.activeAction = actionKey;

    // Leave alternate screen for interactive prompts, show cursor
    process.stdout.write("\x1b[?1049l\x1b[?25h");
    process.stdout.write("\x1b[2J\x1b[H");
    const pw = Math.max(process.stdout.columns || 80, 60);
    process.stdout.write(chalk.cyan.bold(` TCP Proxy Manager `) + chalk.gray(` > ${actionKey}`) + "\n");
    process.stdout.write(chalk.cyan("\u2500".repeat(pw)) + "\n");
    process.stdout.write(chalk.gray("  Fill in each field. Press Enter to confirm. Esc to cancel.\n\n"));

    try {
      await action();
    } catch (error) {
      if (error instanceof Error && error.message === "USER_CANCEL") {
        this.statusMessage = "Cancelled.";
      } else {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("manager.action.error", { action: actionKey, err: message });
        this.statusMessage = `Error: ${message}`;
      }
    } finally {
      this.activeAction = null;
      this.suspended = false;
      // Re-enter alternate screen, hide cursor
      process.stdout.write("\x1b[?1049h\x1b[?25l");
      this.lastScreenContent = "";
      this.render();
    }
  }

  private async prompt(question: string, initialValue = ""): Promise<string> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Interactive prompts require a TTY terminal.");
    }

    const suffix = initialValue ? chalk.gray(` (${initialValue})`) : "";
    const label = `  ${chalk.green("?")} ${question}${suffix}: `;
    process.stdout.write(label);

    let buffer = "";

    return new Promise<string>((resolve, reject) => {
      const onKeypress = (_: unknown, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
        if (!key) return;

        // Escape → cancel
        if (key.name === "escape") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("USER_CANCEL"));
          return;
        }

        // Ctrl+C → kill app
        if (key.ctrl && key.name === "c") {
          cleanup();
          this.shutdown("ctrl-c");
          return;
        }

        // Enter → submit
        if (key.name === "return") {
          cleanup();
          process.stdout.write("\n");
          resolve(buffer.trim() || initialValue);
          return;
        }

        // Backspace
        if (key.name === "backspace") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            process.stdout.write("\b \b");
          }
          return;
        }

        // Regular character
        if (key.sequence && !key.ctrl && key.sequence.length === 1 && key.sequence >= " ") {
          buffer += key.sequence;
          process.stdout.write(key.sequence);
        }
      };

      const cleanup = () => {
        process.stdin.removeListener("keypress", onKeypress);
      };

      process.stdin.on("keypress", onKeypress);
    });
  }

  private isYes(value: string) {
    return ["y", "yes"].includes(value.trim().toLowerCase());
  }

  private async confirm(question: string) {
    const answer = await this.prompt(`${question} (y/N)`, "n");
    return answer.trim().toLowerCase() === "y";
  }

  private moveSelection(offset: number) {
    if (this.services.length === 0) {
      this.selectedIndex = 0;
      return;
    }

    const nextIndex = this.selectedIndex + offset;
    this.selectedIndex = Math.min(
      Math.max(nextIndex, 0),
      this.services.length - 1,
    );
    this.renderNow();
  }

  private ensureSelectionInBounds() {
    if (this.services.length === 0) {
      this.selectedIndex = 0;
      return;
    }

    this.selectedIndex = Math.min(this.selectedIndex, this.services.length - 1);
  }

  private getSelectedService() {
    return this.services[this.selectedIndex] ?? null;
  }

  private getSnapshot(service: ProxyServiceConfig): ProxyServiceSnapshot {
    return (
      this.runtimes.get(service.id)?.snapshot() ?? {
        ...service,
        status: "stopped",
        activeConnections: 0,
        totalConnections: 0,
        lastError: null,
        lastEventAt: null,
      }
    );
  }

  private async startEnabledServices() {
    for (const service of this.services) {
      if (service.enabled) {
        await this.startService(service.id);
      }
    }
  }

  private async startService(serviceId: string) {
    const service = this.services.find((item) => item.id === serviceId);

    if (!service) {
      return;
    }

    let runtime = this.runtimes.get(service.id);
    if (!runtime) {
      runtime = new ProxyServiceRuntime(service);
      runtime.onStatusChange = () => this.renderNow();
      this.runtimes.set(service.id, runtime);
    }

    try {
      await runtime.start();
      this.statusMessage = `Started "${service.name}" on ${service.listenHost}:${service.listenPort}`;
      logger.info("manager.service.started", { id: service.id, name: service.name });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusMessage = `Start failed for "${service.name}": ${message}`;
      logger.error("manager.service.start_failed", { id: service.id, name: service.name, err: message });
    }
  }

  private stopService(serviceId: string) {
    const service = this.services.find((item) => item.id === serviceId);
    const runtime = this.runtimes.get(serviceId);

    runtime?.stop();
    this.runtimes.delete(serviceId);

    if (service) {
      this.statusMessage = `Stopped "${service.name}"`;
      logger.info("manager.service.stopped", { id: service.id, name: service.name });
    }
  }

  private async toggleSelectedService() {
    const service = this.getSelectedService();

    if (!service) {
      this.statusMessage = "No service selected.";
      return;
    }

    const snapshot = this.getSnapshot(service);

    if (snapshot.status === "running" || snapshot.status === "starting" || snapshot.status === "waiting") {
      this.stopService(service.id);
    } else {
      await this.startService(service.id);
    }
  }

  private async promptProtocol(current: "tcp" | "udp"): Promise<"tcp" | "udp"> {
    const answer = (await this.prompt("Protocol (tcp/udp)", current)).trim().toLowerCase();
    if (answer === "udp" || answer === "u") return "udp";
    if (answer === "tcp" || answer === "t") return "tcp";
    return current;
  }

  private async addServiceFlow() {
    const draft = createDefaultService();
    draft.name = await this.prompt("Service name", draft.name);
    draft.protocol = await this.promptProtocol(draft.protocol);
    draft.targetHost = await this.prompt("Target host (IP or hostname)", draft.targetHost);
    draft.targetPort = this.toPort(
      await this.prompt("Target port (your app runs on)", String(draft.targetPort)),
      draft.targetPort,
    );
    draft.listenPort = this.toPort(
      await this.prompt("Listen port (exposed to internet)", String(draft.listenPort)),
      draft.listenPort,
    );

    if (this.isYes(await this.prompt("Add domain routes? y/n", "n"))) {
      draft.domainRoutes = await this.editDomainRoutesFlow([]);
    }

    draft.enabled = this.isYes(await this.prompt("Start immediately? y/n", "y"));

    const errors = validateService(draft, this.services);
    if (errors.length > 0) {
      this.statusMessage = errors.join(" ");
      return;
    }

    this.services.push(draft);
    this.selectedIndex = this.services.length - 1;
    await this.persistServices();

    if (draft.enabled) {
      await this.startService(draft.id);
    } else {
      this.statusMessage = `Added "${draft.name}"`;
    }
  }

  private async editSelectedFlow() {
    const selected = this.getSelectedService();

    if (!selected) {
      this.statusMessage = "No service selected.";
      return;
    }

    const updated: ProxyServiceConfig = {
      ...selected,
      name: await this.prompt("Service name", selected.name),
      protocol: await this.promptProtocol(selected.protocol),
      targetHost: await this.prompt("Default target host", selected.targetHost),
      targetPort: this.toPort(
        await this.prompt("Application port (your app runs on)", String(selected.targetPort)),
        selected.targetPort,
      ),
      listenHost: selected.listenHost,
      listenPort: this.toPort(
        await this.prompt("Network/router port (exposed to internet)", String(selected.listenPort)),
        selected.listenPort,
      ),
      enabled:
        this.isYes(
          await this.prompt(
            "Auto-start on app launch? y/n",
            selected.enabled ? "y" : "n",
          ),
        ),
    };

    const hasRoutes = selected.domainRoutes && selected.domainRoutes.length > 0;
    const routePrompt = hasRoutes
      ? `Manage domain routes? (${selected.domainRoutes!.length} configured) y/n`
      : "Add domain routes? y/n";
    if (this.isYes(await this.prompt(routePrompt, hasRoutes ? "y" : "n"))) {
      updated.domainRoutes = await this.editDomainRoutesFlow(selected.domainRoutes ?? []);
    }

    const errors = validateService(updated, this.services);
    if (errors.length > 0) {
      this.statusMessage = errors.join(" ");
      return;
    }

    const wasRunning = ["running", "starting"].includes(
      this.getSnapshot(selected).status,
    );

    this.stopService(selected.id);
    this.services = this.services.map((item) =>
      item.id === selected.id ? updated : item,
    );
    await this.persistServices();

    if (updated.enabled || wasRunning) {
      await this.startService(updated.id);
    } else {
      this.statusMessage = `Updated "${updated.name}"`;
    }
  }

  private async deleteSelectedFlow() {
    const selected = this.getSelectedService();

    if (!selected) {
      this.statusMessage = "No service selected.";
      return;
    }

    const confirmed = await this.confirm(`Delete "${selected.name}"?`);
    if (!confirmed) {
      this.statusMessage = `Delete cancelled for "${selected.name}"`;
      return;
    }

    this.stopService(selected.id);
    this.services = this.services.filter((item) => item.id !== selected.id);
    this.ensureSelectionInBounds();
    await this.persistServices();
    this.statusMessage = `Deleted "${selected.name}"`;
  }

  private async editDomainRoutesFlow(existing: DomainRoute[]): Promise<DomainRoute[] | undefined> {
    const routes = [...existing];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      process.stdout.write("\n");
      if (routes.length === 0) {
        process.stdout.write(chalk.gray("  No domain routes configured.\n"));
      } else {
        process.stdout.write(chalk.cyan("  Current domain routes:\n"));
        for (let i = 0; i < routes.length; i++) {
          const r = routes[i]!;
          process.stdout.write(
            `  ${chalk.yellow(`${i + 1}.`)} ${chalk.white(r.domain)} ${chalk.gray("→")} ${chalk.green(`${r.targetHost}:${r.targetPort}`)}\n`,
          );
        }
      }
      process.stdout.write("\n");

      const action = await this.prompt("(a)dd / (d)elete #N / (done)", "done");

      if (action.toLowerCase() === "done" || action.toLowerCase() === "") {
        break;
      }

      if (action.toLowerCase() === "a") {
        const domain = await this.prompt("Domain (e.g., app.example.com or *.example.com)");
        if (!domain.trim()) continue;
        const targetHost = await this.prompt("Target host (LAN IP)", "localhost");
        const targetPort = this.toPort(await this.prompt("Target port", "443"), 443);
        routes.push({ domain: domain.trim(), targetHost, targetPort });
        continue;
      }

      if (action.toLowerCase().startsWith("d")) {
        const numStr = action.replace(/^d\s*/i, "").trim();
        const idx = parseInt(numStr, 10) - 1;
        if (idx >= 0 && idx < routes.length) {
          const removed = routes.splice(idx, 1)[0]!;
          process.stdout.write(chalk.red(`  Removed: ${removed.domain}\n`));
        } else {
          process.stdout.write(chalk.red(`  Invalid index. Use d1, d2, etc.\n`));
        }
      }
    }

    return routes.length > 0 ? routes : undefined;
  }

  private async reloadServices() {
    const activeIds = new Set(
      this.services
        .filter((service) => {
          const status = this.getSnapshot(service).status;
          return status === "running" || status === "starting";
        })
        .map((service) => service.id),
    );

    for (const runtime of this.runtimes.values()) {
      runtime.stop();
    }
    this.runtimes.clear();

    await this.loadServices();

    for (const service of this.services) {
      if (service.enabled || activeIds.has(service.id)) {
        await this.startService(service.id);
      }
    }

    this.statusMessage = "Reloaded services from services.json";
  }

  private render() {
    const screen = this.buildScreen();
    if (screen === this.lastScreenContent) return;
    this.lastScreenContent = screen;
    // Move cursor home, overwrite in place, clear remaining lines below
    process.stdout.write("\x1b[H");
    process.stdout.write(screen);
    process.stdout.write("\x1b[J");
  }

  private buildScreen() {
    const snapshots = this.services.map((service) => this.getSnapshot(service));
    const lines: string[] = [];
    const w = Math.max(process.stdout.columns || 80, 60);

    // Top border
    lines.push(chalk.cyan(`\u250C${"".padEnd(w - 2, "\u2500")}\u2510`));

    // Title
    const title = " TCP Proxy Manager ";
    const titlePad = Math.max(0, w - 2 - title.length);
    const titleLeft = Math.floor(titlePad / 2);
    const titleRight = titlePad - titleLeft;
    lines.push(
      chalk.cyan("\u2502") +
      " ".repeat(titleLeft) +
      chalk.bold.white(title) +
      " ".repeat(titleRight) +
      chalk.cyan("\u2502"),
    );

    // Subtitle
    const runningCount = snapshots.filter((s) => s.status === "running").length;
    const waitingCount = snapshots.filter((s) => s.status === "waiting").length;
    const suffix = waitingCount > 0 ? ` (${waitingCount} waiting)` : "";
    const subtitle = `${runningCount}/${snapshots.length} services running${suffix}`;
    const subPad = Math.max(0, w - 2 - subtitle.length);
    const subLeft = Math.floor(subPad / 2);
    const subRight = subPad - subLeft;
    lines.push(
      chalk.cyan("\u2502") +
      " ".repeat(subLeft) +
      chalk.gray(subtitle) +
      " ".repeat(subRight) +
      chalk.cyan("\u2502"),
    );

    // Separator
    lines.push(chalk.cyan(`\u251C${"".padEnd(w - 2, "\u2500")}\u2524`));

    // Table
    lines.push(...this.renderTable(snapshots, w));

    // Separator
    lines.push(chalk.cyan(`\u251C${"".padEnd(w - 2, "\u2500")}\u2524`));

    // Details panel
    lines.push(...this.renderDetails(this.getSelectedService(), w));

    // Separator
    lines.push(chalk.cyan(`\u251C${"".padEnd(w - 2, "\u2500")}\u2524`));

    // Controls bar
    lines.push(this.renderControls(w));

    // Status message
    if (this.statusMessage) {
      const msgLine = ` ${this.statusMessage}`;
      const msgPad = Math.max(0, w - 2 - msgLine.length);
      lines.push(
        chalk.cyan("\u2502") +
        chalk.yellow(msgLine) +
        " ".repeat(msgPad) +
        chalk.cyan("\u2502"),
      );
    }

    // Bottom border
    lines.push(chalk.cyan(`\u2514${"".padEnd(w - 2, "\u2500")}\u2518`));

    return lines.join("\n") + "\n";
  }

  private padRow(content: string, w: number) {
    const plain = content.replace(/\x1B\[[0-9;]*m/g, "");
    const pad = Math.max(0, w - 2 - plain.length);
    return chalk.cyan("\u2502") + content + " ".repeat(pad) + chalk.cyan("\u2502");
  }

  private renderControls(w: number) {
    const actions = [
      { key: "a", label: "add" },
      { key: "e", label: "edit" },
      { key: "s", label: "start/stop" },
      { key: "d", label: "delete" },
      { key: "r", label: "reload" },
      { key: "q", label: "quit" },
    ];

    const buttons = actions.map(({ key, label }) => {
      if (this.activeAction === key) {
        return chalk.bgCyan.black(` ${key} `) + chalk.white(` ${label}`);
      }
      return chalk.cyan.bold(` ${key} `) + chalk.gray(` ${label}`);
    });

    const content = " " + buttons.join(chalk.gray("  \u2502  "));
    return this.padRow(content, w);
  }

  private renderTable(snapshots: ProxyServiceSnapshot[], w: number) {
    const lines: string[] = [];

    if (snapshots.length === 0) {
      lines.push(this.padRow(chalk.gray("  No services configured. Press 'a' to add one."), w));
      return lines;
    }

    // Header
    const hdr =
      "   " +
      chalk.gray(this.fit("SERVICE", 16)) + "  " +
      chalk.gray(this.fit("TARGET", 22)) + "  " +
      chalk.gray(this.fit("LISTEN", 8)) + "  " +
      chalk.gray(this.fit("STATUS", 10)) + "  " +
      chalk.gray(this.fit("CONN", 6)) + "  " +
      chalk.gray(this.fit("AUTO", 4));
    lines.push(this.padRow(hdr, w));

    // Rows
    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i];
      const selected = i === this.selectedIndex;

      const indicator = selected ? chalk.cyan("\u25B6") : " ";
      const statusDot = this.statusDot(snap.status);
      const statusText = this.colorStatus(snap.status, snap.status);
      const autoIcon = snap.enabled ? chalk.green("\u2713") : chalk.gray("\u2717");
      const svc = this.services[i]!;
      const targetStr = `${snap.targetHost}:${snap.targetPort}`;

      const row =
        ` ${indicator} ` +
        (selected ? chalk.white.bold(this.fit(snap.name, 16)) : chalk.white(this.fit(snap.name, 16))) + "  " +
        chalk.yellow(this.fit(targetStr, 22)) + "  " +
        chalk.magenta(this.fit(String(snap.listenPort), 8)) + "  " +
        `${statusDot} ${statusText}` + " ".repeat(Math.max(0, 7 - snap.status.length)) + "  " +
        chalk.white(this.fit(String(snap.activeConnections), 6)) + "  " +
        autoIcon;

      if (selected) {
        const plain = row.replace(/\x1B\[[0-9;]*m/g, "");
        const rowPad = Math.max(0, w - 2 - plain.length);
        lines.push(chalk.cyan("\u2502") + chalk.bgGray(row + " ".repeat(rowPad)) + chalk.cyan("\u2502"));
      } else {
        lines.push(this.padRow(row, w));
      }

      // Domain route sub-rows
      if (svc.domainRoutes) {
        for (const route of svc.domainRoutes) {
          const subRow =
            "     " +
            chalk.gray(this.fit(route.domain, 16)) + "  " +
            chalk.green(this.fit(`${route.targetHost}:${route.targetPort}`, 22));
          lines.push(this.padRow(subRow, w));
        }
      }
    }

    return lines;
  }

  private statusDot(status: ProxyServiceSnapshot["status"]) {
    switch (status) {
      case "running":
        return chalk.green("\u25CF");
      case "starting":
        return chalk.yellow("\u25CF");
      case "waiting":
        return chalk.blue("\u25CF");
      case "error":
        return chalk.red("\u25CF");
      default:
        return chalk.gray("\u25CB");
    }
  }

  private renderDetails(selected: ProxyServiceConfig | null, w: number) {
    const lines: string[] = [];

    if (!selected) {
      lines.push(this.padRow(chalk.gray("  No service selected."), w));
      return lines;
    }

    const snapshot = this.getSnapshot(selected);
    const statusDot = this.statusDot(snapshot.status);

    lines.push(this.padRow(` ${chalk.bold.white(selected.name)}  ${statusDot} ${this.colorStatus(snapshot.status, snapshot.status)}`, w));
    lines.push(this.padRow("", w));
    lines.push(this.padRow(`  ${chalk.gray("Protocol")}         ${chalk.cyan(selected.protocol.toUpperCase())}`, w));
    lines.push(this.padRow(`  ${chalk.gray("App Endpoint")}     ${chalk.white(selected.targetHost)}${chalk.gray(":")}${chalk.yellow(String(selected.targetPort))}`, w));
    lines.push(this.padRow(`  ${chalk.gray("Network Endpoint")}  ${chalk.white(selected.listenHost)}${chalk.gray(":")}${chalk.magenta(String(selected.listenPort))}`, w));
    lines.push(this.padRow(`  ${chalk.gray("Connections")}       ${chalk.white(String(snapshot.activeConnections))} ${chalk.gray("active")} ${chalk.gray("/")} ${chalk.white(String(snapshot.totalConnections))} ${chalk.gray("total")}`, w));

    if (selected.domainRoutes && selected.domainRoutes.length > 0) {
      lines.push(this.padRow("", w));
      lines.push(this.padRow(`  ${chalk.gray("Domain Routes")}     ${chalk.cyan(String(selected.domainRoutes.length))} ${chalk.gray("configured")}`, w));
      for (const route of selected.domainRoutes) {
        lines.push(this.padRow(`    ${chalk.white(route.domain)} ${chalk.gray("\u2192")} ${chalk.green(`${route.targetHost}:${route.targetPort}`)}`, w));
      }
    }

    if (snapshot.lastError) {
      lines.push(this.padRow(`  ${chalk.gray("Last Error")}        ${chalk.red(snapshot.lastError)}`, w));
    }

    return lines;
  }

  private fit(value: string, width: number) {
    const plain = value.replace(/\x1B\[[0-9;]*m/g, "");

    if (plain.length === width) {
      return value;
    }

    if (plain.length > width) {
      return `${plain.slice(0, Math.max(0, width - 1))}…`;
    }

    return `${value}${" ".repeat(width - plain.length)}`;
  }

  private colorStatus(text: string, status: ProxyServiceSnapshot["status"]) {
    switch (status) {
      case "running":
        return chalk.green(text);
      case "starting":
        return chalk.yellow(text);
      case "waiting":
        return chalk.blue(text);
      case "error":
        return chalk.red(text);
      default:
        return chalk.gray(text);
    }
  }

  private shutdown(reason: string = "unknown") {
    if (this.shuttingDown) {
      return;
    }

    logger.info("manager.shutdown", { reason });
    this.shuttingDown = true;
    if (this.statsInterval) clearInterval(this.statsInterval);

    for (const runtime of this.runtimes.values()) {
      runtime.stop();
    }
    this.runtimes.clear();

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    // Leave alternate screen buffer, show cursor
    process.stdout.write("\x1b[?1049l\x1b[?25h");
    process.stdout.write(chalk.cyan("\u25CB") + chalk.gray(" Proxy Manager stopped.\n"));
    process.exit(0);
  }
}

const app = new ProxyManagerApp();
app.start().catch((err) => {
  logger.error("fatal.start", { err: err instanceof Error ? { message: err.message, stack: err.stack } : err });
  process.exit(1);
});
