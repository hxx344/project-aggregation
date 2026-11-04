// Aero（2026-10-22 Aerodrome 与 Velodrome 合并后的 MetaDEX）各链 CL 部署。
// 地址核对来源：dromos-labs/metadex-slipstream-public deployment-addresses/cl-<chain>.json 与 leaf-<chain>.json，
// 并于 2026-11-03 用各链 RPC 读取 allPoolsLength()、voter.projectedCumulativeRewardShare() 与稳定币 symbol()/decimals() 核实。
// 合并后不再有 Sugar 或 HTTP 池子接口，池子只能从工厂枚举；v2（volatile/stable）池不在本模块范围内。
export const AERO_VOTER = '0x382409fad8503FbCdbB27A4211551fa03e884078';
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
// 新 AERO（Base）。各链排放都以收据代币铸出、1:1 换成 AERO，统一按 Base 上新 AERO 的池子价格计价。
export const AERO_BASE = '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee';

// archive：公共 RPC 是否支持按历史区块读取（决定波动率能否回填；不支持时只用本机按小时累计的样本）。
// stables：按 1 美元锚定的稳定币，只认地址不认 symbol，防止同名代币冒充。
export const AERO_CHAINS = [
  { id: 'base', name: 'Base', chainId: 8453, rpcUrl: 'https://mainnet.base.org', clFactory: '0x9CB220581b91b0C83223012FE69688b92aD07a76', archive: true,
    stables: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'] },
  { id: 'optimism', name: 'Optimism', chainId: 10, rpcUrl: 'https://mainnet.optimism.io', clFactory: '0xfeaB42D90055db3a0616249f76B6002D72266778', archive: true,
    stables: ['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'] },
  { id: 'ethereum', name: 'Ethereum', chainId: 1, rpcUrl: 'https://eth.drpc.org', clFactory: '0xF4Fd2E6c5B60c5b365cd1B96DD6245E6D60414c2', archive: true,
    stables: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0xdAC17F958D2ee523a2206206994597C13D831ec7'] },
  { id: 'arbitrum', name: 'Arbitrum', chainId: 42161, rpcUrl: 'https://arb1.arbitrum.io/rpc', clFactory: '0x88a60ee77392577c355C0acb2A8d476D5a4EC03a', archive: false,
    stables: ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'] },
  { id: 'ink', name: 'Ink', chainId: 57073, rpcUrl: 'https://rpc-gel.inkonchain.com', clFactory: '0x7660BF2aDefC687C22906112ca323d60A00358cF', archive: true,
    stables: ['0x2D270e6886d130D724215A266106e6832161EAEd', '0x0200C29006150606B650577BBE7B6248F58470c1'] },
];

export const chainById = new Map(AERO_CHAINS.map((chain) => [chain.id, chain]));
