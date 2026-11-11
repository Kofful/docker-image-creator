# Compose validation and persistence

`validateCompose(compose, requirements)` returns the original string, its UTF-8 SHA-256 digest and derived inspection metadata. It never serializes, patches, repairs or compiles a replacement. New creation/generation/runtime paths all use version 2.

## Parsing and policy

The pinned YAML parser uses strict YAML 1.2 core semantics. Reject blank/oversized input, NUL/invalid Unicode, multiple documents, parser errors/warnings, duplicate/nonstring keys, directives/tags, anchors/aliases and merge keys. AST conversion is bounded to 64 levels and 20,000 nodes and creates mappings without prototypes. Public errors exclude parser excerpts and arbitrary model-authored keys/values.

Enforce the complete [policy](compose-policy.md): exact server identities/requested services, approved images, resource/log/capability settings, private network, no publication, required database volumes, health timings, acyclic healthy dependencies and known environment bindings. Unknown fields fail recursively. MySQL public defaults are requested database or `app`, username `app`; MongoDB defaults are requested database or `app`, root username `app`. Declared supplied bindings may replace defaults. Every private binding uses its assigned opaque reference exactly; unapproved literals/inheritance/interpolation fail.

Commands are optional argument arrays; health checks require `CMD` or `CMD-SHELL`. Container dollars use `$$`. Obvious installers/downloaders are rejected, but static checks cannot prove arbitrary in-image program behavior or the truth of model health checks. Evaluation uses independent probes.

`validateSavedCompose` verifies envelope/version, identity/digest, complete YAML and newly derived metadata against the stored requirements and binding rows. Binding order is normalized; reference, purpose and assignment changes fail. Admission, runner operations/observations and terminal authorization/cleanup share this boundary.

## Durable publication

The generation worker has two durable global slots, per-user admission, encrypted input/response capture, bounded deadlines, leases and fenced writes. It captures the single complete returned response encrypted before validation, including rejected output. A marked bounded portion is retained for oversized output. Invalid content ends the attempt; no feedback/replacement request or procedural fallback.

Success requires an active unexpired lease, matching ownership and a nondeleted configuration. Original YAML is flushed/atomically renamed into its private UUID artifact path, then revision and success state commit together. Failed/expired workers cannot publish stale artifacts. Failed publication rolls back and schedules scoped cleanup when needed. See [configuration API](configuration-api.md) for queue/file bounds and [saved execution](saved-compose-runtime.md) for the privileged boundary.

## Checks

`pnpm test:compose-validation` exercises malformed/adversarial YAML, nested unknown fields, unsafe host access, identity/label/resource/network/mount changes, undeclared references, dependency cycles and saved-artifact tampering. Contract/provider tests cover byte integrity and one-response behavior. `pnpm test:api` checks encrypted capture, exact DB/file/digest agreement, queue/concurrency/deadline fencing, ownership and storage rollback with disposable MySQL and mocked inference. Historical outcomes are in [history](history.md).
