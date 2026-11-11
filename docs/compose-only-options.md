# Why one Compose document and public images

[ADR 0002](adr/0002-compose-only-generation.md) replaced custom Dockerfile/build bundles with a single Compose document using approved public images. [ADR 0004](adr/0004-direct-llm-compose-generation.md) later replaced fixed starters/procedural compilation with model-authored service behavior while preserving that boundary.

| Approach                                                     | Project decision                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Approved image with settings                                 | Supported for databases and included tooling                       |
| Node/Python inline commands using shipped standard libraries | Supported for small application behavior within policy             |
| Embedded Compose configs / adjacent source files             | Outside the current allowlist                                      |
| Download code or install dependencies at startup             | Excluded: workload egress and installers/downloaders are forbidden |
| Inline/separate Dockerfile or arbitrary build context        | Excluded: single YAML must not introduce custom image builds       |

The model must provide complete commands, health checks, dependencies and bindings within the [current policy](compose-policy.md). Missing settings cause rejection; there is no starter/compiler fallback. Static validation and independent runtime probes remain necessary. Deferred automatic trials are separate from explicit Start and the terminal evaluator.
