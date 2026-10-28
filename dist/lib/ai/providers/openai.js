const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_INTERACTIVE_RETRY_DELAY_MS = 30_000;
export class OpenAiProviderError extends Error {
    code;
    retryable;
    name = "OpenAiProviderError";
    constructor(code, message, retryable) {
        super(message);
        this.code = code;
        this.retryable = retryable;
    }
}
export class OpenAiProvider {
    model;
    apiKey;
    fetcher;
    sleeper;
    name = "openai";
    constructor(model, apiKey, fetcher = fetch, sleeper = wait) {
        this.model = model;
        this.apiKey = apiKey;
        this.fetcher = fetcher;
        this.sleeper = sleeper;
    }
    async generate(input) {
        const request = {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
                model: this.model,
                messages: [{ role: "system", content: input.system }, { role: "user", content: input.prompt }],
                response_format: { type: "json_object" },
                max_completion_tokens: input.maxOutputTokens ?? 1800,
            }),
            signal: input.signal,
        };
        let response;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
            response = await this.fetcher("https://api.openai.com/v1/chat/completions", request);
            if (response.ok)
                break;
            const providerError = await readProviderError(response);
            const classified = classifyProviderError(response.status, providerError);
            const finalAttempt = attempt === MAX_ATTEMPTS - 1;
            if (!classified.retryable || !RETRYABLE_STATUSES.has(response.status) || finalAttempt)
                throw classified;
            const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
            const delay = retryAfter ?? (400 * 2 ** attempt + Math.floor(Math.random() * 100));
            if (delay > MAX_INTERACTIVE_RETRY_DELAY_MS) {
                throw new OpenAiProviderError("openai_retry_deferred", `OpenAI is temporarily rate-limited. Retry after ${Math.ceil(delay / 1000)} seconds.`, true);
            }
            await this.sleeper(delay + Math.floor(Math.random() * 100), input.signal);
        }
        if (!response?.ok)
            throw new OpenAiProviderError("openai_request_failed", "OpenAI could not complete the request.", false);
        const body = await response.json();
        const text = body.choices?.[0]?.message?.content;
        if (!text)
            throw new Error("openai_empty_response");
        return {
            text,
            provider: this.name,
            model: this.model,
            usage: {
                promptTokens: body.usage?.prompt_tokens ?? 0,
                completionTokens: body.usage?.completion_tokens ?? 0,
                totalTokens: body.usage?.total_tokens ?? 0,
            },
        };
    }
}
async function readProviderError(response) {
    try {
        return await response.json();
    }
    catch {
        return {};
    }
}
function classifyProviderError(status, body) {
    const code = body.error?.code?.toLowerCase() ?? "";
    const type = body.error?.type?.toLowerCase() ?? "";
    if (code === "credit_balance_exhausted") {
        return new OpenAiProviderError(code, "OpenAI API credits are exhausted. Add credits, then retry.", false);
    }
    if (["organization_spend_limit_exceeded", "project_spend_limit_exceeded", "billing_hard_limit_reached"].includes(code)) {
        return new OpenAiProviderError(code, "The OpenAI project or organization spend limit has been reached. Increase the limit, then retry.", false);
    }
    if (["organization_usage_limit_exceeded", "project_usage_limit_exceeded"].includes(code)) {
        return new OpenAiProviderError(code, "The OpenAI project or organization usage limit has been reached. Increase the limit, then retry.", false);
    }
    if (code === "insufficient_quota" || type === "insufficient_quota") {
        return new OpenAiProviderError("insufficient_quota", "The OpenAI API quota is exhausted. Check billing and usage limits, then retry.", false);
    }
    if (status === 429) {
        return new OpenAiProviderError(code || "openai_rate_limited", "OpenAI is temporarily rate-limited. Wait briefly and retry.", true);
    }
    if (status === 503) {
        return new OpenAiProviderError(code || "openai_overloaded", "OpenAI is temporarily overloaded. Wait briefly and retry.", true);
    }
    return new OpenAiProviderError(code || `openai_http_${status}`, `OpenAI request failed (HTTP ${status}).`, RETRYABLE_STATUSES.has(status));
}
function retryAfterMilliseconds(value) {
    if (!value)
        return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0)
        return seconds * 1000;
    const date = Date.parse(value);
    if (!Number.isFinite(date))
        return undefined;
    return Math.max(0, date - Date.now());
}
function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
    });
}
//# sourceMappingURL=openai.js.map