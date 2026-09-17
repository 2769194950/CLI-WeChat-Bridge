import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRoutePayload,
  routeInboundThroughXiatong,
} from "../../src/core/xiantong-router-hook.ts";
import type { ChannelInboundMessage } from "../../src/core/channel-types.ts";

const originalEndpoint = process.env.XIANTONG_ROUTER_ENDPOINT;
const tempPaths: string[] = [];

afterEach(() => {
  if (originalEndpoint === undefined) {
    delete process.env.XIANTONG_ROUTER_ENDPOINT;
  } else {
    process.env.XIANTONG_ROUTER_ENDPOINT = originalEndpoint;
  }
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

const message: ChannelInboundMessage = {
  id: "message-1",
  conversation: {
    channelId: "wechat",
    conversationId: "chat-1",
    recipientId: "owner",
    opaqueRef: "opaque-context",
  },
  senderId: "owner",
  text: "/xt",
  attachments: [],
  createdAt: "2026-09-17T10:00:00+08:00",
};

describe("XiaTong inbound Router hook", () => {
  test("keeps legacy behavior when no endpoint is configured", async () => {
    delete process.env.XIANTONG_ROUTER_ENDPOINT;
    expect(await routeInboundThroughXiatong(message)).toEqual({ kind: "legacy" });
  });

  test("maps channel input to the Router wire contract", () => {
    expect(buildRoutePayload(message)).toEqual({
      type: "route_inbound",
      requestId: "message-1",
      message: {
        channel: "personal-wechat",
        senderId: "owner",
        conversationId: "chat-1",
        text: "/xt",
        attachments: [],
        contextToken: "opaque-context",
        receivedAt: "2026-09-17T10:00:00+08:00",
      },
    });
  });

  test("continues only when Router explicitly returns forward", async () => {
    const endpointPath = createEndpoint();
    const result = await routeInboundThroughXiatong(message, {
      endpointPath,
      request: async () => ({
        ok: true,
        response: {
          action: "forward",
          reason: "current_session_bound",
          target: {
            sessionShortId: "A1B2",
            adapter: "claude",
            cwd: "E:\\XiaTong",
            runtimeSessionId: "runtime-a",
          },
        },
      }),
    });

    expect(result.kind).toBe("forward");
    if (result.kind === "forward") {
      expect(result.decision.target?.sessionShortId).toBe("A1B2");
    }
  });

  test("acknowledges a queued forward without direct agent delivery", async () => {
    const endpointPath = createEndpoint();
    const result = await routeInboundThroughXiatong(message, {
      endpointPath,
      request: async () => ({
        ok: true,
        response: {
          action: "forward",
          reply: "queued A1B2",
          reason: "queued",
          target: {
            sessionShortId: "A1B2",
            adapter: "claude",
            cwd: "E:\\XiaTong",
            runtimeSessionId: "runtime-a",
          },
        },
      }),
    });

    expect(result).toEqual({
      kind: "handled",
      reply: "queued A1B2",
      reason: "queued",
    });
  });

  test("handles command responses without forwarding", async () => {
    const endpointPath = createEndpoint();
    const result = await routeInboundThroughXiatong(message, {
      endpointPath,
      request: async () => ({
        ok: true,
        response: {
          action: "handled",
          reply: "[遐通]\n状态：done",
          reason: "command",
        },
      }),
    });

    expect(result).toEqual({
      kind: "handled",
      reply: "[遐通]\n状态：done",
      reason: "command",
    });
  });

  test("fails closed when configured Router is unavailable or rejects the frame", async () => {
    const unavailable = await routeInboundThroughXiatong(message, {
      endpointPath: path.join(os.tmpdir(), "missing-xiantong-endpoint.json"),
    });
    const rejected = await routeInboundThroughXiatong(message, {
      endpointPath: createEndpoint(),
      request: async () => ({ ok: false, error: "unauthorized" }),
    });

    expect(unavailable.kind).toBe("handled");
    expect(rejected.kind).toBe("handled");
    if (unavailable.kind === "handled") {
      expect(unavailable.reply).toContain("未发送给 Agent");
    }
  });
});

function createEndpoint(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xiatong-hook-"));
  tempPaths.push(directory);
  const endpointPath = path.join(directory, "router-endpoint.json");
  fs.writeFileSync(
    endpointPath,
    JSON.stringify({
      protocolVersion: 1,
      pid: process.pid,
      port: 45678,
      token: "test-token",
      startedAt: "2026-09-17T10:00:00+08:00",
    }),
  );
  return endpointPath;
}
