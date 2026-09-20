import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";

import type { ChannelInboundMessage } from "./channel-types.ts";

const ROUTER_ENDPOINT_ENV = "XIANTONG_ROUTER_ENDPOINT";
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

type RouterEndpoint = {
  protocolVersion: number;
  port: number;
  token: string;
};

export type XiatongRouteTarget = {
  sessionShortId: string;
  adapter: string;
  cwd: string;
  runtimeSessionId?: string | null;
};

export type XiatongRouteDecision = {
  action: "handled" | "forward" | "reject" | "error";
  reply?: string | null;
  target?: XiatongRouteTarget | null;
  reason?: string;
};

type RouterFrameResponse = {
  ok?: boolean;
  error?: string;
  response?: XiatongRouteDecision;
};

export type XiatongHookResult =
  | { kind: "legacy" }
  | { kind: "forward"; decision: XiatongRouteDecision }
  | { kind: "handled"; reply: string; reason: string };

export type XiatongRouterHookOptions = {
  endpointPath?: string;
  timeoutMs?: number;
  request?: (
    endpoint: RouterEndpoint,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<RouterFrameResponse>;
};

export async function postBridgeEventToXiatong(
  payload: Record<string, unknown>,
  options: XiatongRouterHookOptions = {},
): Promise<boolean> {
  const endpointPath = options.endpointPath ?? process.env[ROUTER_ENDPOINT_ENV]?.trim();
  if (!endpointPath) return false;
  const endpoint = readRouterEndpoint(endpointPath);
  const request = options.request ?? sendRouterRequest;
  const frame = await request(
    endpoint,
    { type: "bridge_event", ...payload },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!frame.ok) {
    throw new Error(frame.error ?? "bridge_event_rejected");
  }
  return true;
}

export async function routeInboundThroughXiatong(
  message: ChannelInboundMessage,
  options: XiatongRouterHookOptions = {},
): Promise<XiatongHookResult> {
  const endpointPath = options.endpointPath ?? process.env[ROUTER_ENDPOINT_ENV]?.trim();
  if (!endpointPath) {
    return { kind: "legacy" };
  }

  try {
    const endpoint = readRouterEndpoint(endpointPath);
    const request = options.request ?? sendRouterRequest;
    const frame = await request(
      endpoint,
      buildRoutePayload(message),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (!frame.ok || !frame.response) {
      return failClosed(frame.error ?? "invalid_router_response");
    }
    const decision = frame.response;
    if (decision.action === "forward") {
      if (decision.reason === "queued") {
        return {
          kind: "handled",
          reply:
            decision.reply?.trim() ||
            "[遐通]\n状态：queued\n内容：任务已进入隔离队列。",
          reason: decision.reason,
        };
      }
      return { kind: "forward", decision };
    }
    if (
      decision.action === "handled" ||
      decision.action === "reject" ||
      decision.action === "error"
    ) {
      return {
        kind: "handled",
        reply: decision.reply?.trim() || defaultDecisionReply(decision.action),
        reason: decision.reason ?? decision.action,
      };
    }
    return failClosed("unsupported_router_action");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failClosed(detail);
  }
}

export function buildRoutePayload(message: ChannelInboundMessage): Record<string, unknown> {
  return {
    type: "route_inbound",
    requestId: message.id,
    message: {
      channel:
        message.conversation.channelId === "wechat"
          ? "personal-wechat"
          : message.conversation.channelId,
      senderId: message.senderId,
      conversationId: message.conversation.conversationId,
      text: message.text,
      attachments: message.attachments.map((attachment) => ({
        kind: attachment.kind,
        path: attachment.path,
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
        metadata: attachment.metadata,
      })),
      contextToken: message.conversation.opaqueRef,
      receivedAt: message.createdAt,
    },
  };
}

function readRouterEndpoint(endpointPath: string): RouterEndpoint {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
  } catch {
    throw new Error("router_endpoint_unavailable");
  }
  if (!value || typeof value !== "object") {
    throw new Error("router_endpoint_invalid");
  }
  const endpoint = value as Partial<RouterEndpoint>;
  if (
    endpoint.protocolVersion !== 1 ||
    !Number.isInteger(endpoint.port) ||
    (endpoint.port ?? 0) <= 0 ||
    typeof endpoint.token !== "string" ||
    !endpoint.token
  ) {
    throw new Error("router_endpoint_invalid");
  }
  return endpoint as RouterEndpoint;
}

function sendRouterRequest(
  endpoint: RouterEndpoint,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<RouterFrameResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: endpoint.port });
    let settled = false;
    let buffered = Buffer.alloc(0);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: crypto.randomUUID(),
          token: endpoint.token,
          payload,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_RESPONSE_BYTES) {
        finish(() => reject(new Error("router_response_too_large")));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffered.subarray(0, newline).toString("utf8");
      finish(() => {
        try {
          resolve(JSON.parse(line) as RouterFrameResponse);
        } catch {
          reject(new Error("router_response_invalid_json"));
        }
      });
    });
    socket.on("timeout", () => finish(() => reject(new Error("router_timeout"))));
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("end", () => {
      if (!settled) finish(() => reject(new Error("router_response_missing")));
    });
  });
}

function failClosed(reason: string): XiatongHookResult {
  return {
    kind: "handled",
    reason,
    reply: [
      "[遐通]",
      "状态：failed",
      "内容：消息路由服务当前不可用，本条消息未发送给 Agent。请检查遐通 Router 后重试。",
    ].join("\n"),
  };
}

function defaultDecisionReply(action: XiatongRouteDecision["action"]): string {
  if (action === "reject") {
    return "[遐通]\n状态：failed\n内容：消息已被路由策略拒绝。";
  }
  if (action === "error") {
    return "[遐通]\n状态：failed\n内容：消息路由失败，请稍后重试。";
  }
  return "[遐通]\n状态：done";
}
