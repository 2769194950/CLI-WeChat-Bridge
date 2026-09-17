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

export class SerialIdempotentDispatcher {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly completed = new Map<string, unknown>();

  async dispatch<T>(
    key: string,
    requestId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.completed.has(requestId)) {
      return this.completed.get(requestId) as T;
    }

    const run = async (): Promise<T> => {
      if (this.completed.has(requestId)) {
        return this.completed.get(requestId) as T;
      }
      const result = await action();
      this.completed.set(requestId, result);
      return result;
    };
    const tail = this.chains.get(key) ?? Promise.resolve();
    const queued = tail.then(run, run);
    this.chains.set(
      key,
      queued.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await queued;
  }
}

function getRuntimeSessionId(state: BridgeAdapterState): string | undefined {
  return state.activeRuntimeSessionId ?? state.sharedSessionId;
}

export async function ensureTargetRuntimeSession(
  runtime: BridgeAdapter,
  targetRuntimeSessionId: string,
): Promise<string> {
  const target = targetRuntimeSessionId.trim();
  if (!target) {
    throw new Error("runtimeSessionId must be non-empty.");
  }

  const initialState = runtime.getState();
  if (initialState.status !== "idle") {
    throw new Error(
      `Runtime must be idle before targeted routing; current status is ${initialState.status}.`,
    );
  }

  if (getRuntimeSessionId(initialState) !== target) {
    await runtime.resumeSession(target);
  }

  const actual = getRuntimeSessionId(runtime.getState());
  if (actual !== target) {
    throw new Error(
      `Runtime session mismatch after resume; expected ${target}, active ${actual ?? "none"}.`,
    );
  }
  return actual;
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
