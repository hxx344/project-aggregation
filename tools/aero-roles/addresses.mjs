// Base 主网上 Safe、Zodiac Roles v2 与 Aero Slipstream（新工厂）的固定地址。
// 来源与核实记录见 docs/aero-safe-roles-permissions-2026-11-04.md 第 2 节。协议合约（NPM、Router、Roles、MultiSend）只取自这里；
// gauge 与代币地址来自配置，plan 靠 RPC 读回的字节码与关联读数判断真伪，所以 plan 必须用可信 RPC。
export const BASE_CHAIN_ID = 8453;

export const SAFE = {
  singletonL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  multiSendCallOnly: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
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

// 运行时字节码哈希：2026-11-04 由 mainnet.base.org 与 base-rpc.publicnode.com 分别读取，结果一致。plan 逐个核对。
export const CODEHASH = {
  [SAFE.singletonL2]: '0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff',
  [SAFE.multiSendCallOnly]: '0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939',
  [SAFE.fallbackHandler]: '0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9',
  [ROLES.mastercopy]: '0x471d8b3b419f1eb955230c0326c8812176df49bf3c7b414a563fda5a3c6c10b6',
  [ROLES.moduleProxyFactory]: '0x01623cbcf010a1c326230f1b2d5f48a66b440232ee49096102bc84967dc5f21e',
  [ROLES.multiSendUnwrapper]: '0x1f6e088be5e6ef9d0fbe0547d3fa9a9e40d823433fd8a4449215b5663209a1eb',
  [ROLES.avatarIsOwnerOfErc721]: '0x0ddd815113052bfe0318baabf72fccd8edad78181cb484e4879a7e3c7bab36f6',
};
