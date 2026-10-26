/** Google AI Studio / Gemini Developer API provider authenticated with an API key. */
export class GeminiApiProvider {
    model;
    apiKey;
    fetcher;
    name = "gemini";
    constructor(model, apiKey, fetcher = fetch) {
        this.model = model;
        this.apiKey = apiKey;
        this.fetcher = fetcher;
    }
    async generate(input) {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
        const request = {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-goog-api-key": this.apiKey,
            },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: input.system }] },
                contents: [{ role: "user", parts: [{ text: input.prompt }] }],
                generationConfig: {
                    responseMimeType: "application/json",
                    maxOutputTokens: input.maxOutputTokens ?? 1800,
                    temperature: 0.2,
                },
            }),
            signal: input.signal,
        };
        let response;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            response = await this.fetcher(endpoint, request);
            if (response.ok)
                break;
            if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
                throw new Error(`gemini_http_${response.status}`);
            }
            await wait(400 * 2 ** attempt, input.signal);
        }
        if (!response?.ok)
            throw new Error(`gemini_http_${response?.status ?? "unknown"}`);
        const body = await response.json();
        const text = body.candidates?.[0]?.content?.parts?.map(part => part.text ?? "").join("");
        if (!text)
            throw new Error("gemini_empty_response");
        return {
            text,
            provider: this.name,
            model: this.model,
            usage: {
                promptTokens: body.usageMetadata?.promptTokenCount ?? 0,
                completionTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
                totalTokens: body.usageMetadata?.totalTokenCount ?? 0,
            },
        };
    }
}
function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
    });
}
//# sourceMappingURL=gemini.js.map