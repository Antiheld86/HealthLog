import { envOr } from "@/lib/env";
import { hostname } from "node:os";
import type { LoggingConfig, LogLevel, WideEvent } from "./types";
import { LOG_LEVEL_PRIORITY } from "./types";

let cachedConfig: LoggingConfig | null = null;

/** Konfiguration aus Umgebungsvariablen laden (einmal gecacht) */
export function getLoggingConfig(): LoggingConfig {
  if (cachedConfig) return cachedConfig;

  const level = envOr("LOG_LEVEL", "info") as LogLevel;

  cachedConfig = {
    level: LOG_LEVEL_PRIORITY[level] !== undefined ? level : "info",
    lokiEndpoint: process.env.LOKI_ENDPOINT || undefined,
    lokiUsername: process.env.LOKI_USERNAME || undefined,
    lokiPassword: process.env.LOKI_PASSWORD || undefined,
    sampleRate: (() => {
      const v = parseFloat(process.env.LOG_SAMPLE_RATE || "1.0");
      return Number.isNaN(v) ? 1.0 : Math.max(0, Math.min(1, v));
    })(),
    slowThresholdMs: (() => {
      const v = parseInt(process.env.LOG_SLOW_THRESHOLD_MS || "3000", 10);
      return Number.isNaN(v) ? 3000 : v;
    })(),
    includeStackTrace: process.env.LOG_INCLUDE_STACK !== "false",
    prettyPrint: process.env.NODE_ENV !== "production",
  };

  return cachedConfig;
}

/** Pruefen ob ein Level emittiert werden soll */
export function isLevelEnabled(level: LogLevel): boolean {
  const config = getLoggingConfig();
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[config.level];
}

/** Config-Cache zuruecksetzen (fuer Tests) */
export function resetLoggingConfig(): void {
  cachedConfig = null;
  cachedDeployContext = null;
}

/**
 * Deployment/Runtime-Kontext — einmal beim Start erfasst.
 * Wird in jeden WideEvent automatisch eingebettet.
 */
let cachedDeployContext: WideEvent["deploy"] | null = null;

export function getDeployContext(): WideEvent["deploy"] {
  if (cachedDeployContext) return cachedDeployContext;

  cachedDeployContext = {
    commit_hash:
      process.env.COMMIT_SHA ||
      process.env.GIT_COMMIT ||
      process.env.SOURCE_COMMIT ||
      undefined,
    version: process.env.npm_package_version || undefined,
    node_version: process.version,
    hostname: hostname(),
  };

  return cachedDeployContext;
}
