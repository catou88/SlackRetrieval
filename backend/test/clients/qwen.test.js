// Qwen client against a mock fetch; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createQwenClient, stripThinking } from "../../src/clients/qwen.js";

const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test("chat posts an OpenAI-style request and strips <think> blocks", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: "<think>hmm</think>\nHello" } }] }));
  };
  const qwen = createQwenClient({ fetchImpl, baseUrl: "http://x/v1/", model: "m" });
  assert.equal(await qwen.chat([{ role: "user", content: "hi" }]), "Hello");
  assert.equal(seen.url, "http://x/v1/chat/completions");
  assert.equal(seen.body.model, "m");
  assert.equal(seen.body.stream, false);
});

test("chat throws on HTTP errors and empty content", async () => {
  await assert.rejects(createQwenClient({ fetchImpl: reply({}, 500) }).chat([]), /500/);
  await assert.rejects(createQwenClient({ fetchImpl: reply({ choices: [] }) }).chat([]), /no message/);
});

test("isReachable is false when the endpoint is down", async () => {
  const down = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await createQwenClient({ fetchImpl: down }).isReachable(), false);
  assert.equal(await createQwenClient({ fetchImpl: reply({ data: [] }) }).isReachable(), true);
});

test("stripThinking handles multiple blocks and non-strings", () => {
  assert.equal(stripThinking("<think>a</think>X<think>b</think>"), "X");
  assert.equal(stripThinking(null), "");
});
