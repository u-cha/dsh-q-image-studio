Vendored build artifacts (MIT), copied verbatim from the running DeepSeek Harness
`@deepseek-ai/schemastery@3.19.0` and `@deepseek-ai/cosmokit@1.9.0`.

Only one change is applied: schemastery's `from "@deepseek-ai/cosmokit"` import is
rewritten to `from "./cosmokit.js"`, because a locally installed DSH plugin resolves
bare specifiers from the profile's node_modules, where these packages do not exist.
This keeps the plugin self-contained and adds no package-manager dependency.
