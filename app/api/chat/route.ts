import { NextRequest } from "next/server";
import { readKnowledgeBase } from "@/lib/knowledge/loader";

// 运行时配置：使用 Node.js runtime（需要流式和文件系统）
export const runtime = "nodejs";
export const maxDuration = 60;

// DeepSeek API 配置
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

/**
 * POST /api/chat
 *
 * 接收 messages 和 model，拼接知识库 system prompt，调用 DeepSeek 流式 API，
 * 以 SSE 格式返回 text delta。
 *
 * 请求体:
 * {
 *   "messages": [{ "role": "user" | "assistant", "content": "..." }],
 *   "model": "chat" | "reasoner"   // 可选，默认 chat
 * }
 *
 * 响应 (SSE):
 * data: {"text":"..."}\n\n
 * ...
 * data: {"done":true}\n\n
 *
 * 错误响应:
 * data: {"error":{"code":"...","message":"..."}}\n\n
 */
export async function POST(request: NextRequest) {
  // ============================================================
  // 1. 环境变量校验（API Key 不返回前端）
  // ============================================================
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("[chat] DEEPSEEK_API_KEY 未配置");
    return errorResponse("MISSING_API_KEY", "服务器未配置模型 API Key", 500);
  }

  // ============================================================
  // 2. 解析请求体
  // ============================================================
  let body: { messages?: Array<{ role: string; content: string }>; model?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_BODY", "请求体不是合法 JSON", 400);
  }

  const { messages, model: modelPreference = "chat" } = body;

  // 参数校验
  if (!Array.isArray(messages) || messages.length === 0) {
    return errorResponse("INVALID_MESSAGES", "messages 不能为空且必须是数组", 400);
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg.content !== "string" || msg.content.trim() === "") {
      return errorResponse("INVALID_MESSAGE", `第 ${i + 1} 条消息格式不正确`, 400);
    }
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "system") {
      return errorResponse("INVALID_ROLE", `第 ${i + 1} 条消息的 role 必须是 user 或 assistant`, 400);
    }
  }

  // 模型映射
  const modelMap: Record<string, string> = {
    chat: process.env.DEEPSEEK_MODEL_CHAT || "deepseek-chat",
    reasoner: process.env.DEEPSEEK_MODEL_REASONER || "deepseek-reasoner",
  };
  const model = modelMap[modelPreference] || modelMap.chat;

  // ============================================================
  // 3. 构造 AbortController（超时 + 客户端断开）
  // ============================================================
  const abortController = new AbortController();
  const timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS) || 60000;

  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  request.signal.addEventListener("abort", () => {
    abortController.abort();
  });

  // ============================================================
  // 4. 读取知识库文本，拼接 system prompt
  // ============================================================
  let systemPrompt = "你是一个有帮助的 AI 助手。";
  try {
    const kbText = await readKnowledgeBase();
    if (kbText && kbText.length > 0) {
      systemPrompt = `你是企业内部知识库助手，同时具备通用 AI 助手能力。

回答规则：
1. 如果用户问题与以下知识库内容相关，请优先基于知识库回答，并在回答末尾标注"（来源：知识库）"。
2. 如果知识库中没有相关信息，可以使用你自身的知识回答，但必须在回答开头标注"⚠️ 以下回答基于模型自身知识，未引用知识库："。
3. 对于翻译、写作、编程、数学等通用任务，直接使用自身能力回答，无需标注。
4. 回答要简洁、准确，使用中文。

知识库内容：
${kbText}`;
    }
  } catch (err) {
    console.error("[chat] 知识库加载失败，使用默认 system prompt:", err);
  }

  // ============================================================
  // 5. 创建 SSE 响应流
  // ============================================================
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // 构造 OpenAI 兼容的请求体
        const requestBody = {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
          ],
          stream: true,
          max_tokens: Number(process.env.DEEPSEEK_MAX_TOKENS) || 4096,
          temperature: 0.7,
        };

        // 调用 DeepSeek API
        const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          const status = response.status;
          let code = "MODEL_ERROR";
          if (status === 401) code = "INVALID_API_KEY";
          else if (status === 402) code = "INSUFFICIENT_BALANCE";
          else if (status === 429) code = "RATE_LIMITED";
          else if (status === 400) code = "INVALID_REQUEST";
          else if (status === 403) code = "PERMISSION_DENIED";
          else if (status >= 500) code = "MODEL_SERVER_ERROR";
          throw { status, code, message: `${status} ${errText}` };
        }

        // 读取流式响应
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (abortController.signal.aborted) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE 事件以 \n\n 分隔
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const event of events) {
            if (!event.startsWith("data: ")) continue;
            const dataStr = event.slice(6).trim();

            // OpenAI 流式结束标记
            if (dataStr === "[DONE]") {
              send({ done: true });
              continue;
            }

            try {
              const data = JSON.parse(dataStr);
              const delta = data.choices?.[0]?.delta;
              if (delta?.content) {
                send({ text: delta.content });
              }
            } catch {
              // JSON 解析失败跳过
            }
          }
        }

        // 流正常结束但没收到 [DONE]，补一个 done
        if (!abortController.signal.aborted) {
          send({ done: true });
        }
      } catch (err: unknown) {
        const error = err as { status?: number; code?: string; message?: string; name?: string };

        if (error.name === "AbortError") {
          if (request.signal.aborted) {
            console.log("[chat] 客户端断开连接");
          } else {
            send({ error: { code: "TIMEOUT", message: "模型响应超时" } });
          }
        } else {
          const code = error.code || "MODEL_ERROR";
          console.error("[chat] DeepSeek API 错误:", code, error.message);
          send({ error: { code, message: error.message || "模型服务异常" } });
        }
      } finally {
        clearTimeout(timeoutId);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ============================================================
// 辅助函数
// ============================================================

function errorResponse(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}
