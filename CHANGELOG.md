# Changelog

## [3.0.1](https://github.com/tzzs/agentx/compare/v3.0.0...v3.0.1) (2026-08-30)


### Bug Fixes

* auto-install npm deps in Makefile build/test targets ([48a0a29](https://github.com/tzzs/agentx/commit/48a0a295f81f9c6d39475e2ba49f0a5da59102a4))
* auto-install npm deps in Makefile build/test targets ([26d6575](https://github.com/tzzs/agentx/commit/26d6575b67f7229c20c373c03738bbba730e8814))

## [3.0.0](https://github.com/tzzs/agentx/compare/v2.0.1...v3.0.0) (2026-08-30)


### ⚠ BREAKING CHANGES

* remove Pi Agent support

### Features

* add local /v1/chat/completions endpoint for full 3-protocol support ([5a693f4](https://github.com/tzzs/agentx/commit/5a693f44b7f3532cafb815eb5520e0ab2efe5be0))
* **registry:** persist the OpenCode catalog with a 24h TTL ([dfb3ca2](https://github.com/tzzs/agentx/commit/dfb3ca2d3e6fdc362d66c21b43e8796f0834762e))
* remember quick-start menu action per client ([822c1a9](https://github.com/tzzs/agentx/commit/822c1a9d938b07e3a59c624739c1d9208ed61dab))
* remember quick-start menu action per client ([bf88067](https://github.com/tzzs/agentx/commit/bf88067d2f46255538f5b48a90f144a61a923533))
* remove Pi Agent support ([baf04e6](https://github.com/tzzs/agentx/commit/baf04e61a88461f9d97fbfe01729e2c5962980cf))
* **server:** remove /usage/* HTTP endpoints and harden request handling ([219b9ea](https://github.com/tzzs/agentx/commit/219b9eac5f3d90db96e6042228fcca6ea23292f6))


### Bug Fixes

* **cli:** read the version from package.json instead of a hardcoded constant ([5c9c934](https://github.com/tzzs/agentx/commit/5c9c93426ae105857f8d3526fb8a58429e2844ee))
* drop redundant static "Using: ..." line from quick-start menu ([5f34275](https://github.com/tzzs/agentx/commit/5f34275d4bf4d58a6e67dafac0efb63693c92154))
* drop redundant static "Using: ..." line from quick-start menu ([813bb22](https://github.com/tzzs/agentx/commit/813bb22e3484d1ef2f465855f21fa549ffacf036))
* fail fast on an unrecognized command instead of hanging ([5f9311c](https://github.com/tzzs/agentx/commit/5f9311c90d58f438351378e84cc7a0b58f8dc740))
* **forget:** screen only OpenRouter ids against the OpenRouter catalog ([8e991f8](https://github.com/tzzs/agentx/commit/8e991f881a47c3245ad4509b96b5fba9b8bff7e9))
* **process:** scrub AgentX's own config vars from native launches ([d1e8a18](https://github.com/tzzs/agentx/commit/d1e8a1852bc242a98208c03667f561127298fd33))
* **providers:** cap the Anthropic thinking budget under max_tokens ([b680046](https://github.com/tzzs/agentx/commit/b68004608a72c7215ed89da3478622fa2d70d17e))
* **server:** keep the adapter alive when a request handler rejects ([23832d4](https://github.com/tzzs/agentx/commit/23832d472c405f345a8d559b04b7ce45955c0bdb))

## [2.0.1](https://github.com/tzzs/agentx/compare/v2.0.0...v2.0.1) (2026-08-28)


### Bug Fixes

* add repository field to package.json for npm provenance verification ([be73ba3](https://github.com/tzzs/agentx/commit/be73ba3ce3447c038987fbcb7ab2f62071e12d5c))
* add repository field to package.json for npm provenance verification ([f4cb9de](https://github.com/tzzs/agentx/commit/f4cb9de3f5c40979981533558944f321657551d4))

## [2.0.0](https://github.com/tzzs/agentx/compare/v1.0.0...v2.0.0) (2026-08-28)


### ⚠ BREAKING CHANGES

* secure credential storage (keytar) is removed and agentx auth login no longer saves keys; set AGENTX_<PROVIDER>_API_KEY (or keep using <PROVIDER>_API_KEY) in your environment instead.

### Features

* add --client and --offline options to doctor command ([605d97b](https://github.com/tzzs/agentx/commit/605d97b65fb0df6de7f2a8e8dbf58ed0e504c80f))
* add --native launch mode for Claude Code and Codex ([f302181](https://github.com/tzzs/agentx/commit/f302181f0dc637739b1560ef2249210822187a17))
* add interactive model selection ([57a7835](https://github.com/tzzs/agentx/commit/57a7835ae465c0fdec68996e1dd3f0b2eafd510e))
* add interactive model selection ([e57c59d](https://github.com/tzzs/agentx/commit/e57c59dad50814fdfd339d1d7a1259d3f5cb2b78))
* add multi-provider adapter architecture ([8895d7a](https://github.com/tzzs/agentx/commit/8895d7a0f617b49e80943790c07c35a6ab325483))
* add multi-provider architecture ([e3be718](https://github.com/tzzs/agentx/commit/e3be71802fa38c1cf36877c82252ae07a9d119d2))
* add OpenRouter catalog browsing and a saved-model forget manager ([d163fda](https://github.com/tzzs/agentx/commit/d163fdada4ef20d971ad81375f449036730b91d6))
* add provider profiles and secure credential setup ([c95ad7d](https://github.com/tzzs/agentx/commit/c95ad7da0e392baeb7d824284cda65d89bce5bed))
* add provider profiles and secure credentials ([870e005](https://github.com/tzzs/agentx/commit/870e005fd0ae451ab67d97050930c6bb1737ebf6))
* add provider-specific usage queries ([59965ea](https://github.com/tzzs/agentx/commit/59965eaacc9aaf79c8e9f07f34f5b425a59b6165))
* add provider-specific usage queries ([417a3f1](https://github.com/tzzs/agentx/commit/417a3f118b78d4be7324896d10ad353f2c154efa))
* add quick-start menu when default provider/model exists ([d26b76c](https://github.com/tzzs/agentx/commit/d26b76c19a5523adbb4b7ad5db4824fdb0cf34dc))
* add searchable model picker to the interactive launcher ([cde0ed0](https://github.com/tzzs/agentx/commit/cde0ed0aed55dbb5fde1fdd9f1b65d38d9d64c38))
* add token usage statistics for every provider ([8d92d9d](https://github.com/tzzs/agentx/commit/8d92d9d6e96d84440b0a1524ed8e502c69417947))
* add token usage statistics for every provider ([5d5e570](https://github.com/tzzs/agentx/commit/5d5e57053569b341f8e79514be02add7db68fcc8))
* auto-save launcher selection as the client default ([c16216b](https://github.com/tzzs/agentx/commit/c16216b8dc94e15acc5a005e1af24304dc894650))
* backfill model metadata from OpenRouter's public catalog ([232e438](https://github.com/tzzs/agentx/commit/232e438d57fe4ddc6e0cb589462d420df1803845))
* **config:** shared parseCliOptions with --key=value support and --verbose ([b6b71c6](https://github.com/tzzs/agentx/commit/b6b71c609e4f168a1d419fa8eb674aa5bfcdf910))
* **credentials:** offer to save entered API keys to the shell profile ([3b64b63](https://github.com/tzzs/agentx/commit/3b64b6307d9ff34f2ab946a966654be1550e78b9))
* enrich every provider's models with models.dev metadata ([1349cc3](https://github.com/tzzs/agentx/commit/1349cc3b0ed85e581ba0e2ae6990bb66ead442af))
* fetch OpenCode model catalog from upstream API ([98bfcd0](https://github.com/tzzs/agentx/commit/98bfcd02f5eda7e3b95a8d72526c0b9893b9dc43))
* fetch OpenCode model catalog from upstream API ([d2782ff](https://github.com/tzzs/agentx/commit/d2782ff8d39f653ee528157643bba8d3bc4bf860))
* generate a Codex model catalog to silence fallback-metadata warnings ([4ac5b7f](https://github.com/tzzs/agentx/commit/4ac5b7fdf6891a3b54c765b84faef9eb57b191d0))
* guided client install recovery and tiered/background model routing ([cac8d80](https://github.com/tzzs/agentx/commit/cac8d80ca0b175100b1a3f8af2af6e86b447e1f0))
* harden credentials and client support ([727a85a](https://github.com/tzzs/agentx/commit/727a85aabda76f8060de1478d831549f13079616))
* harden doctor report and refresh docs ([750ce52](https://github.com/tzzs/agentx/commit/750ce523e5dc758995988927abf7fbe173f12e23))
* harden doctor report and refresh docs ([b7e6a27](https://github.com/tzzs/agentx/commit/b7e6a2772f20e252ab99d06c752b9da4f515c0a8))
* honor client-requested models within the active provider ([408678c](https://github.com/tzzs/agentx/commit/408678cfba4947d11e153692b68f6ca08582c406))
* offer custom model id entry in the interactive launcher for OpenRouter ([f88d92f](https://github.com/tzzs/agentx/commit/f88d92f599776d16963843e8b67dd3384a16af5d))
* offer custom model id entry in the interactive launcher for OpenRouter ([b7c0e1c](https://github.com/tzzs/agentx/commit/b7c0e1c624d5db138cbf5a21f211be67f31d1c9c))
* offer guided install for missing client CLIs and a background model override ([94c0fb3](https://github.com/tzzs/agentx/commit/94c0fb3c075c474c8f3a91daea03d79e973fee2f))
* **protocol:** pass temperature/top_p/stop_sequences through both the ([92c13f5](https://github.com/tzzs/agentx/commit/92c13f5eed87b74c020b19ee1d4977465f08e5b0))
* **providers:** support registering custom OpenAI/Anthropic-compatible providers ([8ceabe1](https://github.com/tzzs/agentx/commit/8ceabe155fe1d2207cf6ce262a70d5825223b05b))
* read provider credentials from AGENTX_-prefixed environment variables ([f11f4c3](https://github.com/tzzs/agentx/commit/f11f4c3df56cb1b4e10bbfef2cc003530ed44a51))
* redesign runtime configuration UX with inline launcher ([a35dcb7](https://github.com/tzzs/agentx/commit/a35dcb7f06787c9d8ce188a26b9a2eca7798fc4e))
* redesign runtime configuration UX with inline launcher ([5bd867b](https://github.com/tzzs/agentx/commit/5bd867b129e41f21f1f833b46b33cfab44f57bb7))
* remember last used model and fix chat tool conversion ([bb51039](https://github.com/tzzs/agentx/commit/bb51039cc023314b3d1d935edb6a357e1b80df46))
* remember last used model and fix chat tool conversion ([d6fc710](https://github.com/tzzs/agentx/commit/d6fc7100f74d59774c515c39f29aaf672bd83e94))
* route all clients through provider protocols ([f45da37](https://github.com/tzzs/agentx/commit/f45da373544a85d56e986fc13ca6d9a5d8e72b92))
* **server:** retry upstream 429/5xx, and support Anthropic-protocol custom providers end to end ([49cd1ea](https://github.com/tzzs/agentx/commit/49cd1eae74eef8285422b921d33861fcdf476636))
* source Codex catalog limits from OpenCode's public registry ([22c17f0](https://github.com/tzzs/agentx/commit/22c17f0ba7bbd677375042aeb1f5402b3e6537b4))
* stream reasoning and cached usage across protocol conversions ([6a90f63](https://github.com/tzzs/agentx/commit/6a90f63f02b82769cd754b1672b4b7322c4bae8b))
* stream upstream reasoning as thinking blocks and report cached token usage ([ee04228](https://github.com/tzzs/agentx/commit/ee042285d7aa33df2347f88b55e497841c4a5ea4))
* support all provider protocols for Claude and Codex ([aaebe85](https://github.com/tzzs/agentx/commit/aaebe858dad518bcc97ea1927f0eff473adbc377))
* **usage:** capture cache and reasoning tokens from stream usage ([5356fc7](https://github.com/tzzs/agentx/commit/5356fc7ea4e0b195d5a67b6799172cc07e27037e))


### Bug Fixes

* advertise claude model aliases ([a1f1f8c](https://github.com/tzzs/agentx/commit/a1f1f8c02286d4f41aa72d9d5846d41d1210f8a9))
* align agentx usage store with adapter and fix json store race ([01907f2](https://github.com/tzzs/agentx/commit/01907f2243318e0f8c03b6d4bf8ddb34e58872cf))
* **auto:** route auto model selection within the pinned provider's catalog ([92c13f5](https://github.com/tzzs/agentx/commit/92c13f5eed87b74c020b19ee1d4977465f08e5b0))
* avoid duplicate streaming text ([b5617da](https://github.com/tzzs/agentx/commit/b5617da39c91afb2805309c8839384f4af443079))
* **catalog:** preserve image and structured parts across protocol conversions ([92c5b66](https://github.com/tzzs/agentx/commit/92c5b667046e7f8ad1785b174028a69e8a1044da))
* change option in quick-start menu now opens the picker flow ([0d056e1](https://github.com/tzzs/agentx/commit/0d056e1e0e46e9b430aac65005e9d67390da1e1f))
* **cli:** resolve symlinks before comparing argv[1] to import.meta.url ([fa9ca9a](https://github.com/tzzs/agentx/commit/fa9ca9a49b02facc3ac4d0123900b4ced641be98))
* **cli:** strip inline --flag=value adapter flags from client arguments ([92c13f5](https://github.com/tzzs/agentx/commit/92c13f5eed87b74c020b19ee1d4977465f08e5b0))
* correct DeepSeek reasoning, thinking, and context-window handling ([5768b5a](https://github.com/tzzs/agentx/commit/5768b5a3ae5f656a3cc7cb06d3566a79ccd78877))
* correct usage cost estimation and harden usage store ([65a8463](https://github.com/tzzs/agentx/commit/65a84630836f00f433959b0c71275e1f5d5af98e))
* declare DeepSeek's real context window for Codex and Pi too ([30c7b6b](https://github.com/tzzs/agentx/commit/30c7b6b52ad0c137e35a57986a3a6071c5dde0b7))
* enable interactive model navigation ([1278699](https://github.com/tzzs/agentx/commit/127869902cb5507ec25b3746cee921be5bb0500a))
* expose selected model to claude code ([184b131](https://github.com/tzzs/agentx/commit/184b131059fc2cbd0da3381bcbd99a841dce7873))
* flatten responses tool history ([40f4bd7](https://github.com/tzzs/agentx/commit/40f4bd7cb5401dc2bf239b144f11e8d516ea68b3))
* forward client arguments to codex and pi without requiring -- separator ([17eb5f1](https://github.com/tzzs/agentx/commit/17eb5f1534ab3abecc6279d7ebd9eaafd68c05d4))
* forward streamed tool calls ([4ead6fb](https://github.com/tzzs/agentx/commit/4ead6fbb98bd4601ca825a93c5b37c866be9b79c))
* harden atomic writes and install recovery; dedupe help and codex catalog ([51a5108](https://github.com/tzzs/agentx/commit/51a510863967af65f51598615c933011d249b10b))
* harden usage query and simplify parsing ([b410909](https://github.com/tzzs/agentx/commit/b4109090e6a8a82ab9a600ed4e5e7d738f6547c3))
* hide unavailable upstream models ([42f2b2e](https://github.com/tzzs/agentx/commit/42f2b2ec2437828bcd1940e396689597d0eceb5d))
* include custom model ids in the generated Codex catalog ([7506108](https://github.com/tzzs/agentx/commit/750610864f80a601a1f67f39b9cfe1523f606157))
* launch Codex with -c provider overrides for current Codex releases ([8eefcae](https://github.com/tzzs/agentx/commit/8eefcae33f572787c0212f2c8f8449889e84acce))
* launcher nested selectors freeze, cancel exit code, single last-model write ([457e9b5](https://github.com/tzzs/agentx/commit/457e9b5ea8b68066c213109cec0b223635ab16d4))
* **process:** detect a missing client on Windows before spawning ([ede0d14](https://github.com/tzzs/agentx/commit/ede0d14885b2bc0adb2c0d3f3bc3fb087ee6d93d))
* publish under the [@tanzz](https://github.com/tanzz) npm scope, not [@tzzs](https://github.com/tzzs) ([ebca5be](https://github.com/tzzs/agentx/commit/ebca5be9c68f7d12504411cc8ae52226a1a0be48))
* scrub AgentX's own env vars from nested --native launches ([b12c012](https://github.com/tzzs/agentx/commit/b12c012ade44c55d14fc2b78abd3a90887b7344d))
* **server:** abort upstream on client disconnect and name the failing provider ([1660e5c](https://github.com/tzzs/agentx/commit/1660e5c042b2aa9b245af69864950c1aa2b78093))
* **server:** cap EADDRINUSE port retries at 100 ports, reuse one parsed ([92c13f5](https://github.com/tzzs/agentx/commit/92c13f5eed87b74c020b19ee1d4977465f08e5b0))
* **server:** resolve model auto per request on /v1/responses ([4741217](https://github.com/tzzs/agentx/commit/47412177d49367d31ba0104497956172e4324eba))
* skip duplicate provider selection in interactive launcher ([25c3bf3](https://github.com/tzzs/agentx/commit/25c3bf3fbccf084b43e2664fdaefae0be1272cec))
* stop forwarding SIGINT to child to avoid forced aborts ([3fc0351](https://github.com/tzzs/agentx/commit/3fc0351798def777ebdf0a6f2fe55c49f4dca79b))
* **storage:** serialize JsonFileUsageStore writes through a queue so ([92c13f5](https://github.com/tzzs/agentx/commit/92c13f5eed87b74c020b19ee1d4977465f08e5b0))
* **streaming:** end streams with a terminal error when the upstream fails mid-flight ([8f7650a](https://github.com/tzzs/agentx/commit/8f7650a8ae3d53fc082f84c859ff5360dd84b667))
* **streaming:** keep the usage extractor and StreamUsageOptions exhaustive after widening ProviderProtocol ([375816e](https://github.com/tzzs/agentx/commit/375816e60cb7d3796c04d7887a4791619b6d1998))
* **streaming:** separate parallel tool calls and honor length stop reason ([92c13f5](https://github.com/tzzs/agentx/commit/92c13f5eed87b74c020b19ee1d4977465f08e5b0))
* support claude code request flow ([548ffe2](https://github.com/tzzs/agentx/commit/548ffe242c3f2a0e32c750994419c448e51e25ee))
* **test:** skip the POSIX signal-forwarding test on Windows ([b40c45e](https://github.com/tzzs/agentx/commit/b40c45e9fe836579b00110dc3b827ccfb23e4b36))
* **ui:** reuse the API key entered in the launcher and drop the Auto model entry ([80b1907](https://github.com/tzzs/agentx/commit/80b1907a2da1097948776eda717289a6260a6bec))
* use anthropic-shaped local token ([f9af587](https://github.com/tzzs/agentx/commit/f9af5879311211436c38accb3fdd221f245bc1e7))
* use auth token for claude integration ([1574966](https://github.com/tzzs/agentx/commit/1574966b854587cce239dd5ee8631fd131fdedf9))
* use client model alias for claude ([1b07d2a](https://github.com/tzzs/agentx/commit/1b07d2a7159a8614ccf0daeabd22ac40360f2442))
* use scoped npm package name @tzzs/agentx ([70c09cf](https://github.com/tzzs/agentx/commit/70c09cf66f7a31b06b7366116c412a2119cc5c20))
* use scoped npm package name @tzzs/agentx ([02a02cc](https://github.com/tzzs/agentx/commit/02a02ccf2467f7ce1d3af0f26343c3600cc1a16b))

## 1.0.0 (2026-08-15)


### Features

* add anthropic streaming ([2519642](https://github.com/tzzs/agentx/commit/251964262c6adfc89995307b044e6c72061616c4))
* add automatic model routing ([34f0973](https://github.com/tzzs/agentx/commit/34f09737fb4a2782b0ef68c704a9729b74218023))
* add codex support and release please ([cfd450b](https://github.com/tzzs/agentx/commit/cfd450b619308e1556e37a181f5a32544e1f027b))
* add Codex support and Release Please ([82616dc](https://github.com/tzzs/agentx/commit/82616dc29a030171a7697da70a4f63744346995b))
* add model provider routing ([d2fc271](https://github.com/tzzs/agentx/commit/d2fc271a6d1bb3a5248248a1bd1a3cddbb74134a))
* implement phase 1 adapter ([d5e76ff](https://github.com/tzzs/agentx/commit/d5e76ff02d622a75a4c66366741038cb937546e8))
* translate tool calls ([cd0da47](https://github.com/tzzs/agentx/commit/cd0da47ea416ea4969d69f386032fb197a9286de))


### Bug Fixes

* remove invalid release please input ([0acfab4](https://github.com/tzzs/agentx/commit/0acfab43680b0d732cfdbabcd95a064c7136cbb3))
* remove invalid Release Please input ([3f97de5](https://github.com/tzzs/agentx/commit/3f97de5193e53413238411824d9453743c155f46))
