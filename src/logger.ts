import { mkdirSync } from "node:fs";
import { join } from "node:path";
import winston from "winston";

// Project-relative: <repo>/Reddis/logs
const LOG_DIR = process.env.LOG_DIR ?? join(import.meta.dir, "..", "logs");

mkdirSync(LOG_DIR, { recursive: true });

const { combine, timestamp, errors, json } = winston.format;

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: combine(timestamp(), errors({ stack: true }), json()),
  transports: [
    new winston.transports.File({
      filename: join(LOG_DIR, "manager.log"),
      options: { flags: "a" },
    }),
    new winston.transports.File({
      filename: join(LOG_DIR, "manager.error.log"),
      level: "error",
      options: { flags: "a" },
    }),
  ],
});

if (process.env.LOG_CONSOLE === "1") {
  logger.add(
    new winston.transports.Console({
      format: combine(timestamp(), json()),
    }),
  );
}
