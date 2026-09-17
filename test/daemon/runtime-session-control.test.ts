import { describe, expect, test } from "bun:test";

import type {
  BridgeAdapter,
  BridgeAdapterState,
} from "../../src/bridge/bridge-types.ts";
import { createRuntimeSession } from "../../src/daemon/runtime-session-control.ts";

function fakeRuntime(
  initial: Partial<BridgeAdapterState>,
  onReset: (state: BridgeAdapterState) => void,
): BridgeAdapter {
  const state: BridgeAdapterState = {
    kind: "claude",
    status: "idle",
    cwd: process.cwd(),
    command: "claude",
    ...initial,
  };
  return {
    setEventSink() {},
    async start() {},
    async sendInput() {},
    async listResumeSessions() { return []; },
    async resumeSession() {},
    async interrupt() { return false; },
    async reset() { onReset(state); },
    async resolveApproval() { return false; },
    async resolveAllApprovals() { return 0; },
    async submitUserInput() { return false; },
    async dispose() {},
    getState() { return state; },
  };
}

describe("createRuntimeSession", () => {
  test("waits for and returns a new Claude runtime session id", async () => {
    const runtime = fakeRuntime(
      { sharedSessionId: "old-session" },
      (state) => {
        setTimeout(() => {
          state.sharedSessionId = "new-session";
          state.activeRuntimeSessionId = "new-session";
        }, 5);
      },
    );

    await expect(
      createRuntimeSession(runtime, "claude", {
        timeoutMs: 100,
        pollIntervalMs: 2,
      }),
    ).resolves.toEqual({
      adapter: "claude",
      runtimeSessionId: "new-session",
      previousRuntimeSessionId: "old-session",
    });
  });

  test("rejects busy state and missing session id", async () => {
    const busy = fakeRuntime({ status: "busy" }, () => undefined);
    await expect(createRuntimeSession(busy, "claude")).rejects.toThrow(
      "must be idle",
    );

    const missing = fakeRuntime({}, () => undefined);
    await expect(
      createRuntimeSession(missing, "claude", {
        timeoutMs: 5,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("did not publish");
  });

  test("rejects non-Claude adapters", async () => {
    const runtime = fakeRuntime({}, () => undefined);
    await expect(createRuntimeSession(runtime, "codex")).rejects.toThrow(
      "supports Claude only",
    );
  });
});
