"use client";

import { useState, useRef, useCallback } from "react";
import MessageList from "@/components/chat/MessageList";
import InputArea from "@/components/chat/InputArea";
import type { Message } from "@/components/chat/MessageItem";

/**
 * 根据错误码返回友好的中文提示
 */
function formatErrorMessage(code?: string, rawMessage?: string): string {
  const map: Record<string, string> = {
    INVALID_API_KEY: "API Key 无效，请检查 .env.local 中的配置",
    INSUFFICIENT_BALANCE: "模型账户余额不足，请充值后重试",
    RATE_LIMITED: "请求过于频繁，请稍后再试",
    INVALID_REQUEST: "请求参数有误",
    PERMISSION_DENIED: "没有访问权限",
    TIMEOUT: "模型响应超时，请重试",
    MODEL_SERVER_ERROR: "模型服务暂时不可用，请稍后重试",
  };
  return map[code || ""] || rawMessage || "生成失败，请重试";
}

/**
 * 聊天页主组件
 *
 * 核心功能：
 * 1. 消息列表展示（用户/AI 分列）
 * 2. 调用 /api/chat，消费 SSE 流
 * 3. 逐字更新 AI 消息
 * 4. 停止生成（AbortController）
 * 5. 自动滚动到底部
 * 6. 错误重试
 */
export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  /** 生成唯一消息 ID */
  const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /** 发送消息 */
  const handleSend = useCallback(
    async (content: string, historyOverride?: Message[]) => {
      // 1. 添加用户消息
      const userMessage: Message = {
        id: genId(),
        role: "user",
        content,
      };

      // 2. 添加 AI 占位消息（等待状态）
      const aiMessageId = genId();
      const aiMessage: Message = {
        id: aiMessageId,
        role: "assistant",
        content: "",
        status: "waiting",
      };

      // 历史消息：优先使用传入的 override（重试场景），否则使用当前 messages
      const history = historyOverride ?? messages;

      setMessages((prev) => [...prev, userMessage, aiMessage]);
      setIsStreaming(true);

      // 3. 创建 AbortController
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        // 4. 调用 /api/chat
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [...history, userMessage].map((m) => ({
              role: m.role,
              content: m.content,
            })),
            model: "chat",
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err?.error?.message || `请求失败 (${response.status})`);
        }

        // 5. 消费 SSE 流
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let aiContent = "";

        const updateAIMessage = (patch: Partial<Message>) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === aiMessageId ? { ...m, ...patch } : m))
          );
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // 按 SSE 事件分隔符 \n\n 切分
          const events = buffer.split("\n\n");
          buffer = events.pop() || ""; // 保留不完整的事件到 buffer

          for (const event of events) {
            if (!event.startsWith("data: ")) continue;

            try {
              const data = JSON.parse(event.slice(6));

              // text delta → 追加内容
              if (data.text) {
                aiContent += data.text;
                updateAIMessage({ content: aiContent, status: "streaming" });
              }

              // done → 完成
              if (data.done) {
                updateAIMessage({ status: "done" });
              }

              // error → 错误
              if (data.error) {
                updateAIMessage({
                  status: "error",
                  error: formatErrorMessage(data.error.code, data.error.message),
                });
              }
            } catch (parseErr) {
              // JSON 解析失败（跨 chunk 数据），跳过，等下一个 chunk 拼接
              console.warn("SSE 数据解析失败:", parseErr);
            }
          }
        }

        // 流结束但没有 done 事件，标记为完成
        setMessages((prev) =>
          prev.map((m) =>
            m.id === aiMessageId && m.status !== "error"
              ? { ...m, status: "done" }
              : m
          )
        );
      } catch (err: unknown) {
        const error = err as Error;

        // 用户主动停止
        if (error.name === "AbortError") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === aiMessageId ? { ...m, status: "done" } : m
            )
          );
        } else {
          // 其他错误
          setMessages((prev) =>
            prev.map((m) =>
              m.id === aiMessageId
                ? { ...m, status: "error", error: error.message }
                : m
            )
          );
        }
      } finally {
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    },
    [messages]
  );

  /** 停止生成 */
  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  /** 重试失败的消息 */
  const handleRetry = useCallback(
    (messageId: string) => {
      setMessages((prev) => {
        // 找到失败的 AI 消息及其对应的用户消息
        const aiIndex = prev.findIndex((m) => m.id === messageId);
        if (aiIndex <= 0) return prev;

        const userMessage = prev[aiIndex - 1];
        if (userMessage.role !== "user") return prev;

        // 历史消息 = 失败 AI 消息之前的所有消息（不含错误的 AI 消息）
        const history = prev.slice(0, aiIndex);

        // 移除失败的 AI 消息
        const newMessages = [...history];
        setMessages(newMessages);

        // 异步触发重新发送，传入正确的历史消息
        setTimeout(() => handleSend(userMessage.content, history), 0);
        return newMessages;
      });
    },
    [handleSend]
  );

  return (
    <div className="flex h-screen flex-col bg-gray-50">
      {/* 顶部栏 */}
      <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
        <h1 className="text-base font-semibold text-gray-800">AI 知识库助手</h1>
        <span className="text-xs text-gray-400">内部使用</span>
      </header>

      {/* 消息列表 */}
      <main className="flex-1 overflow-hidden">
        <MessageList messages={messages} onRetry={handleRetry} />
      </main>

      {/* 输入区 */}
      <InputArea onSend={handleSend} onStop={handleStop} isStreaming={isStreaming} />
    </div>
  );
}
