"use client";

import { useEffect, useRef } from "react";
import MessageItem, { type Message } from "./MessageItem";

interface MessageListProps {
  messages: Message[];
  onRetry?: (messageId: string) => void;
}

export default function MessageList({ messages, onRetry }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  /** 监听滚动：用户上滑时暂停自动滚动 */
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    // 距离底部小于 100px 时，恢复自动滚动
    shouldAutoScrollRef.current = scrollHeight - scrollTop - clientHeight < 100;
  };

  /** 消息变化时自动滚动到底部 */
  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-100">
          <span className="text-2xl">💬</span>
        </div>
        <h2 className="mb-2 text-xl font-semibold text-gray-800">有什么可以帮你的？</h2>
        <p className="mb-6 max-w-md text-sm text-gray-500">
          我可以基于内部知识库回答问题，也能处理日常写作、翻译等任务。
        </p>
        <div className="grid w-full max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
          {[
            "公司年假政策是什么？",
            "帮我总结这份产品文档",
            "如何配置 SSO 单点登录？",
            "把这段英文翻译成中文",
          ].map((q) => (
            <button
              key={q}
              onClick={() => {
                // 通过自定义事件通知父组件填充输入框
                window.dispatchEvent(new CustomEvent("fill-input", { detail: q }));
              }}
              className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-left text-sm text-gray-700 transition hover:border-indigo-300 hover:bg-indigo-50"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto"
    >
      <div className="mx-auto max-w-3xl py-4">
        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            onRetry={message.role === "assistant" ? () => onRetry?.(message.id) : undefined}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
