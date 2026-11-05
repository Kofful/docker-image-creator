---
status: accepted
---

# Generate Compose directly with the selected LLM

On 2026-11-05 the user chose direct Compose generation through OpenRouter's `google/gemma-4-26b-a4b-it:free`, replacing both procedural service-spec compilation and runtime Compose regeneration. This supersedes the structured-spec/compiler and fixed-starter portions of [ADR 0002](0002-compose-only-generation.md): retain the four-image catalog and execution isolation, but validate, save, and execute the model-authored document itself. Required identities and policy settings are supplied to the model; missing/invalid settings cause rejection and at most one product-generation repair, without procedural or paid-model fallback.

Users supply environment values and shared service bindings during creation. Confidential values remain encrypted and outside model requests, previews, and logs; require all declared values before generation and reject undeclared secret references. General saved-configuration editing and secret rotation remain deferred. Existing template-generated configurations are unsupported, superseding the earlier compatibility recommendation; there is no legacy compiler, automatic conversion, or backward-compatible execution path. This cutoff does not authorize deletion of retained data. See the [implementation plan](../llm-compose-plan.md).

The accepted [evaluation design](../llm-compose-evaluation.md) runs ten fixed cases from a testing-only terminal command, prints all results, and writes report files without database persistence. It scores first-response policy acceptance, healthy startup, and independent task correctness, with provider/infrastructure failures and cleanup reported separately. This does not change ordinary generation into automatic Docker execution.
