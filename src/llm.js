/* Provider transport: no runtime dependency or credentials in diagnostics. */
const asLLMActive = new Map(),
  asLLMView = {
    text: "",
    status: "Idle",
    tps: 0,
    tokens: 0,
    listeners: new Set(),
  };
function asLLMNotify() {
  for (const listener of asLLMView.listeners) listener();
}
function asLLMProfile(profile) {
  return {
    contextWindow: 8192,
    maxOutputTokens: 2048,
    temperature: 0.3,
    timeoutSeconds: 300,
    streaming: true,
    structuredOutput: "json_schema",
    unloadMethod: profile.kind === "ollama" ? "ollama" : "manual",
    vramGB: 0,
    keepWarm: false,
    ...profile,
  };
}
function asNativeOrigin(profile) {
  const url = new URL(profile.baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
function asRedact(value) {
  const secrets = [
    ...K.getState().llm.map((p) => p.apiKey),
    ...K.getState().webApis.flatMap((p) => [
      p.authHeader,
      p.authHeader
        ?.split(":")
        .slice(1)
        .join(":")
        .trim()
        .replace(/^Bearer\s+/i, ""),
    ]),
  ].filter((v) => typeof v === "string" && v.length > 3);
  let text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (key, value) =>
          /api.?key|authorization|authheader|password|secret/i.test(key)
            ? "[redacted]"
            : value,
        );
  for (const secret of secrets) text = text.split(secret).join("[redacted]");
  return text.replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]");
}
async function asRunLog(stage, result, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    stage,
    result,
    ...JSON.parse(asRedact(details)),
  };
  asPipelineRuntime.log = [...(asPipelineRuntime.log || []), entry].slice(-500);
  const snapshot = asPipelineRuntime.log;
  asLogWrites = asLogWrites
    .catch(() => {})
    .then(() => Go("astra-run-log", snapshot));
  await asLogWrites;
  asPipelineNotify();
}
let asLogWrites = Promise.resolve();
function asEstimateTokens(text, profile) {
  let en = 0,
    te = 0;
  for (const c of String(text)) {
    if (/[\u0c00-\u0c7f]/.test(c)) te++;
    else en++;
  }
  const calibration = K.getState().tokenCalibration?.[profile?.id] || {};
  return Math.ceil(en * (calibration.en || 0.35) + te * (calibration.te || 2));
}
function asTokenCalibrate(profile, input, tokens) {
  if (!(tokens > 0) || !input) return;
  const te = [...input].filter((c) => /[\u0c00-\u0c7f]/.test(c)).length,
    lang = te > input.length * 0.15 ? "te" : "en",
    ratio = tokens / input.length,
    all = K.getState().tokenCalibration || {},
    old = all[profile.id]?.[lang];
  K.getState().update({
    tokenCalibration: {
      ...all,
      [profile.id]: {
        ...all[profile.id],
        [lang]: Math.max(
          lang === "te" ? 0.5 : 0.15,
          Math.min(5, old ? old * 0.8 + ratio * 0.2 : ratio),
        ),
      },
    },
  });
}
function asJSONExtract(text) {
  let trimmed = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {}
  const start = trimmed.search(/[\[{]/);
  if (start < 0)
    throw Error(
      "No JSON object returned. Review the output or retry this item.",
    );
  let stack = [],
    quoted = false,
    escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (quoted) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      const open = stack.pop();
      if (!open || (c === "}" && open !== "{") || (c === "]" && open !== "["))
        throw Error("Malformed JSON nesting. Retry the item.");
      if (!stack.length) return JSON.parse(trimmed.slice(start, i + 1));
    }
  }
  throw Error(
    "Incomplete JSON. Increase output/context budget and retry this item.",
  );
}
async function asLLMModels(raw, signal) {
  const p = asLLMProfile(raw);
  if (p.kind === "simulation") return ["simulation"];
  const url =
    p.kind === "ollama"
      ? asNativeOrigin(p) + "/api/tags"
      : p.baseUrl.replace(/\/$/, "") + "/models";
  const response = await fetch(url, {
    headers: p.apiKey ? { authorization: "Bearer " + p.apiKey } : {},
    signal,
  });
  if (!response.ok) throw Error("Model list HTTP " + response.status);
  const data = await response.json();
  return p.kind === "ollama"
    ? (data.models || []).map((m) => m.name)
    : (data.data || []).map((m) => m.id);
}
async function asLLMRequest(raw, system, input, options = {}) {
  const p = asLLMProfile(raw),
    controller = new AbortController(),
    id = crypto.randomUUID(),
    abort = () =>
      controller.abort(
        options.signal?.reason || new DOMException("Stopped", "AbortError"),
      ),
    start = performance.now();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          "LLM timeout. Increase the profile timeout and retry.",
          "TimeoutError",
        ),
      ),
    Math.max(1, p.timeoutSeconds) * 1000,
  );
  asLLMActive.set(id, controller);
  Object.assign(asLLMView, {
    text: "",
    status: "Running " + p.name,
    tps: 0,
    tokens: 0,
  });
  asLLMNotify();
  let text = "",
    usage = {},
    finish = "";
  try {
    if (p.kind === "simulation") {
      await asPipelineDelay(
        K.getState().simulation?.latencyMs ?? 20,
        controller.signal,
      );
      asSimulationFailure("llm");
      const value = options.simulate ? await options.simulate() : { ok: true };
      text = JSON.stringify(value);
      if (K.getState().simulation?.invalidJSON) text = "{invalid";
      if (K.getState().simulation?.truncated)
        throw Error(
          "LLM output truncated (length). Increase max output tokens or reduce the pass window.",
        );
      usage = {
        prompt_tokens: asEstimateTokens(system + input, p),
        completion_tokens: asEstimateTokens(text, p),
      };
    } else if (p.kind === "anthropic" || p.kind === "gemini") {
      text = await asLegacyLLM(p, system, input, {
        signal: controller.signal,
        maxTokens: p.maxOutputTokens,
        temperature: p.temperature,
      });
    } else {
      const ollama = p.kind === "ollama",
        headers = {
          "content-type": "application/json",
          ...(p.apiKey ? { authorization: "Bearer " + p.apiKey } : {}),
        },
        body = {
          model: p.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: input },
          ],
          stream: !!p.streaming,
        };
      if (ollama) {
        body.options = {
          num_ctx: p.contextWindow,
          num_predict: p.maxOutputTokens,
          temperature: p.temperature,
        };
        if (p.structuredOutput !== "none")
          body.format =
            p.structuredOutput === "json_schema" && options.schema
              ? options.schema
              : "json";
      } else {
        body.max_tokens = p.maxOutputTokens;
        body.temperature = p.temperature;
        if (body.stream) body.stream_options = { include_usage: true };
        if (p.structuredOutput !== "none")
          body.response_format =
            p.structuredOutput === "json_schema" && options.schema
              ? {
                  type: "json_schema",
                  json_schema: {
                    name: options.name || "astra_pass",
                    strict: true,
                    schema: options.schema,
                  },
                }
              : { type: "json_object" };
      }
      const response = await fetch(
        ollama
          ? asNativeOrigin(p) + "/api/chat"
          : p.baseUrl.replace(/\/$/, "") + "/chat/completions",
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw Error(
          "LLM HTTP " +
            response.status +
            ". Check the model, endpoint and structured-output setting.",
        );
      const consume = (data) => {
        if (data.error)
          throw Error("LLM provider error: " + asRedact(data.error));
        text += ollama
          ? data.message?.content || data.response || ""
          : data.choices?.[0]?.delta?.content ||
            data.choices?.[0]?.message?.content ||
            "";
        finish = ollama
          ? data.done_reason || finish
          : data.choices?.[0]?.finish_reason || finish;
        if (ollama) {
          if (Number.isFinite(data.load_duration))
            usage.load_seconds = data.load_duration / 1e9;
          usage.prompt_tokens = data.prompt_eval_count || usage.prompt_tokens;
          usage.completion_tokens = data.eval_count || usage.completion_tokens;
        } else usage = { ...usage, ...data.usage };
        asLLMView.text = text;
        asLLMView.tokens = usage.completion_tokens || asEstimateTokens(text, p);
        asLLMView.tps =
          asLLMView.tokens /
          Math.max(0.001, (performance.now() - start) / 1000);
        asLLMNotify();
        options.onChunk?.(text);
      };
      if (
        !p.streaming ||
        response.headers.get("content-type")?.includes("application/json")
      )
        consume(await response.json());
      else {
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let at;
            while ((at = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, at).trim();
              buffer = buffer.slice(at + 1);
              if (ollama) {
                if (line) consume(JSON.parse(line));
              } else if (line.startsWith("data:")) {
                const data = line.slice(5).trim();
                if (data && data !== "[DONE]") consume(JSON.parse(data));
              }
            }
          }
          buffer += decoder.decode();
          if (buffer.trim()) {
            const line = buffer.trim().replace(/^data:\s*/, "");
            if (line !== "[DONE]") consume(JSON.parse(line));
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      if (["length", "max_tokens", "MAX_TOKENS"].includes(finish))
        throw Error(
          "LLM output truncated (length). Increase max output tokens or reduce this scene/shot window.",
        );
      if (!text.trim())
        throw Error(
          "LLM returned an empty response. Check the model and output budget.",
        );
    }
    asLLMView.promptTokens = usage.prompt_tokens;
    asTokenCalibrate(p, system + input, usage.prompt_tokens);
    const seconds = (performance.now() - start) / 1000,
      tps =
        (usage.completion_tokens || asEstimateTokens(text, p)) /
        Math.max(0.001, seconds);
    K.getState().update({
      llm: K.getState().llm.map((v) =>
        v.id === p.id
          ? {
              ...v,
              measuredTPS: tps,
              measuredLoadSeconds: usage.load_seconds ?? v.measuredLoadSeconds,
            }
          : v,
      ),
    });
    Object.assign(asLLMView, {
      text,
      status: "Done",
      tps,
      tokens: usage.completion_tokens || asEstimateTokens(text, p),
    });
    await asRunLog("llm", "done", {
      provider: p.id,
      model: p.model,
      duration: seconds,
      usage,
    });
    return text;
  } catch (e) {
    const error = controller.signal.aborted ? controller.signal.reason || e : e;
    asLLMView.status = error.message;
    if (error instanceof TypeError)
      throw Error(
        "LLM network/CORS failure. Verify the server is running, then set OLLAMA_ORIGINS=* for Ollama or enable CORS in LM Studio. Browser fetch cannot distinguish CORS denial from an unreachable server.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    asLLMActive.delete(id);
    asLLMNotify();
  }
}
function asLLMStop() {
  for (const controller of asLLMActive.values())
    controller.abort(new DOMException("Stopped by user", "AbortError"));
}
async function asLLMTest(profile) {
  const models = await asLLMModels(profile, AbortSignal.timeout(15000));
  if (
    !models.some((m) => m === profile.model || m === profile.model + ":latest")
  )
    throw Error("Selected model is not listed. Choose an installed model.");
  const text = await asLLMRequest(
    profile,
    "Return a JSON object with ok=true.",
    "Test structured JSON.",
    {
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      simulate: () => ({ ok: true }),
    },
  );
  if (asJSONExtract(text).ok !== true)
    throw Error("Structured-output test failed");
  return {
    models,
    tps: asLLMView.tps,
    requestedContext: asLLMProfile(profile).contextWindow,
    contextEvidence:
      "Request accepted; maximum context is not exposed by this API and has not been exhaustively probed.",
  };
}
async function asLLMContextProbe(raw) {
  const p = asLLMProfile(raw),
    evidence = [];
  let maxVerified = 0;
  for (const target of [
    ...new Set([
      Math.min(1024, p.contextWindow),
      Math.min(2048, p.contextWindow),
      Math.min(4096, p.contextWindow),
      p.contextWindow,
    ]),
  ]) {
    const begin = crypto.randomUUID(),
      end = crypto.randomUUID(),
      system =
        "Return JSON with the exact BEGIN_KEY and END_KEY from the input. This tests whether both ends fit in your context.",
      overhead = asEstimateTokens(system + begin + end, p) + 256,
      count = Math.max(
        0,
        Math.floor((target - overhead) / asEstimateTokens("test ", p)),
      ),
      input =
        "BEGIN_KEY=" +
        begin +
        "\n" +
        "test ".repeat(count) +
        "\nEND_KEY=" +
        end;
    try {
      const text = await asLLMRequest(
          { ...p, maxOutputTokens: 128 },
          system,
          input,
          {
            schema: {
              type: "object",
              properties: {
                begin: { type: "string" },
                end: { type: "string" },
              },
              required: ["begin", "end"],
              additionalProperties: false,
            },
            simulate: () => ({ begin, end }),
          },
        ),
        result = asJSONExtract(text);
      if (result.begin !== begin || result.end !== end)
        throw Error("Context markers were not retained");
      const measured =
        asLLMView.promptTokens || asEstimateTokens(system + input, p);
      maxVerified = Math.max(maxVerified, measured);
      evidence.push({
        requestedWindow: p.contextWindow,
        testedInputTokens: measured,
        retainedBothMarkers: true,
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      evidence.push({ target, error: asRedact(e.message) });
      break;
    }
  }
  K.getState().update({
    llm: K.getState().llm.map((v) =>
      v.id === p.id
        ? {
            ...v,
            contextEvidence: {
              maximumVerifiedInputTokens: maxVerified,
              maximumCapacityProven: false,
              simulation: p.kind === "simulation",
              testedAt: Date.now(),
            },
          }
        : v,
    ),
  });
  return {
    maximumVerifiedInputTokens: maxVerified,
    maximumCapacityProven: false,
    simulation: p.kind === "simulation",
    evidence,
  };
}
