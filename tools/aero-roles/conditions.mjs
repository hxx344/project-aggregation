// Zodiac Roles v2 条件树：构造、按 BFS 展平为 ConditionFlat[]，以及本地求值。
// 编码规则对照 zodiac-modifier-roles-v2 的 Types.sol / Integrity.sol / Topology.sol / PermissionChecker.sol：
// 根节点必须是 Calldata；展平顺序为 BFS 且 parent 单调不减；Or 等逻辑节点的 paramType 为 None，
// 其子树类型必须一致；EqualTo 传原始 ABI 编码值（合约存储时自行取哈希）；Custom 的 compValue 为 20 字节地址 + 12 字节 extra。
import { AbiCoder, concat, getAddress, zeroPadBytes } from 'ethers';
import { ROLES } from './addresses.mjs';

export const AbiType = { None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, Calldata: 5, AbiEncoded: 6 };
export const Operator = { Pass: 0, And: 1, Or: 2, Nor: 3, Matches: 5, EqualToAvatar: 15, EqualTo: 16, Custom: 22, WithinAllowance: 28 };
export const ExecutionOptions = { None: 0, Send: 1, DelegateCall: 2, Both: 3 };

const coder = AbiCoder.defaultAbiCoder();
const MAX_CONDITIONS = 255; // ConditionFlat.parent 是 uint8

export const c = {
  calldata: (...children) => ({ paramType: AbiType.Calldata, operator: Operator.Matches, children }),
  tuple: (...children) => ({ paramType: AbiType.Tuple, operator: Operator.Matches, children }),
  pass: () => ({ paramType: AbiType.Static, operator: Operator.Pass }),
  // 数组只描述元素类型，不约束内容。
  array: (element) => ({ paramType: AbiType.Array, operator: Operator.Pass, children: [element] }),
  avatar: () => ({ paramType: AbiType.Static, operator: Operator.EqualToAvatar }),
  equal: (type, value) => ({ paramType: AbiType.Static, operator: Operator.EqualTo, type, compValue: coder.encode([type], [value]) }),
  address: (value) => c.equal('address', getAddress(value)),
  // 只有一个选项时直接返回该节点，避免多余的 Or 层。
  oneOf: (nodes) => {
    if (nodes.length === 0) throw new Error('oneOf needs at least one option');
    return nodes.length === 1 ? nodes[0] : { paramType: AbiType.None, operator: Operator.Or, children: nodes };
  },
  ownedByAvatar: () => ({ paramType: AbiType.Static, operator: Operator.Custom, compValue: concat([ROLES.avatarIsOwnerOfErc721, zeroPadBytes('0x', 12)]) }),
  allowance: (key) => ({ paramType: AbiType.Static, operator: Operator.WithinAllowance, compValue: key }),
};

// BFS 展平：子节点紧跟在同层之后，parent 取父节点下标；根节点的 parent 指向自身（0）。
export function flatten(root) {
  if (root.paramType !== AbiType.Calldata) throw new Error('root condition must be Calldata');
  const flat = [];
  const queue = [{ node: root, parent: 0 }];
  while (queue.length) {
    const { node, parent } = queue.shift();
    const index = flat.length;
    flat.push({ parent, paramType: node.paramType, operator: node.operator, compValue: node.compValue ?? '0x' });
    for (const child of node.children ?? []) queue.push({ node: child, parent: index });
  }
  if (flat.length > MAX_CONDITIONS) throw new Error(`condition tree has ${flat.length} nodes, Roles allows at most ${MAX_CONDITIONS}`);
  return flat;
}

// 本地求值，作为签名前的第二道防线；与链上 Roles 的语义保持一致，任何不认识的节点都判为不通过。
// ctx：{ avatar, ownerOf(to, tokenId) => Promise<address>, allowance(key) => Promise<bigint>, spent?: Map<key, bigint> }
// allowance 返回链上当前可用额度（已按补充规则折算）；缺失或返回 null 判为不通过。spent 为同批次前面几笔已占用的额度。
// 通过时返回 { ok: true, consumed: [[key, amount]] }，Or 只保留命中分支的消耗，与链上一致。
export async function evaluate(node, value, ctx, to) {
  switch (node.operator) {
    case Operator.Matches: {
      const fields = Array.from(value);
      if (fields.length !== node.children.length) return fail('field count mismatch');
      const spent = new Map(ctx.spent ?? []);
      const consumed = [];
      for (let i = 0; i < fields.length; i++) {
        const result = await evaluate(node.children[i], fields[i], { ...ctx, spent }, to);
        if (!result.ok) return result;
        for (const [key, amount] of result.consumed) { spent.set(key, (spent.get(key) ?? 0n) + amount); consumed.push([key, amount]); }
      }
      return { ok: true, consumed };
    }
    case Operator.Or: {
      const reasons = [];
      for (const child of node.children) {
        const result = await evaluate(child, value, ctx, to);
        if (result.ok) return result;
        reasons.push(result.reason);
      }
      return fail(`no option matched (${reasons.join('; ')})`);
    }
    case Operator.Pass:
      return OK;
    case Operator.EqualToAvatar:
      return same(value, ctx.avatar) ? OK : fail(`${value} is not the Safe`);
    case Operator.EqualTo:
      return coder.encode([node.type], [value]) === node.compValue ? OK : fail(`${value} is not allowed`);
    case Operator.Custom: {
      if (node.compValue.slice(0, 42).toLowerCase() !== ROLES.avatarIsOwnerOfErc721.toLowerCase()) return fail('unknown custom condition');
      const owner = await ctx.ownerOf(to, value);
      return same(owner, ctx.avatar) ? OK : fail(`token ${value} is owned by ${owner}, not the Safe`);
    }
    case Operator.WithinAllowance: {
      const remaining = ctx.allowance ? await ctx.allowance(node.compValue) : null;
      if (remaining == null) return fail('allowance unknown');
      const available = remaining - (ctx.spent?.get(node.compValue) ?? 0n);
      const amount = BigInt(value);
      return amount <= available ? { ok: true, consumed: [[node.compValue, amount]] } : fail(`${value} exceeds remaining allowance ${available}`);
    }
    default:
      return fail(`unsupported operator ${node.operator}`);
  }
}

const OK = Object.freeze({ ok: true, consumed: Object.freeze([]) });
const fail = (reason) => ({ ok: false, reason });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
