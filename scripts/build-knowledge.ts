/**
 * 知识库构建脚本
 *
 * 功能：
 * 1. 遍历 docs/ 目录（递归）
 * 2. 支持 .md、.txt、.pdf 格式
 * 3. PDF 使用 pdf-parse 提取文本
 * 4. 按文件分段，每段前加来源标记
 * 5. 输出 knowledge.md
 * 6. 统计总字符数和估算 token 数
 * 7. 超过 200K tokens 打印警告并建议改用 RAG
 *
 * 运行：npx tsx scripts/build-knowledge.ts
 */

import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";

// ============================================================
// 配置
// ============================================================
const INPUT_DIR = path.join(process.cwd(), "docs");
const OUTPUT_FILE = path.join(process.cwd(), "knowledge.md");
const SUPPORTED_EXTENSIONS = [".md", ".txt", ".pdf"];
const TOKEN_WARNING_THRESHOLD = 200_000; // 200K tokens

// ============================================================
// 主流程
// ============================================================
async function main() {
  console.log("========================================");
  console.log("  知识库构建脚本");
  console.log("========================================");

  // 1. 检查输入目录
  if (!fs.existsSync(INPUT_DIR)) {
    console.error(`❌ 输入目录不存在: ${INPUT_DIR}`);
    console.error("   请创建 docs/ 目录并放入知识库文档");
    process.exit(1);
  }

  // 2. 遍历文件
  console.log(`\n📂 扫描目录: ${INPUT_DIR}`);
  const files = await scanDirectory(INPUT_DIR);
  console.log(`   找到 ${files.length} 个支持的文件`);

  if (files.length === 0) {
    console.error("❌ 没有找到任何 .md / .txt / .pdf 文件");
    process.exit(1);
  }

  // 3. 逐个处理文件
  let totalChars = 0;
  const segments: string[] = [];

  for (const filePath of files) {
    const fileName = path.relative(INPUT_DIR, filePath);
    console.log(`\n📄 处理: ${fileName}`);

    try {
      const text = await extractText(filePath);
      const cleaned = cleanText(text);

      if (cleaned.length === 0) {
        console.log(`   ⚠️  文件内容为空，跳过`);
        continue;
      }

      // 按文件分段，加来源标记
      const segment = `--- 来源：${fileName} ---\n\n${cleaned}\n`;
      segments.push(segment);

      totalChars += cleaned.length;
      console.log(`   ✅ 提取 ${cleaned.length} 字符`);
    } catch (err) {
      console.error(`   ❌ 处理失败: ${(err as Error).message}`);
    }
  }

  if (segments.length === 0) {
    console.error("\n❌ 所有文件处理失败，未生成知识库");
    process.exit(1);
  }

  // 4. 写入输出文件
  const output = segments.join("\n");
  fs.writeFileSync(OUTPUT_FILE, output, "utf-8");

  // 5. 统计
  const estimatedTokens = estimateTokens(output);

  console.log("\n========================================");
  console.log("  构建完成");
  console.log("========================================");
  console.log(`📄 输出文件: ${OUTPUT_FILE}`);
  console.log(`📊 总字符数: ${totalChars.toLocaleString()}`);
  console.log(`🔢 估算 Token 数: ${estimatedTokens.toLocaleString()}`);

  // 6. 超过阈值警告
  if (estimatedTokens > TOKEN_WARNING_THRESHOLD) {
    console.log("\n⚠️  ⚠️  ⚠️  警告  ⚠️  ⚠️  ⚠️");
    console.log(`   估算 Token 数 (${estimatedTokens.toLocaleString()}) 超过 ${TOKEN_WARNING_THRESHOLD.toLocaleString()} 阈值`);
    console.log("   长上下文方案可能超出模型上下文限制，建议：");
    console.log("   1. 改用 RAG（向量检索）方案");
    console.log("   2. 拆分知识库，按需检索 Top-K 片段");
    console.log("   3. 减少非必要文档");
  } else {
    console.log(`\n✅ Token 数在安全范围内（< ${TOKEN_WARNING_THRESHOLD.toLocaleString()}）`);
  }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 递归扫描目录，返回支持的文件路径列表
 */
async function scanDirectory(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await scanDirectory(fullPath);
      results.push(...subFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/**
 * 根据文件类型提取文本
 */
async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case ".md":
    case ".txt":
      return fs.readFileSync(filePath, "utf-8");

    case ".pdf":
      return await extractPdfText(filePath);

    default:
      throw new Error(`不支持的文件格式: ${ext}`);
  }
}

/**
 * 提取 PDF 文本
 *
 * pdf-parse 1.1.1 函数式 API：pdfParse(buffer)
 */
async function extractPdfText(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

/**
 * 清理文本：去除多余空行、首尾空白
 */
function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, "\n") // 统一换行符
    .replace(/\n{3,}/g, "\n\n") // 3 个以上换行压缩为 2 个
    .replace(/[ \t]+\n/g, "\n") // 行尾空白
    .trim();
}

/**
 * 估算 Token 数
 *
 * 规则：
 * - 中文字符：约 1.5 tokens/字
 * - 英文/数字/符号：约 4 字符/token（即 0.25 tokens/字符）
 *
 * 这是粗略估算，实际 token 数取决于模型的 tokenizer。
 */
function estimateTokens(text: string): number {
  let chineseChars = 0;
  let otherChars = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // 中日韩统一表意文字范围
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
      (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
      (code >= 0xf900 && code <= 0xfaff)    // CJK 兼容表意文字
    ) {
      chineseChars++;
    } else {
      otherChars++;
    }
  }

  const chineseTokens = chineseChars * 1.5;
  const otherTokens = otherChars / 4;

  return Math.round(chineseTokens + otherTokens);
}

// ============================================================
// 运行
// ============================================================
main().catch((err) => {
  console.error("❌ 构建失败:", err);
  process.exit(1);
});
