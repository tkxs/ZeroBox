import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef } from "react";

type BatchableGatewayBridgeEvent = {
  type: "token" | "thinking";
  text: string;
  conversationId: string;
  round: number | null;
};

type PendingGatewayBridgeEventBatch = BatchableGatewayBridgeEvent & {
  requestId: string;
  workerId?: string;
  rafId: number | null;
  timeoutId: number | null;
  microtaskQueued: boolean;
};

type GatewayBridgeSendOptions = {
  workerId?: string;
};

const GATEWAY_BRIDGE_BATCH_MAX_DELAY_MS = 32;
const GATEWAY_BRIDGE_BATCH_MAX_TEXT_LENGTH = 640;

function normalizeGatewayBridgeBatchRound(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shouldFlushGatewayBridgeBatchWithoutAnimationFrame() {
  if (typeof document === "undefined") {
    return false;
  }
  return document.visibilityState !== "visible";
}

function toBatchableGatewayBridgeEvent(
  event: Record<string, unknown>,
): BatchableGatewayBridgeEvent | null {
  const type = event.type;
  if ((type !== "token" && type !== "thinking") || typeof event.text !== "string") {
    return null;
  }
  if (event.text.length === 0) {
    return null;
  }

  for (const key of Object.keys(event)) {
    if (key !== "type" && key !== "text" && key !== "conversation_id" && key !== "round") {
      return null;
    }
  }

  return {
    type,
    text: event.text,
    conversationId: typeof event.conversation_id === "string" ? event.conversation_id : "",
    round: normalizeGatewayBridgeBatchRound(event.round),
  };
}

export function useGatewayBridgeBatcher() {
  const gatewayEventChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingGatewayBridgeEventBatchesRef = useRef(
    new Map<string, PendingGatewayBridgeEventBatch>(),
  );

  const sendGatewayBridgeEventForRequest = useCallback(
    (requestId: string, event: Record<string, unknown>, options?: GatewayBridgeSendOptions) => {
      const workerId = options?.workerId?.trim() || undefined;
      gatewayEventChainRef.current = gatewayEventChainRef.current
        .catch(() => undefined)
        .then(() =>
          invoke("gateway_send_chat_event", {
            request_id: requestId,
            event,
            worker_id: workerId,
          } as any),
        )
        .then(() => undefined)
        .catch((error) => {
          console.warn("gateway_send_chat_event failed", error);
        });
    },
    [],
  );

  const flushGatewayBridgeEventBatchForRequest = useCallback(
    (requestId: string) => {
      const pending = pendingGatewayBridgeEventBatchesRef.current.get(requestId);
      if (!pending) {
        return;
      }

      pendingGatewayBridgeEventBatchesRef.current.delete(requestId);
      if (pending.rafId !== null) {
        cancelAnimationFrame(pending.rafId);
      }
      if (pending.timeoutId !== null) {
        window.clearTimeout(pending.timeoutId);
      }
      pending.microtaskQueued = false;
      if (!pending.text) {
        return;
      }

      sendGatewayBridgeEventForRequest(requestId, {
        type: pending.type,
        text: pending.text,
        conversation_id: pending.conversationId,
        ...(pending.round !== null ? { round: pending.round } : {}),
      }, {
        workerId: pending.workerId,
      });
    },
    [sendGatewayBridgeEventForRequest],
  );

  const scheduleGatewayBridgeEventBatchFlush = useCallback(
    (requestId: string) => {
      const pending = pendingGatewayBridgeEventBatchesRef.current.get(requestId);
      if (!pending) {
        return;
      }

      if (shouldFlushGatewayBridgeBatchWithoutAnimationFrame()) {
        if (pending.microtaskQueued) {
          return;
        }
        pending.microtaskQueued = true;
        queueMicrotask(() => {
          const currentPending = pendingGatewayBridgeEventBatchesRef.current.get(requestId);
          if (!currentPending) {
            return;
          }
          currentPending.microtaskQueued = false;
          flushGatewayBridgeEventBatchForRequest(requestId);
        });
        return;
      }

      if (pending.timeoutId === null) {
        pending.timeoutId = window.setTimeout(() => {
          const currentPending = pendingGatewayBridgeEventBatchesRef.current.get(requestId);
          if (!currentPending) {
            return;
          }
          currentPending.timeoutId = null;
          flushGatewayBridgeEventBatchForRequest(requestId);
        }, GATEWAY_BRIDGE_BATCH_MAX_DELAY_MS);
      }

      if (pending.rafId !== null) {
        return;
      }
      pending.rafId = requestAnimationFrame(() => {
        const currentPending = pendingGatewayBridgeEventBatchesRef.current.get(requestId);
        if (!currentPending) {
          return;
        }
        currentPending.rafId = null;
        flushGatewayBridgeEventBatchForRequest(requestId);
      });
    },
    [flushGatewayBridgeEventBatchForRequest],
  );

  const queueGatewayBridgeEventForRequest = useCallback(
    (requestId: string, event: Record<string, unknown>, options?: GatewayBridgeSendOptions) => {
      const batchable = toBatchableGatewayBridgeEvent(event);
      if (!batchable) {
        flushGatewayBridgeEventBatchForRequest(requestId);
        sendGatewayBridgeEventForRequest(requestId, event, options);
        return;
      }

      const workerId = options?.workerId?.trim() || undefined;
      const existing = pendingGatewayBridgeEventBatchesRef.current.get(requestId);
      if (
        existing &&
        existing.type === batchable.type &&
        existing.conversationId === batchable.conversationId &&
        existing.round === batchable.round &&
        existing.workerId === workerId
      ) {
        existing.text += batchable.text;
        if (existing.text.length >= GATEWAY_BRIDGE_BATCH_MAX_TEXT_LENGTH) {
          flushGatewayBridgeEventBatchForRequest(requestId);
          return;
        }
        scheduleGatewayBridgeEventBatchFlush(requestId);
        return;
      }

      flushGatewayBridgeEventBatchForRequest(requestId);
      pendingGatewayBridgeEventBatchesRef.current.set(requestId, {
        requestId,
        workerId,
        ...batchable,
        rafId: null,
        timeoutId: null,
        microtaskQueued: false,
      });
      if (batchable.text.length >= GATEWAY_BRIDGE_BATCH_MAX_TEXT_LENGTH) {
        flushGatewayBridgeEventBatchForRequest(requestId);
        return;
      }
      scheduleGatewayBridgeEventBatchFlush(requestId);
    },
    [
      flushGatewayBridgeEventBatchForRequest,
      scheduleGatewayBridgeEventBatchFlush,
      sendGatewayBridgeEventForRequest,
    ],
  );

  const flushPendingGatewayBridgeEvents = useCallback(() => {
    const requestIds = Array.from(pendingGatewayBridgeEventBatchesRef.current.keys());
    for (const requestId of requestIds) {
      flushGatewayBridgeEventBatchForRequest(requestId);
    }
  }, [flushGatewayBridgeEventBatchForRequest]);

  useEffect(
    () => () => {
      for (const pending of pendingGatewayBridgeEventBatchesRef.current.values()) {
        if (pending.rafId !== null) {
          cancelAnimationFrame(pending.rafId);
        }
        if (pending.timeoutId !== null) {
          window.clearTimeout(pending.timeoutId);
        }
        pending.microtaskQueued = false;
      }
      pendingGatewayBridgeEventBatchesRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        flushPendingGatewayBridgeEvents();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", flushPendingGatewayBridgeEvents);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", flushPendingGatewayBridgeEvents);
    };
  }, [flushPendingGatewayBridgeEvents]);

  return {
    queueGatewayBridgeEventForRequest,
    flushPendingGatewayBridgeEvents,
  };
}
