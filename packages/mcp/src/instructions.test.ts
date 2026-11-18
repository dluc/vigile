import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPERATIONS, listed } from "@vigile/core";
import { INSTRUCTIONS } from "./index.js";

/**
 * What a connecting agent is told about versions names the operations, and names them from their inputs: an
 * operation is said to take the version that was last read exactly when its input has one.
 */
describe("what an agent is told over MCP", () => {
  const has = (name: string, field: string) => Object.hasOwn(OPERATIONS.find((operation) => operation.name === name)!.input.shape, field);
  const versioned = OPERATIONS.filter((operation) => has(operation.name, "version")).map((operation) => operation.name);
  const unversioned = OPERATIONS.filter((operation) => operation.kind === "write" && !has(operation.name, "version")).map((operation) => operation.name);

  it("names the operations that take a version and the changes that take none, as their inputs have it", () => {
    assert.deepEqual(versioned, ["set_project_status", "update_task", "set_task_status", "delete", "override_timestamp"]);
    assert.deepEqual(unversioned, ["create_project", "create_task", "restore", "add_link", "remove_link", "create_user", "reset_user_key"]);
    const lines = INSTRUCTIONS.split("\n");
    assert.ok(lines.includes(`- ${listed(versioned)} take the version you last read. If one fails with a version conflict, read the current item in the error and decide again; never overwrite it automatically.`), "the operations that take a version");
    assert.ok(lines.includes(`- ${listed(unversioned)} take no version, so a conflict does not catch one that is sent twice. get_guide says what a second call of each does.`), "the changes that take none");
    // Every operation that changes something is in one of the two lines, and in one only.
    for (const operation of OPERATIONS.filter((one) => one.kind === "write")) assert.equal(versioned.includes(operation.name), !unversioned.includes(operation.name), operation.name);
    assert.doesNotMatch(INSTRUCTIONS, /Every change needs the version/);
  });

  it("says of a refusal that it names actions, and to follow one or report the blocker", () => {
    assert.ok(INSTRUCTIONS.split("\n").includes("- A refusal names the obstacle and actions. Follow an applicable action or report the blocker; do not repeat the refused call unchanged."));
  });

  it("is short: what is told before any tool is called stays under three thousand characters", () => {
    assert.ok(INSTRUCTIONS.length < 3000, `${INSTRUCTIONS.length} characters`);
  });
});
