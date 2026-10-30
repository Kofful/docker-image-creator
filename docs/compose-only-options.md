# Compose-only generation options

Status: the user accepted the public-image, single-Compose-document direction in [ADR 0002](adr/0002-compose-only-generation.md), superseding custom builds from [ADR 0001](adr/0001-generated-bundles-and-validation-runs.md). Fixed-starter Compose generation and persistence now exist with a deterministic fake; the runner and live LLM remain planned. The options below explain the decision.

## Existing public images

Compose can start services from published images using `image` with no `build` section or Dockerfile. Settings, environment, networking, ports, volumes, and a command can be declared in the Compose document. Images may need pulling before startup; a standalone document does not guarantee readiness or network availability. See Docker's [image](https://docs.docker.com/reference/compose-file/services/#image), [command](https://docs.docker.com/reference/compose-file/services/#command), and [startup-order](https://docs.docker.com/compose/how-tos/startup-order/) documentation.

An application already included in an image can run without additional application source. The [MySQL official image](https://hub.docker.com/_/mysql) supports initialization settings through environment variables, including creation of a database/user. The [Python image](https://hub.docker.com/_/python) supplies the interpreter; custom application logic and non-included dependencies still need a source. The same distinction applies to the [Node.js runtime image](https://hub.docker.com/_/node).

## Options

| Approach                                               | Separate authored project files                                           | Local image build | Main use or limitation                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| Approved prebuilt service image with settings          | None beyond Compose                                                       | No                | Databases or complete applications already present in an image                                         |
| Public runtime with an approved command or inline code | None beyond Compose                                                       | No                | Built-in tools or small starters using included libraries                                              |
| Public runtime with inline Compose configs             | No separately authored source/config files                                | No                | Small scripts/configuration embedded in YAML and mounted inside containers                             |
| Download source/dependencies during startup            | Can avoid extra authored host files                                       | No                | Adds startup network dependencies, mutable runtime state, and failure modes; not recommended initially |
| Inline Dockerfile in Compose                           | Can omit a separate Dockerfile; other context files may still be required | Yes               | A single YAML document can contain build instructions, but it still performs a custom build            |

[`configs.content`](https://docs.docker.com/reference/compose-file/configs/) embeds non-secret text in Compose and grants it to selected services as a mounted file. Docker documents inline content starting with Compose 2.23.1. This can carry a small script without an adjacent source file. It does not mean no files exist inside containers or that the Compose implementation never materializes internal host files. Configs are not a secret store; interpolation and mounted permissions require deliberate handling.

[`build.dockerfile_inline`](https://docs.docker.com/reference/compose-file/build/#dockerfile_inline) embeds a Dockerfile in YAML; Docker documents support starting with Compose 2.17.0. A build context is still a build context. This option removes a separate Dockerfile, not the build stage or the need to supply referenced application content.

Using a runtime's inline execution mode or installing declared dependencies during startup is a design inference from the ability to override its command; it needs template-specific testing. It does not make arbitrary generated code or commands safe. Keep the catalog, executable/argument policy, ownership checks, quotas, and runner boundary.

## Accepted direction

Use approved public images and a single generated Compose document for the first version. Node/Python services run fixed small HTTP starters; databases use stock images. Generation-attempt persistence and polling are implemented. The accepted automatic start/readiness/observation/stop trial, Docker failure cleanup, volume preservation, and later explicit lasting start remain part of the later runner milestone. Custom builds are deferred.

Inline non-secret code/configuration is permitted; current templates need no adjacent authored files. A single generated Compose document is different from a promise that Docker creates no local image, container, config, secret, or volume storage. Tags are fixed in the compiler and Compose parsing is tested; actual pull/start/platform checks remain runner prerequisites. Public availability alone does not put an image in the approved catalog.
