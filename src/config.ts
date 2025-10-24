import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./types.js";

const ServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()).optional(),
});

const ConfigSchema = z.object({
  servers: z.array(ServerSchema).min(1),
});

export function loadConfig(): AppConfig {
  const p = path.resolve("config/servers.json");
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw);
  return ConfigSchema.parse(parsed);
}
