import assert from "node:assert/strict";
import { it } from "node:test";
import { browserEnvironment } from "./browser-driver.js";

it("does not give test Chromium a desktop D-Bus session", () => {
  const source = { PATH: "/bin", HOME: "/home/example", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/example" };
  assert.deepEqual(browserEnvironment(source), { PATH: "/bin", HOME: "/home/example" });
  assert.deepEqual(source, { PATH: "/bin", HOME: "/home/example", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/example" }, "the caller's environment is untouched");
});
