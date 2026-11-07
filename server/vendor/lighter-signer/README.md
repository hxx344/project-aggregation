# Lighter 官方签名器（WASM）

`server/trading-rh-lighter-signer-worker.mjs` 在独立线程中加载本目录的官方签名器，为 Lighter RH（Robinhood Chain，chain id 466324）签名下单、改单、撤单与鉴权令牌。worker 只暴露 `CreateClient`、`SignCreateOrder`、`SignModifyOrder`、`SignCancelOrder`、`CreateAuthToken`，不签转账、提现、杠杆或换密钥交易。

## 来源

| 文件 | 来源 | SHA-256 |
| --- | --- | --- |
| `lighter-signer.wasm.br` | [elliottech/lighter-go](https://github.com/elliottech/lighter-go) 提交 `aefa96848a105d82a6bbb55d3d05663293a71713` 的 `./wasm` 包，Brotli 压缩 | 压缩后 `21c340d5a5e43d3692829fabba661b0cbed5cccb481e82f531ed439e8800ea6f`；解压后 `801e60563c190283b857c00aa31e1d7786a685e814ff316f0318f94cb57ab53e` |
| `wasm_exec.js.br` | Go 1.26.10 发行包 `lib/wasm/wasm_exec.js`，未修改，Brotli 压缩（避免第三方原文中的 `console.log` 触发提交门禁） | 压缩后 `5e56478e653d94c84044b726bf979119239353e5373862d738e287d49590e029`；解压后 `0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14` |
| `LICENSE` | lighter-go 仓库的 Apache License 2.0 | — |
| `THIRD_PARTY_LICENSES.txt` | WASM 静态链接的 Go 运行时与依赖模块的许可原文（Go BSD + PATENTS、go-ethereum LGPL-3.0/GPL-3.0、Apache-2.0、BSD、MIT、ISC 等） | — |

worker 加载时先校验解压后的 `wasm_exec.js` 与 WASM 的 SHA-256，任一不一致即拒绝签名；运行 WASM 前删除线程内的 `fetch`、`WebSocket` 等网络全局对象。

依赖版本由上述 lighter-go 提交的 `go.mod` / `go.sum` 固定，均可从各模块路径按版本取得源码；其中 go-ethereum 库部分为 LGPL-3.0，可按下面的重建步骤用修改后的依赖重新链接并替换本目录文件。

## 重建

在 lighter-go 上述提交的源码根目录，用 Go 1.26.10（上游 `justfile` 的 `build-wasm` 目标同参数，工具链版本不同）：

```sh
GOFLAGS= GOWASM= GOEXPERIMENT= CGO_ENABLED=0 GOOS=js GOARCH=wasm go build -mod=readonly -trimpath -buildvcs=false -o ./build/lighter-signer.wasm ./wasm/
```

再用 Brotli（Node `zlib.brotliCompressSync` 即可）压缩为 `lighter-signer.wasm.br`，并更新 worker 中的 `SIGNER_WASM_SHA256` 与上表。升级签名器时同时核对 `SignCreateOrder` / `SignModifyOrder` / `SignCancelOrder` 参数顺序与 `wasm_exec.js` 是否与 Go 版本匹配。改单的 `orderVersion` 在线上 JSON 中编码为 `L2TxAttributes["8"]`，真实离线 WASM 测试核对该字段。
