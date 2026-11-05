// Base 主网上 Safe、Zodiac Roles v2 与 Aero Slipstream（新工厂）的固定地址。
// 来源与核实记录见 docs/aero-safe-roles-permissions-2026-11-04.md 第 2 节。协议合约（NPM、Router、Roles、MultiSend）只取自这里；
// gauge 与代币地址来自配置，plan 靠 RPC 读回的字节码与关联读数判断真伪，所以 plan 必须用可信 RPC。
export const BASE_CHAIN_ID = 8453;

// Safe{Wallet} 目前在 Base 上新建的是 v1.5.0（L2），不能选旧版本；地址为 safe-deployments v1.5.0 规范部署。
export const SAFE = {
  version: '1.5.0',
  singletonL2: '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
  proxyFactory: '0x14F2982D601c9458F93bd70B218933A6f8165e7b',
  multiSendCallOnly: '0xA83c336B20401Af773B6219BA5027174338D1836',
  fallbackHandler: '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4',
};

export const ROLES = {
  mastercopy: '0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5',
  moduleProxyFactory: '0x000000000000aDdB49795b0f9bA5BC298cDda236',
  multiSendUnwrapper: '0xB4Cd4bb764C089f20DA18700CE8bc5e49F369efD',
  avatarIsOwnerOfErc721: '0x91B1bd7BCC5E623d5CE76b0152253499a9C819d1',
};

export const AERO = {
  clFactory: '0x9CB220581b91b0C83223012FE69688b92aD07a76',
  nft: '0x4857DB576eE0e45F10525eC59527BfD10beeC60b',
  swapRouter: '0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418',
  voter: '0x382409fad8503FbCdbB27A4211551fa03e884078',
  gaugeFactory: '0xf437f62053ACB121665b8fDBfeA8F214FB8E589d',
  gaugeImplementation: '0x89E91A960154b1ed6c093039a8F0725ab67D14E0',
};

export const MULTISEND_SELECTOR = '0x8d80ff0a';

// 运行时字节码哈希：2026-11-04 由 mainnet.base.org 与 base-rpc.publicnode.com 分别读取，结果一致；Safe 三项另与 safe-deployments 记录的 codeHash 一致。plan 逐个核对。
// ProxyFactory 不在此列（plan 不经过工厂，代理本身由 SAFE_PROXY_CODEHASH 核对）；其 codehash 0x967dae4c…4529 仅人工核对过。
// 均非可升级代理，钉的是不可变代码；不覆盖治理可改参数，代币（USDC 为可升级代理）不在此列（文档第 2 节）。
export const CODEHASH = {
  [SAFE.singletonL2]: '0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc',
  [SAFE.multiSendCallOnly]: '0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663',
  [SAFE.fallbackHandler]: '0x3c6a85bcf7b563daa624b884b4e9a1b9fa5371edde7be945d998071a48f28bbc',
  [ROLES.mastercopy]: '0x471d8b3b419f1eb955230c0326c8812176df49bf3c7b414a563fda5a3c6c10b6',
  [ROLES.moduleProxyFactory]: '0x01623cbcf010a1c326230f1b2d5f48a66b440232ee49096102bc84967dc5f21e',
  [ROLES.multiSendUnwrapper]: '0x1f6e088be5e6ef9d0fbe0547d3fa9a9e40d823433fd8a4449215b5663209a1eb',
  [ROLES.avatarIsOwnerOfErc721]: '0x0ddd815113052bfe0318baabf72fccd8edad78181cb484e4879a7e3c7bab36f6',
  [AERO.nft]: '0xb2d0d8278354542651e2db288b71292635d9fd7bd28784f736373da801974599',
  [AERO.swapRouter]: '0x5edc4df75bb36d8911c289163797022bb8d0d834a163f5a854a7834d62e215c6',
  [AERO.clFactory]: '0x6c09090837ace0aefe6bfa24a3bc772d13a9775b7e3109c9fece534a0ce053a6',
  [AERO.voter]: '0x363145d181429cc6f7b7c55a7b332fedb5a06b44da5371acee8a94d34d140f35',
  [AERO.gaugeImplementation]: '0xfdb516e0cf5b1c3f42789c4d7607a16e16b0ae5e73894e21e52a29c93b1ecee3',
};

// SafeProxy 1.5.0 的运行时代码与 singleton 无关（singleton 存在槽 0），所有 Safe 相同；123 字节。
// 由 proxyFactory.proxyCreationCode() + singleton 参数做一次创建 eth_call 取得，两个 RPC 结果一致，与 Safe{Wallet} 实际建出的 Safe 相同。
export const SAFE_PROXY_CODEHASH = '0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f';
