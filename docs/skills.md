# Coding skill recommendations

Status: recommendations only. No additional skills or plugins were installed, and no credentials were configured. Skills guide the coding agent; they do not run inside the application. The current session has no dedicated NestJS/Vue/MySQL skill listed.

## Available skills to use when relevant

| Skill | When to apply | Value and boundary |
| --- | --- | --- |
| `openai-docs` | Selecting or implementing an OpenAI provider | Verify current official APIs/models and SDK behavior; provider is still undecided |
| `openai-developers:openai-platform-api-key` | Before configuring or making real calls for the AI integration | Safely inspect credentials and follow reuse/new-key setup; never print secrets |
| `openai-developers:agents` | If the chosen provider implementation uses OpenAI Agents API/SDK | Tool contracts, sessions, limits, and agent execution patterns; no Docker execution tool |
| `openai-developers:openai-api-troubleshooting` | A real OpenAI request fails | Diagnose credentials, quota, connectivity, and access without exposing secrets |
| `skill-creator` | Repeated repository workflows emerge | Create a project skill backed by actual code and commands rather than speculative scaffolding |
| `skill-installer` | Discovering or installing additional reviewed skills | Review source/scope, then install only useful skills from a known repository |

These skills are already available to this coding session and do not need duplicate installation. Future sessions must check availability before relying on them. Installed skills become available on a subsequent turn; installation does not pin application dependencies.

## Useful additional skill areas
If discovering external skills, prioritize these capabilities and review their instructions before installation:

1. Vue 3 + TypeScript: Composition API, routing, form accessibility, and safe terminal component lifecycle.
2. NestJS APIs: module boundaries, DTO validation, cookie sessions, authorization, and WebSocket authentication.
3. Prisma + MySQL: reviewed migrations, transactions, durable operation claiming, and schema constraints.
4. Docker Compose and Engine security: allowlisted generation, scoped lifecycle management, exec stream cleanup, and integration tests.
5. Playwright: authenticated browser flows and terminal interaction against disposable infrastructure.

These are desired capabilities, not verified installable skill names. Do not assume a third-party skill is official or compatible because its name matches the stack. Review repository provenance, maintenance, required tools, permissions, and architectural fit. Avoid skills that replace MySQL, require unrelated hosting, expose the Docker socket, or introduce email flows.

## Recommended activation sequence
Start with this repository's `AGENTS.md` and planning documents. Use framework documentation during scaffolding. Apply credential setup and OpenAI documentation only when provider integration begins; apply the Agents skill only if that SDK/API is selected. Add a repository-specific skill later for a stable, repeated workflow such as catalog-template validation and safe disposable-stack testing.

Figma, Sites hosting, image generation, and pet skills are not needed for the current scope. No external account connection is necessary to implement the planned local architecture.
