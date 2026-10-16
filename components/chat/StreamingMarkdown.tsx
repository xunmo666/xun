"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useState, useEffect } from "react";

interface StreamingMarkdownProps {
  text: string;
  streaming?: boolean;
}

/**
 * 流式 Markdown 渲染组件
 *
 * 策略：
 * - 流式中：检测代码块是否闭合（``` 数量奇偶），未闭合则降级为纯文本渲染
 * - 节流：流式中每 100ms 解析一次 Markdown，避免每次 token 都全量解析导致闪烁
 * - 完成时：立即完整解析
 */
export default function StreamingMarkdown({ text, streaming = false }: StreamingMarkdownProps) {
  const [renderText, setRenderText] = useState(text);

  useEffect(() => {
    if (!streaming) {
      setRenderText(text);
      return;
    }

    // 流式中节流 100ms 更新
    const timer = setTimeout(() => {
      setRenderText(text);
    }, 100);

    return () => clearTimeout(timer);
  }, [text, streaming]);

  // 检测代码块是否未闭合（``` 数量为奇数）
  const codeBlockCount = (renderText.match(/```/g) || []).length;
  const hasUnclosedCodeBlock = codeBlockCount % 2 === 1;

  // 流式中且代码块未闭合 → 降级为纯文本渲染
  if (streaming && hasUnclosedCodeBlock) {
    return (
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-gray-800">
        {renderText}
      </pre>
    );
  }

  return (
    <div className="prose prose-sm max-w-none prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {renderText}
      </ReactMarkdown>
    </div>
  );
}
