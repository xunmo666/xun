/**
 * 知识库文本加载器
 *
 * MVP 阶段：从本地文件读取知识库文本。
 * 后续可替换为检索服务（Retriever），返回 Top-K 相关片段。
 */

import fs from "fs";
import path from "path";

/**
 * 读取知识库文本内容
 *
 * MVP 实现：读取 data/knowledge-base.txt 文件。
 * 若文件不存在或为空，返回空字符串（使用默认 system prompt）。
 *
 * @returns 知识库文本
 */
export async function readKnowledgeBase(): Promise<string> {
  try {
    const kbPath = path.join(process.cwd(), "data", "knowledge-base.txt");

    // 文件不存在则返回空
    if (!fs.existsSync(kbPath)) {
      console.log("[knowledge] 知识库文件不存在，跳过拼接");
      return "";
    }

    const content = fs.readFileSync(kbPath, "utf-8");
    console.log(`[knowledge] 加载知识库文本 ${content.length} 字符`);
    return content;
  } catch (err) {
    console.error("[knowledge] 读取知识库失败:", err);
    return "";
  }
}
