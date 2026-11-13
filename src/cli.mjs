#!/usr/bin/env node
import { agyVersion } from "./agy.mjs";
import { appHome, loadConfig, resolveAgyExecutable, resolveCwd, saveConfig } from "./config.mjs";
import { discoverAgyModels } from "./models.mjs";
import { createBridgeServer, listenBridge } from "./server.mjs";
import { installService, uninstallService } from "./service.mjs";

function parseArgs(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) options[key] = inline;
    else if (args[index + 1] && !args[index + 1].startsWith("--")) options[key] = args[++index];
    else options[key] = true;
  }
  return { options, positional };
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function freshConfig(options) {
  const existing = loadConfig();
  const config = {
    ...existing,
    ...(options.cwd ? { cwd: resolveCwd(options.cwd) } : {}),
    ...(options.port ? { port: numberOption(options.port, existing.port) } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.mode && ["plan", "auto", "accept-edits"].includes(options.mode) ? { mode: options.mode } : {}),
    agyPath: resolveAgyExecutable(options.agyPath || existing.agyPath),
  };
  return config;
}

async function refreshModels(config) {
  try {
    const models = await discoverAgyModels(config.agyPath);
    const updated = { ...config, models, lastModelsRefresh: new Date().toISOString() };
    saveConfig(updated);
    return updated;
  } catch (error) {
    if (config.models?.length) return config;
    throw error;
  }
}

async function doctor(options) {
  const config = await freshConfig(options);
  let version;
  let models;
  try {
    version = await agyVersion(config.agyPath);
    models = await discoverAgyModels(config.agyPath);
  } catch (error) {
    console.log(`✗ AGY CLI: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ AGY CLI: ${version} (${config.agyPath})`);
  console.log(`✓ AGY available models: ${models.length} models`);
  for (const m of models) {
    console.log(`    - ${m.id} (${m.displayName})`);
  }
  console.log(`✓ Working directory: ${config.cwd}`);
  console.log(`✓ Mode: ${config.mode}`);

  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`);
    if (response.ok) {
      const data = await response.json();
      console.log(`✓ Antigravity Bridge server is running: http://${config.host}:${config.port} (${data.service})`);
    } else {
      console.log(`✗ Antigravity Bridge server returned HTTP ${response.status}`);
    }
  } catch {
    console.log(`! Antigravity Bridge server is not currently running. Start it with: antigravity-bridge serve`);
  }
}

async function serve(options) {
  let config = await freshConfig(options);
  config = await refreshModels(config);
  const server = createBridgeServer(config, config.models);
  await listenBridge(server, config);
  console.log(`Antigravity OpenAI /v1/ API server listening on http://${config.host}:${config.port}`);
  console.log(`OpenAI base URL: http://${config.host}:${config.port}/v1`);
  console.log(`AGY: ${config.agyPath} | cwd: ${config.cwd} | mode: ${config.mode}`);
  console.log(`Available models: ${config.models.map(m => m.id).join(", ")}`);
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0] || "serve";

  if (command === "version" || command === "--version" || command === "-v") {
    console.log("antigravity-bridge 0.2.0");
    return;
  }
  if (command === "models") {
    const config = await freshConfig(options);
    const models = await discoverAgyModels(config.agyPath);
    for (const model of models) console.log(`${model.id}\t${model.displayName}`);
    return;
  }
  if (command === "doctor") return doctor(options);
  if (command === "serve") return serve(options);
  if (command === "install") {
    const config = await freshConfig(options);
    const result = installService(config);
    if (result.installed) console.log(`Installed service: ${result.plistPath}`);
    else console.log(`Service install skipped: ${result.reason}`);
    return;
  }
  if (command === "uninstall") {
    const result = uninstallService();
    if (result.uninstalled) console.log("Service uninstalled");
    else console.log(`Service uninstall skipped: ${result.reason}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`antigravity-bridge: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
