export class OpenAiProvider {
    model;
    apiKey;
    fetcher;
    name = "openai";
    constructor(model, apiKey, fetcher = fetch) {
        this.model = model;
        this.apiKey = apiKey;
        this.fetcher = fetcher;
    }
    async generate(input) {
        const response = await this.fetcher("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
                model: this.model,
                messages: [{ role: "system", content: input.system }, { role: "user", content: input.prompt }],
                response_format: { type: "json_object" },
                max_completion_tokens: input.maxOutputTokens ?? 1800,
            }),
            signal: input.signal,
        });
        if (!response.ok)
            throw new Error(`openai_http_${response.status}`);
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
//# sourceMappingURL=openai.js.map