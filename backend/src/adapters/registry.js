// Lists every data-source adapter. To add a source: create adapters/<name>.js
// exporting `name` and `fetchRecords(options, deps)`, then add it below.
// Services only ever talk to this registry, never to a specific adapter.
import * as devpost from "./devpost.js";

const ADAPTERS = [devpost];

/** @returns {string[]} adapter names */
export function adapterNames() {
  return ADAPTERS.map((a) => a.name);
}

/**
 * @param {string} name
 * @returns {{ name: string, fetchRecords: Function }}
 */
export function getAdapter(name) {
  const adapter = ADAPTERS.find((a) => a.name === name);
  if (!adapter) throw new Error(`Unknown adapter "${name}". Available: ${adapterNames().join(", ")}`);
  return adapter;
}
