// Base 主网上 Safe、Zodiac Roles v2 与 Aero Slipstream（新工厂）的固定地址。
// 来源与核实记录见 docs/aero-safe-roles-permissions-2026-11-04.md 第 2 节：签名目标与授权对象只取自这里，
// 不从 RPC 或配置文件读取，RPC 被篡改时也不会把权限授给别的合约。
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
