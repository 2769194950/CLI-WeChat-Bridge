import type { BridgeAdapter, BridgeAdapterState } from "../bridge/bridge-types.ts";
import type { DaemonAdapterKind } from "./daemon-link.ts";

export type RuntimeSessionCreationResult = {
  adapter: DaemonAdapterKind;
  runtimeSessionId: string;
  previousRuntimeSessionId?: string;
};

type RuntimeSessionCreationOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

function getRuntimeSessionId(state: BridgeAdapterState): string | undefined {
  return state.activeRuntimeSessionId ?? state.sharedSessionId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createRuntimeSession(
  runtime: BridgeAdapter,
  adapter: DaemonAdapterKind,
  options: RuntimeSessionCreationOptions = {},
): Promise<RuntimeSessionCreationResult> {
  if (adapter !== "claude") {
    throw new Error("create_runtime_session currently supports Claude only.");
  }

  const initialState = runtime.getState();
  if (initialState.status !== "idle") {
    throw new Error(
      `Claude must be idle before creating a runtime session; current status is ${initialState.status}.`,
    );
  }

  const previousRuntimeSessionId = getRuntimeSessionId(initialState);
  await runtime.reset();

  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = runtime.getState();
    const runtimeSessionId = getRuntimeSessionId(state);
    if (runtimeSessionId && runtimeSessionId !== previousRuntimeSessionId) {
      return {
        adapter,
        runtimeSessionId,
        ...(previousRuntimeSessionId ? { previousRuntimeSessionId } : {}),
      };
    }
    await delay(pollIntervalMs);
  }

  throw new Error(
    `Claude did not publish a new runtime session id within ${timeoutMs}ms.`,
  );
}
