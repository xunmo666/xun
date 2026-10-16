"use client";

import { Bot, User, Copy, RefreshCw, ThumbsUp, ThumbsDown } from "lucide-react";
import StreamingMarkdown from "./StreamingMarkdown";

export type MessageStatus = "waiting" | "streaming" | "done" | "error";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: MessageStatus;
  error?: string;
}

interface MessageItemProps {
  message: Message;
  onRetry?: () => void;
}

export default function MessageItem({ message, onRetry }: MessageItemProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-3 px-4 py-4 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* 头像 */}
      <div
        className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
          isUser ? "bg-indigo-600" : "bg-gray-700"
        }`}
      >
        {isUser ? (
          <User className="h-4 w-4 text-white" />
        ) : (
          <Bot className="h-4 w-4 text-white" />
        )}
      </div>

      {/* 消息内容 */}
      <div className={`min-w-0 max-w-[85%] ${isUser ? "items-end" : ""}`}>
        {isUser ? (
          /* 用户消息：纯色气泡 */
          <div className="rounded-2xl rounded-tr-md bg-indigo-600 px-4 py-2.5 text-sm text-white">
            {message.content}
          </div>
        ) : (
          /* AI 消息 */
          <div className="space-y-2">
            {message.status === "waiting" && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <ThinkingDots />
                <span>正在思考...</span>
              </div>
            )}

            {(message.status === "streaming" || message.status === "done") && (
              <div className="relative">
                <StreamingMarkdown
                  text={message.content}
                  streaming={message.status === "streaming"}
                />
                {message.status === "streaming" && (
                  <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-indigo-500 align-middle" />
                )}
              </div>
            )}

            {message.status === "error" && (
              <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                <span className="text-sm text-red-700">
                  {message.error || "回答生成失败"}
                </span>
                {onRetry && (
                  <button
                    onClick={onRetry}
                    className="flex items-center gap-1 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
                  >
                    <RefreshCw className="h-3 w-3" />
                    重试
                  </button>
                )}
              </div>
            )}

            {/* 操作栏：完成后显示 */}
            {message.status === "done" && message.content && (
              <div className="flex items-center gap-1 opacity-60 hover:opacity-100">
                <button
                  onClick={() => navigator.clipboard.writeText(message.content)}
                  className="rounded p-1 hover:bg-gray-100"
                  title="复制"
                >
                  <Copy className="h-3.5 w-3.5 text-gray-500" />
                </button>
                <button className="rounded p-1 hover:bg-gray-100" title="有帮助">
                  <ThumbsUp className="h-3.5 w-3.5 text-gray-500" />
                </button>
                <button className="rounded p-1 hover:bg-gray-100" title="没帮助">
                  <ThumbsDown className="h-3.5 w-3.5 text-gray-500" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 思考中动画：三个跳动圆点 */
function ThinkingDots() {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
    </span>
  );
}
