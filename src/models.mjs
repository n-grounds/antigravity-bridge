import { spawn } from "node:child_process";

export const MODEL_PREFIX = "antigravity/";
export const AGY_CONTEXT_WINDOW = 1_000_000;
export const AGY_AUTO_COMPACT_TOKEN_LIMIT = 800_000;

export function isAntigravityModel(value) {
  return typeof value === "string" && value.startsWith(MODEL_PREFIX);
}

export const FALLBACK_AGY_MODELS = [
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
  ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
].map(([id, displayName]) => ({ id, displayName }));

function runAgyModels(agyPath, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(agyPath, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`agy models timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cannot start ${agyPath}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim().split("\n").slice(-3).join(" ");
        reject(new Error(`agy models failed (${code ?? signal ?? "signal"})${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export function parseAgyModels(text) {
  // Strip ANSI escape codes
  const clean = String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const models = [];
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^model(s)?$/i.test(trimmed)) continue;
    if (/fetching available models/i.test(trimmed)) {
      const afterSpinner = trimmed.replace(/.*fetching available models\.\.\./i, "").trim();
      if (afterSpinner) {
        const match = afterSpinner.match(/^(\S+)\s+(.+?)\s*$/);
        if (match && /^[A-Za-z0-9._-]+$/.test(match[1])) {
          models.push({ id: match[1], displayName: match[2] });
        }
      }
      continue;
    }
    const match = trimmed.match(/^(\S+)\s+(.+?)\s*$/);
    if (!match || !/^[A-Za-z0-9._-]+$/.test(match[1])) continue;
    models.push({ id: match[1], displayName: match[2] });
  }
  return dedupeModels(models);
}

function dedupeModels(models) {
  const seen = new Set();
  return models.filter(model => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

export async function discoverAgyModels(agyPath) {
  try {
    const parsed = parseAgyModels(await runAgyModels(agyPath));
    if (parsed.length > 0) return parsed;
  } catch {
    // If agy models command fails, fall back to default catalog
  }
  return FALLBACK_AGY_MODELS;
}

export function routeId(modelId) {
  return modelId.startsWith(MODEL_PREFIX) ? modelId : `${MODEL_PREFIX}${modelId}`;
}

export function agyModelId(route) {
  return route.startsWith(MODEL_PREFIX) ? route.slice(MODEL_PREFIX.length) : route;
}

export function formatOpenAIModel(modelOrId) {
  const id = typeof modelOrId === "string" ? modelOrId : modelOrId?.id;
  return {
    id,
    object: "model",
    created: 1700000000,
    owned_by: "antigravity",
    permission: [],
    root: id,
    parent: null,
  };
}

export function formatOpenAIModelsList(models) {
  const data = [];
  const seen = new Set();
  for (const m of models) {
    const id = typeof m === "string" ? m : m.id;
    if (!seen.has(id)) {
      seen.add(id);
      data.push(formatOpenAIModel(id));
    }
    const prefixed = routeId(id);
    if (!seen.has(prefixed)) {
      seen.add(prefixed);
      data.push(formatOpenAIModel(prefixed));
    }
  }
  return {
    object: "list",
    data,
  };
}
