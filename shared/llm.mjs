/**
 * LLM 客户端（公共模块，配置注入式）——供 novelread / siliconflowserver 复用
 *
 * 与旧版差异：不再模块级自读 config.json，配置由调用方注入（支持独立部署/多实例）
 *
 * 用法：
 *   import { createLLM } from "../../shared/llm.mjs";
 *   const llm = createLLM({ baseUrl, apiKey, model, timeoutMs, maxRetries, temperature, maxTokens });
 *   const text = await llm.chat([{ role: "user", content: "..." }]);
 *   const obj = await llm.chatJSON([...]);
 */
import fs from "node:fs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 剥离代码块围栏：```json ... ``` → 内部 */
function stripCodeFence(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : text.trim();
}

/**
 * 创建 LLM 客户端实例
 * @param {object} cfg 必须包含：
 *   - baseUrl: string   OpenAI 兼容端点（如 https://api.deepseek.com/v1）
 *   - apiKey:  string
 *   - model:   string
 *   可选：temperature / maxTokens / timeoutMs / maxRetries
 */
export function createLLM(cfg) {
  const baseUrl = (cfg.baseUrl ?? "").replace(/\/+$/, "");
  const model = cfg.model;
  const temperature = cfg.temperature ?? 0.8;
  const maxTokens = cfg.maxTokens ?? 2000;
  const timeoutMs = cfg.timeoutMs ?? 120000;
  const maxRetries = cfg.maxRetries ?? 3;

  /**
   * 单次 chat 调用（含重试）
   * @param {{role:string, content:string}[]} messages
   * @param {{temperature?:number, maxTokens?:number, jsonMode?:boolean, model?:string}} opts
   * @returns {Promise<string>}
   */
  async function chat(messages, opts = {}) {
    const url = `${baseUrl}/chat/completions`;
    const body = {
      model: opts.model ?? model,
      messages,
      temperature: opts.temperature ?? temperature,
    };
    // maxTokens === null → 不传 max_tokens（用 API 默认上限，适合 reasoning 模型长任务）
    if (opts.maxTokens !== null) {
      body.max_tokens = opts.maxTokens ?? maxTokens;
    }
    if (opts.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      // timeoutMs === null → 不设超时（reasoning 模型长任务可能需数分钟）
      let timer = null;
      if (opts.timeoutMs !== null) {
        timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? timeoutMs);
      }
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        const payload = await res.json();
        return payload.choices?.[0]?.message?.content ?? "";
      } catch (err) {
        lastError = err;
        const retryable = err.name === "AbortError" || /429|5\d\d/.test(err.message);
        if (retryable && attempt < maxRetries) {
          await sleep(800 * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  /**
   * 流式 chat（stream: true）——解决 reasoning 模型"思考吃光 max_tokens 导致 content 空"的问题
   * 流式下 content 随生成逐步返回，即使 reasoning 占 token，content 也能累积输出
   *
   * ⚠ 配合使用：长输入 + 大 JSON 输出的任务，maxTokens 必须 ≥12000，
   *   否则 reasoning 思考会耗尽 token（finish_reason=length），content 为空。
   * @param {{role:string, content:string}[]} messages
   * @param {{maxTokens?:number, temperature?:number, onDelta?:function}} opts
   * @returns {Promise<string>} 完整 content
   */
  async function chatStream(messages, opts = {}) {
    const url = `${baseUrl}/chat/completions`;
    const body = {
      model: opts.model ?? model,
      messages,
      temperature: opts.temperature ?? temperature,
      stream: true,
    };
    // maxTokens === null → 不传 max_tokens（用 API 默认上限，避免 reasoning 思考被截断）
    if (opts.maxTokens !== null) {
      body.max_tokens = opts.maxTokens ?? maxTokens;
    }

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      // timeoutMs === null → 不设超时（reasoning 模型长任务可能需数分钟）
      let timer = null;
      if (opts.timeoutMs !== null) {
        timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? timeoutMs);
      }
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        // 流式读取：累积 content 字段（忽略 reasoning_content 增量，只取 content）
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullContent = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // 按行解析 SSE（data: {...}）
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // 保留不完整行
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) {
                fullContent += delta;
                opts.onDelta?.(delta);
              }
            } catch { /* 跳过无法解析的行 */ }
          }
        }
        // 刷新剩余 buffer
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith("data:")) {
            const data = trimmed.slice(5).trim();
            if (data !== "[DONE]") {
              try {
                const chunk = JSON.parse(data);
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) fullContent += delta;
              } catch { /* ignore */ }
            }
          }
        }
        return fullContent;
      } catch (err) {
        lastError = err;
        const retryable = err.name === "AbortError" || /429|5\d\d/.test(err.message);
        if (retryable && attempt < maxRetries) {
          await sleep(800 * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  /**
   * chat + 强制 JSON 解析（含空输出/解析失败重试）
   * @param {object} opts.jsonMode 是否用 response_format（数组型请求建议 false）
   * @returns {Promise<any>}
   */
  async function chatJSON(messages, opts = {}) {
    const jsonMode = opts.jsonMode ?? false;
    const maxJsonAttempts = opts.maxJsonAttempts ?? 3;
    let lastError = null;
    for (let attempt = 0; attempt < maxJsonAttempts; attempt++) {
      const text = await chat(messages, { ...opts, jsonMode });
      if (!text || !text.trim()) {
        lastError = new Error("LLM 返回空内容");
        if (attempt < maxJsonAttempts - 1) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        break;
      }
      try {
        return JSON.parse(stripCodeFence(text));
      } catch {
        const cleaned = stripCodeFence(text);
        const candidates = [
          [cleaned.indexOf("["), cleaned.lastIndexOf("]")],
          [cleaned.indexOf("{"), cleaned.lastIndexOf("}")],
        ];
        for (const [start, end] of candidates) {
          if (start >= 0 && end > start) {
            try {
              return JSON.parse(cleaned.slice(start, end + 1));
            } catch { /* 尝试下一个 */ }
          }
        }
        lastError = new Error(`LLM 输出非 JSON: ${text.slice(0, 300)}`);
        if (attempt < maxJsonAttempts - 1) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        break;
      }
    }
    throw lastError ?? new Error("chatJSON 失败");
  }

  /** 健康检查 */
  async function healthCheck() {
    try {
      const text = await chat([{ role: "user", content: "回复'OK'两个字" }], { maxTokens: 10 });
      return { ok: true, model, sample: text.slice(0, 50) };
    } catch (err) {
      return { ok: false, error: err.message, model };
    }
  }

  return { chat, chatStream, chatJSON, healthCheck, model };
}

/** 从 JSON 配置文件创建（便捷：给一个 config 文件路径，读 chat 段） */
export function createLLMFromConfig(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")).chat;
  return createLLM(cfg);
}
