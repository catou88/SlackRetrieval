// Tests record validation and the adapter registry contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRecord, makeRecord } from "../../src/lib/records.js";
import { adapterNames, getAdapter } from "../../src/adapters/registry.js";

test("a well-formed record has no problems", () => {
  assert.deepEqual(validateRecord(makeRecord("sponsor", "x", "https://a.test", { name: "Acme" })), []);
});

test("bad records list every problem", () => {
  const problems = validateRecord({ kind: "alien", source: "", sourceUrl: "", data: {} });
  assert.equal(problems.length, 3);
  assert.match(validateRecord(makeRecord("project", "x", "u", {})).join(), /data\.title/);
  assert.deepEqual(validateRecord(null), ["record is not an object"]);
});

test("every registered adapter honours the contract", () => {
  for (const name of adapterNames()) {
    const adapter = getAdapter(name);
    assert.equal(adapter.name, name);
    assert.equal(typeof adapter.fetchRecords, "function");
  }
  assert.throws(() => getAdapter("nope"), /Unknown adapter/);
});
