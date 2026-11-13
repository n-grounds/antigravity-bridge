import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseAgyLine } from "../src/agy.mjs";
import {
  buildAgyPrompt,
  decodeCompactionSummary,
  encodeCompactionSummary,
  hasImageInput,
} from "../src/prompt.mjs";
import {
  formatOpenAIModel,
  formatOpenAIModelsList,
  parseAgyModels,
  routeId,
  agyModelId,
} from "../src/models.mjs";
import { createBridgeServer, listenBridge, resolveModel } from "../src/server.mjs";

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

test("parses AGY stream-json events", () => {
  assert.equal(parseAgyLine('{"event":"step_update","step_update":{"text_delta":"ok"}}').kind, "step");
  assert.equal(parseAgyLine('{"event":"result","result":{"status":"SUCCESS"}}').kind, "result");
  assert.equal(parseAgyLine('{"event":"init","conversation_id":"c-123"}').kind, "init");
  assert.equal(parseAgyLine("not json").kind, "unknown");
});

test("parses the live agy models table shape including spinner and ANSI codes", () => {
  const rawOutput = "⠋ Fetching available models...gemini-3.8-flash-high     Gemini 3.8 Flash (High)\n" +
    "gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)\n" +
    "claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)\n";
  const models = parseAgyModels(rawOutput);
  assert.equal(models.length, 3);
  assert.equal(models[0].id, "gemini-3.8-flash-high");
  assert.equal(models[1].id, "gemini-3.8-flash-medium");
  assert.equal(models[2].id, "claude-sonnet-4-6");
});

test("formats OpenAI model objects and list", () => {
  const single = formatOpenAIModel("gemini-3.8-flash-high");
  assert.equal(single.id, "gemini-3.8-flash-high");
  assert.equal(single.object, "model");
  assert.equal(single.owned_by, "antigravity");

  const list = formatOpenAIModelsList([{ id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)" }]);
  assert.equal(list.object, "list");
  assert.ok(Array.isArray(list.data));
  assert.ok(list.data.some(m => m.id === "gemini-3.8-flash-high"));
  assert.ok(list.data.some(m => m.id === "antigravity/gemini-3.8-flash-high"));
});

test("resolves model ids with or without antigravity/ prefix", () => {
  const catalog = [
    { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)" },
    { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  ];
  assert.equal(resolveModel({ model: "gemini-3.8-flash-high" }, catalog).agy, "gemini-3.8-flash-high");
  assert.equal(resolveModel({ model: "antigravity/gemini-3.8-flash-high" }, catalog).agy, "gemini-3.8-flash-high");
  assert.equal(resolveModel({ model: "claude-sonnet-4-6" }, catalog).agy, "claude-sonnet-4-6");

  assert.throws(() => resolveModel({ model: "unknown-model" }, catalog), /Unknown model/);
  assert.throws(() => resolveModel({}, catalog), /model is required/);
});

test("builds a prompt from OpenAI Chat messages input", () => {
  const prompt = buildAgyPrompt({
    messages: [
      { role: "system", content: "You are a helpful coding assistant." },
      { role: "user", content: "Hello world in python" },
      { role: "assistant", content: "print('Hello, world!')" },
      { role: "user", content: "Now in javascript" },
    ],
  });
  assert.match(prompt, /System instructions:\n.*You are a helpful coding assistant\./);
  assert.match(prompt, /User:\nHello world in python/);
  assert.match(prompt, /Assistant:\nprint\('Hello, world!'\)/);
  assert.match(prompt, /User:\nNow in javascript/);
});

test("builds a prompt from text completions prompt", () => {
  const prompt = buildAgyPrompt({
    prompt: "Write a haiku about code",
  });
  assert.equal(prompt, "Write a haiku about code");
});

test("builds a prompt from Responses input", () => {
  const prompt = buildAgyPrompt({
    instructions: "Be concise.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Reply AGY_OK" }] }],
  });
  assert.match(prompt, /System instructions/);
  assert.match(prompt, /Reply AGY_OK/);
});

test("formats tool_calls in OpenAI chat messages", () => {
  const prompt = buildAgyPrompt({
    messages: [
      {
        role: "assistant",
        content: "Checking files",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "ls", arguments: '{"path":"."}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "index.js package.json",
      },
    ],
  });
  assert.match(prompt, /Assistant:\nChecking files\nTool call \(ls\):\n\{"path":"\."\}/);
  assert.match(prompt, /Tool output \(call_123\):\nindex\.js package\.json/);
});

test("extracts image parts and detects image input", () => {
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "https://example.com/test.png" } },
        ],
      },
    ],
  };
  assert.equal(hasImageInput(payload), true);
  const prompt = buildAgyPrompt(payload);
  assert.match(prompt, /MANDATORY IMAGE PREFLIGHT/);
  assert.match(prompt, /\[Image URL: https:\/\/example\.com\/test\.png\]/);
});

test("compaction encoding and decoding round-trip", () => {
  const summary = "State checkpoint: finished step 1";
  const encoded = encodeCompactionSummary(summary);
  assert.equal(decodeCompactionSummary(encoded), summary);
});

test("OpenAI /v1/ API server: /healthz, /v1/models, /v1/chat/completions (streaming and non-streaming)", async () => {
  const agyDir = mkdtempSync(join(tmpdir(), "agy-mock-"));
  const agyPath = join(agyDir, "agy");

  // Mock agy CLI script that inspects command line args and handles stream-json
  writeFileSync(agyPath, `#!/usr/bin/env node
const modelIdx = process.argv.indexOf("--model");
const model = modelIdx >= 0 ? process.argv[modelIdx + 1] : "default-model";
const effortIdx = process.argv.indexOf("--effort");
const effort = effortIdx >= 0 ? process.argv[effortIdx + 1] : "none";

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.event === "user") {
      const convId = "conv-12345";
      const userText = typeof msg.message?.content === "string" ? msg.message.content : JSON.stringify(msg.message);
      const reply = "Reply from " + model + " [effort:" + effort + "]: echoing " + userText.slice(0, 30);
      
      const outLines = [
        JSON.stringify({ event: "init", conversation_id: convId }),
        JSON.stringify({ event: "step_update", step_update: { conversation_id: convId, text_delta: "Chunk1: " } }),
        JSON.stringify({ event: "step_update", step_update: { conversation_id: convId, text_delta: reply } }),
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Chunk1: " + reply, conversation_id: convId, usage: { input_tokens: 15, output_tokens: 10, total_tokens: 25 } } }),
      ];
      process.stdout.write(outLines.join("\\n") + "\\n", () => process.exit(0));
    }
  }
});
`);
  chmodSync(agyPath, 0o700);

  const config = {
    host: "127.0.0.1",
    port: 0,
    agyPath,
    cwd: process.cwd(),
    mode: "accept-edits",
    requestTimeoutSec: 10,
  };
  const catalog = [
    { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)" },
    { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  ];
  const bridge = createBridgeServer(config, catalog);
  await listenBridge(bridge, config);
  const port = bridge.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Test /healthz
    const healthRes = await fetch(`${baseUrl}/healthz`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, "antigravity-bridge");
    assert.equal(healthJson.model_count, 2);

    // 2. Test GET /v1/models
    const modelsRes = await fetch(`${baseUrl}/v1/models`);
    assert.equal(modelsRes.status, 200);
    const modelsJson = await modelsRes.json();
    assert.equal(modelsJson.object, "list");
    assert.ok(modelsJson.data.some(m => m.id === "gemini-3.8-flash-high"));
    assert.ok(modelsJson.data.some(m => m.id === "claude-sonnet-4-6"));

    // 3. Test GET /v1/models/:model
    const singleModelRes = await fetch(`${baseUrl}/v1/models/gemini-3.8-flash-high`);
    assert.equal(singleModelRes.status, 200);
    const singleModelJson = await singleModelRes.json();
    assert.equal(singleModelJson.id, "gemini-3.8-flash-high");
    assert.equal(singleModelJson.object, "model");

    const notFoundModelRes = await fetch(`${baseUrl}/v1/models/nonexistent-model`);
    assert.equal(notFoundModelRes.status, 404);

    // 4. Test POST /v1/chat/completions (Non-streaming)
    const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "Hello Antigravity" }],
        reasoning_effort: "high",
        stream: false,
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatJson = await chatRes.json();
    assert.equal(chatJson.object, "chat.completion");
    assert.equal(chatJson.model, "gemini-3.8-flash-high");
    assert.equal(chatJson.choices.length, 1);
    assert.equal(chatJson.choices[0].finish_reason, "stop");
    assert.match(chatJson.choices[0].message.content, /Chunk1: Reply from gemini-3\.8-flash-high \[effort:high\]/);
    assert.equal(chatJson.usage.prompt_tokens, 15);
    assert.equal(chatJson.usage.completion_tokens, 10);
    assert.equal(chatJson.usage.total_tokens, 25);

    // 5. Test POST /v1/chat/completions (Streaming SSE)
    const streamRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Stream test" }],
        stream: true,
      }),
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get("content-type"), /text\/event-stream/);
    const streamText = await streamRes.text();
    const lines = streamText.split("\n");
    const dataLines = lines.filter(l => l.startsWith("data: "));
    assert.ok(dataLines.length >= 3);
    assert.equal(dataLines[dataLines.length - 1], "data: [DONE]");

    // Verify first chunk has assistant role
    const firstChunk = JSON.parse(dataLines[0].slice(6));
    assert.equal(firstChunk.object, "chat.completion.chunk");
    assert.equal(firstChunk.choices[0].delta.role, "assistant");

    // Verify final chunk before [DONE] has finish_reason "stop"
    const finishChunk = JSON.parse(dataLines[dataLines.length - 2].slice(6));
    assert.equal(finishChunk.choices[0].finish_reason, "stop");

    // 6. Test POST /v1/completions (Text completion)
    const cmplRes = await fetch(`${baseUrl}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash-high",
        prompt: "Complete this sentence",
        stream: false,
      }),
    });
    assert.equal(cmplRes.status, 200);
    const cmplJson = await cmplRes.json();
    assert.equal(cmplJson.object, "text_completion");
    assert.match(cmplJson.choices[0].text, /Chunk1:/);

    // 7. Test CORS preflight (OPTIONS)
    const optionsRes = await fetch(`${baseUrl}/v1/chat/completions`, { method: "OPTIONS" });
    assert.equal(optionsRes.status, 204);
    assert.equal(optionsRes.headers.get("access-control-allow-origin"), "*");

    // 8. Test Error Handling
    // Missing model
    const errRes1 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(errRes1.status, 400);
    const errJson1 = await errRes1.json();
    assert.equal(errJson1.error.code, "MODEL_REQUIRED");

    // Unknown model
    const errRes2 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nonexistent", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(errRes2.status, 404);
    const errJson2 = await errRes2.json();
    assert.equal(errJson2.error.code, "MODEL_NOT_FOUND");

    // Empty messages
    const errRes3 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.8-flash-high", messages: [] }),
    });
    assert.equal(errRes3.status, 400);

  } finally {
    await closeServer(bridge);
    rmSync(agyDir, { recursive: true, force: true });
  }
});
