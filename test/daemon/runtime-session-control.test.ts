import { describe, expect, test } from "bun:test";

import type {
  BridgeAdapter,
  BridgeAdapterState,
} from "../../src/bridge/bridge-types.ts";
import {
  createRuntimeSession,
  ensureTargetRuntimeSession,
  SerialIdempotentDispatcher,
} from "../../src/daemon/runtime-session-control.ts";

function fakeRuntime(
  initial: Partial<BridgeAdapterState>,
  onCreate: ((state: BridgeAdapterState) => void) | undefined,
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
    async createSession() { onCreate?.(state); },
    async reset() {},
    async resolveApproval() { return false; },
    async resolveAllApprovals() { return 0; },
    async submitUserInput() { return false; },
    async dispose() {},
    getState() { return state; },
  };
}

describe("createRuntimeSession", () => {
  test("waits for and returns a new runtime session id", async () => {
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
    const busy = fakeRuntime({ status: "busy" }, undefined);
    await expect(createRuntimeSession(busy, "claude")).rejects.toThrow(
      "must be idle",
    );

    const missing = fakeRuntime({}, undefined);
    await expect(
      createRuntimeSession(missing, "claude", {
        timeoutMs: 5,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("did not publish");
  });

  test("supports Codex runtimes with the same session contract", async () => {
    const runtime = fakeRuntime(
      { kind: "codex", sharedSessionId: "old-thread" },
      (state) => {
        state.sharedSessionId = "new-thread";
        state.activeRuntimeSessionId = "new-thread";
      },
    );
    await expect(
      createRuntimeSession(runtime, "codex", { timeoutMs: 20, pollIntervalMs: 1 }),
    ).resolves.toEqual({
      adapter: "codex",
      runtimeSessionId: "new-thread",
      previousRuntimeSessionId: "old-thread",
    });
  });

  test("rejects runtimes without the session creation contract", async () => {
    const runtime = fakeRuntime({}, undefined);
    runtime.createSession = undefined;
    await expect(createRuntimeSession(runtime, "codex")).rejects.toThrow(
      "does not support creating runtime sessions",
    );
  });
});

describe("ensureTargetRuntimeSession", () => {
  test("keeps the matching session and resumes a different target", async () => {
    let resumeCount = 0;
    const matching = fakeRuntime(
      { sharedSessionId: "session-a" },
      undefined,
    );
    matching.resumeSession = async () => { resumeCount += 1; };
    await expect(
      ensureTargetRuntimeSession(matching, "session-a"),
    ).resolves.toBe("session-a");
    expect(resumeCount).toBe(0);

    const switching = fakeRuntime(
      { sharedSessionId: "session-a" },
      undefined,
    );
    switching.resumeSession = async (sessionId) => {
      switching.getState().sharedSessionId = sessionId;
      switching.getState().activeRuntimeSessionId = sessionId;
    };
    await expect(
      ensureTargetRuntimeSession(switching, "session-b"),
    ).resolves.toBe("session-b");
  });

  test("rejects busy and mismatched resume results", async () => {
    const busy = fakeRuntime({ status: "busy" }, undefined);
    await expect(
      ensureTargetRuntimeSession(busy, "session-b"),
    ).rejects.toThrow("must be idle");

    const mismatch = fakeRuntime(
      { sharedSessionId: "session-a" },
      undefined,
    );
    await expect(
      ensureTargetRuntimeSession(mismatch, "session-b"),
    ).rejects.toThrow("mismatch after resume");
  });
});

describe("SerialIdempotentDispatcher", () => {
  test("runs duplicate request ids once and serializes one adapter", async () => {
    const dispatcher = new SerialIdempotentDispatcher();
    const order: string[] = [];
    let duplicateRuns = 0;
    const first = dispatcher.dispatch("claude", "request-1", async () => {
      duplicateRuns += 1;
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("first-end");
      return "first";
    });
    const duplicate = dispatcher.dispatch("claude", "request-1", async () => {
      duplicateRuns += 1;
      return "duplicate";
    });
    const second = dispatcher.dispatch("claude", "request-2", async () => {
      order.push("second");
      return "second";
    });

    await expect(Promise.all([first, duplicate, second])).resolves.toEqual([
      "first",
      "first",
      "second",
    ]);
    expect(duplicateRuns).toBe(1);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});
