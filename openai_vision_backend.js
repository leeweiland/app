// openai_vision_backend.js — shared OpenAI vision-call helper: forces
// structured output via a tool/function call (instead of parsing free text
// with a regex) and handles the refusal-detect-and-retry dance. Used by
// body_analysis_backend.js (body/move scans) and food_log_backend.js (food
// photo -> calorie/macro estimate) so this scaffold exists exactly once.

const MODEL = "gpt-4o";

// A flat "I'm sorry, I can't assist with that" (or similar) sometimes comes
// back as a plain assistant reply instead of the requested tool call, even
// with careful framing -- this is the fallback detector for that case.
function looksLikeRefusal(text) {
  return /^\s*(i'?m sorry|i can'?t|i cannot|i'?m not able|i won'?t)/i.test(text || "");
}

async function callOnce(imageBuffer, mimeType, systemPrompt, userPrompt, tool) {
  const base64 = imageBuffer.toString("base64");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
        ] },
      ],
      tools: [tool],
      tool_choice: { type: "function", function: { name: tool.function.name } },
      max_tokens: 900,
      temperature: 0.4,
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || "OpenAI request failed");
  const msg = d.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0];
  if (!call) {
    // Declined the tool call entirely and replied with plain text instead --
    // almost always a refusal.
    return { refused: true, args: null };
  }
  let args = null;
  try { args = JSON.parse(call.function.arguments); } catch { /* leave null */ }
  if (!args || looksLikeRefusal(JSON.stringify(args))) return { refused: true, args: null };
  return { refused: false, args };
}

// Runs the vision call, retrying once with extra reassurance appended to
// the user prompt if the model refuses the tool call, before giving up.
export async function analyzeImageWithOpenAI({ imageBuffer, mimeType, systemPrompt, userPrompt, tool, reassurance }) {
  let result = await callOnce(imageBuffer, mimeType, systemPrompt, userPrompt, tool);
  if (result.refused && reassurance) {
    result = await callOnce(imageBuffer, mimeType, systemPrompt, `${userPrompt} ${reassurance}`, tool);
  }
  return result; // { refused, args }
}
