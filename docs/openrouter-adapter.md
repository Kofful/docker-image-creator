# Historical OpenRouter adapter

The original direct-Compose integration used OpenRouter Chat Completions with `google/gemma-4-26b-a4b-it:free`, `OPENROUTER_API_KEY` and zero prompt/completion/request price ceilings. It introduced the typed generation seam, value-free policy prompt, bounded responses/retries and safe provider/model metadata. Initial product orchestration permitted one validation-driven content repair; evaluation always scored the first response.

This implementation is superseded. Current generation/evaluation uses the [configurable Modal/OpenAI SDK adapter](openai-compatible-adapter.md) with `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`; content repair has been removed. There is no OpenRouter configuration or fallback in the active path.

Keep the [first live OpenRouter baseline](evaluation/run-074b86dd.md) as historical evidence: policy/startup/task 0/10, nine rate-limit failures and one policy rejection. It does not measure the current endpoint/model/prompt. [History](history.md) records the migration and verification results.
