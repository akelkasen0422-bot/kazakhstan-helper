export async function onRequestPost({ request, env }) {
  // ===== CORS：让微信/浏览器都能调用（同域其实不太需要，但加上更稳） =====
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
  };

  // 处理预检请求
  if (request.method === "OPTIONS") {
    return new Response("", { headers: corsHeaders });
  }

  // 读入前端数据
  let body = {};
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: corsHeaders });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const targetLang = body.targetLang || "kk"; // kk/ru/zh
  const style = body.style || "normal"; // concise/normal/polite

  // ===== 强制输出语言（解决“哈语自动变英语”）=====
  const langRule =
    targetLang === "kk"
      ? "Reply ONLY in Kazakh. Never use English."
      : targetLang === "ru"
      ? "Reply ONLY in Russian. Never use English."
      : "Reply ONLY in Simplified Chinese. Never use English.";

  const styleRule =
    style === "concise" ? "Be concise." : style === "polite" ? "Be polite." : "Be natural and helpful.";

  const system = [
    "You are a travel translation and phrase assistant for Kazakhstan.",
    langRule,
    styleRule,
    "When helpful, output short, ready-to-say phrases.",
  ].join(" ");

  const finalMessages = [
    { role: "system", content: system },
    ...messages,
  ];

  // ===== 超时工具 =====
  async function fetchWithTimeout(url, options, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(t);
    }
  }

  // ===== 统一解析 =====
  async function parseOpenAICompat(res) {
    const raw = await res.text();
    let data = {};
    try { data = JSON.parse(raw); } catch { data = { error: raw.slice(0, 300) }; }

    if (!res.ok) {
      throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
    }
    const text =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.text ||
      data?.text ||
      "";
    if (!text) throw new Error("Empty response text");
    return text;
  }

  // ===== 先 Groq，失败再 DeepSeek =====
  // 你需要在 Cloudflare Pages 的 Environment variables 里设置：
  // GROQ_API_KEY, DEEPSEEK_API_KEY
  try {
    // --- Groq（OpenAI兼容）---
    // 如果你不想在这里直连 Groq，也可以先注释掉这段，只用 DeepSeek
    if (env.GROQ_API_KEY) {
      const groqRes = await fetchWithTimeout(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: env.GROQ_MODEL || "llama-3.3-70b-versatile",
            messages: finalMessages,
            temperature: 0.4,
          }),
        },
        6500
      );
      const text = await parseOpenAICompat(groqRes);
      return new Response(JSON.stringify({ text, engine: "GROQ" }), { headers: corsHeaders });
    }
    throw new Error("GROQ not configured");
  } catch (e1) {
    try {
      // --- DeepSeek（OpenAI兼容，官方 base_url https://api.deepseek.com）---
      // 文档：POST /chat/completions ；也可用 base_url https://api.deepseek.com/v1 :contentReference[oaicite:1]{index=1}
      const deepseekRes = await fetchWithTimeout(
        "https://api.deepseek.com/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify({
            model: env.DEEPSEEK_MODEL || "deepseek-chat",
            messages: finalMessages,
            temperature: 0.4,
          }),
        },
        8500
      );
      const text = await parseOpenAICompat(deepseekRes);
      return new Response(JSON.stringify({ text, engine: "DEEPSEEK" }), { headers: corsHeaders });
    } catch (e2) {
      return new Response(
        JSON.stringify({ error: `GROQ失败：${String(e1.message || e1)}；DEEPSEEK失败：${String(e2.message || e2)}` }),
        { status: 500, headers: corsHeaders }
      );
    }
  }
}
