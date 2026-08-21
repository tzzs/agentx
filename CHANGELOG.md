# Changelog

## [1.1.0](https://github.com/tzzs/agentx/compare/v1.0.0...v1.1.0) (2026-08-21)


### Features

* add interactive model selection ([57a7835](https://github.com/tzzs/agentx/commit/57a7835ae465c0fdec68996e1dd3f0b2eafd510e))
* add interactive model selection ([e57c59d](https://github.com/tzzs/agentx/commit/e57c59dad50814fdfd339d1d7a1259d3f5cb2b78))
* add multi-provider adapter architecture ([8895d7a](https://github.com/tzzs/agentx/commit/8895d7a0f617b49e80943790c07c35a6ab325483))
* add multi-provider architecture ([e3be718](https://github.com/tzzs/agentx/commit/e3be71802fa38c1cf36877c82252ae07a9d119d2))
* add provider profiles and secure credential setup ([c95ad7d](https://github.com/tzzs/agentx/commit/c95ad7da0e392baeb7d824284cda65d89bce5bed))
* add provider profiles and secure credentials ([870e005](https://github.com/tzzs/agentx/commit/870e005fd0ae451ab67d97050930c6bb1737ebf6))
* add provider-specific usage queries ([59965ea](https://github.com/tzzs/agentx/commit/59965eaacc9aaf79c8e9f07f34f5b425a59b6165))
* add provider-specific usage queries ([417a3f1](https://github.com/tzzs/agentx/commit/417a3f118b78d4be7324896d10ad353f2c154efa))
* add token usage statistics for every provider ([8d92d9d](https://github.com/tzzs/agentx/commit/8d92d9d6e96d84440b0a1524ed8e502c69417947))
* add token usage statistics for every provider ([5d5e570](https://github.com/tzzs/agentx/commit/5d5e57053569b341f8e79514be02add7db68fcc8))
* fetch OpenCode model catalog from upstream API ([98bfcd0](https://github.com/tzzs/agentx/commit/98bfcd02f5eda7e3b95a8d72526c0b9893b9dc43))
* fetch OpenCode model catalog from upstream API ([d2782ff](https://github.com/tzzs/agentx/commit/d2782ff8d39f653ee528157643bba8d3bc4bf860))
* harden credentials and client support ([727a85a](https://github.com/tzzs/agentx/commit/727a85aabda76f8060de1478d831549f13079616))
* harden doctor report and refresh docs ([750ce52](https://github.com/tzzs/agentx/commit/750ce523e5dc758995988927abf7fbe173f12e23))
* harden doctor report and refresh docs ([b7e6a27](https://github.com/tzzs/agentx/commit/b7e6a2772f20e252ab99d06c752b9da4f515c0a8))
* redesign runtime configuration UX with inline launcher ([a35dcb7](https://github.com/tzzs/agentx/commit/a35dcb7f06787c9d8ce188a26b9a2eca7798fc4e))
* redesign runtime configuration UX with inline launcher ([5bd867b](https://github.com/tzzs/agentx/commit/5bd867b129e41f21f1f833b46b33cfab44f57bb7))
* remember last used model and fix chat tool conversion ([bb51039](https://github.com/tzzs/agentx/commit/bb51039cc023314b3d1d935edb6a357e1b80df46))
* remember last used model and fix chat tool conversion ([d6fc710](https://github.com/tzzs/agentx/commit/d6fc7100f74d59774c515c39f29aaf672bd83e94))
* route all clients through provider protocols ([f45da37](https://github.com/tzzs/agentx/commit/f45da373544a85d56e986fc13ca6d9a5d8e72b92))
* support all provider protocols for Claude and Codex ([aaebe85](https://github.com/tzzs/agentx/commit/aaebe858dad518bcc97ea1927f0eff473adbc377))


### Bug Fixes

* advertise claude model aliases ([a1f1f8c](https://github.com/tzzs/agentx/commit/a1f1f8c02286d4f41aa72d9d5846d41d1210f8a9))
* align agentx usage store with adapter and fix json store race ([01907f2](https://github.com/tzzs/agentx/commit/01907f2243318e0f8c03b6d4bf8ddb34e58872cf))
* avoid duplicate streaming text ([b5617da](https://github.com/tzzs/agentx/commit/b5617da39c91afb2805309c8839384f4af443079))
* correct usage cost estimation and harden usage store ([65a8463](https://github.com/tzzs/agentx/commit/65a84630836f00f433959b0c71275e1f5d5af98e))
* enable interactive model navigation ([1278699](https://github.com/tzzs/agentx/commit/127869902cb5507ec25b3746cee921be5bb0500a))
* expose selected model to claude code ([184b131](https://github.com/tzzs/agentx/commit/184b131059fc2cbd0da3381bcbd99a841dce7873))
* flatten responses tool history ([40f4bd7](https://github.com/tzzs/agentx/commit/40f4bd7cb5401dc2bf239b144f11e8d516ea68b3))
* forward streamed tool calls ([4ead6fb](https://github.com/tzzs/agentx/commit/4ead6fbb98bd4601ca825a93c5b37c866be9b79c))
* harden usage query and simplify parsing ([b410909](https://github.com/tzzs/agentx/commit/b4109090e6a8a82ab9a600ed4e5e7d738f6547c3))
* hide unavailable upstream models ([42f2b2e](https://github.com/tzzs/agentx/commit/42f2b2ec2437828bcd1940e396689597d0eceb5d))
* launcher nested selectors freeze, cancel exit code, single last-model write ([457e9b5](https://github.com/tzzs/agentx/commit/457e9b5ea8b68066c213109cec0b223635ab16d4))
* stop forwarding SIGINT to child to avoid forced aborts ([3fc0351](https://github.com/tzzs/agentx/commit/3fc0351798def777ebdf0a6f2fe55c49f4dca79b))
* support claude code request flow ([548ffe2](https://github.com/tzzs/agentx/commit/548ffe242c3f2a0e32c750994419c448e51e25ee))
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
