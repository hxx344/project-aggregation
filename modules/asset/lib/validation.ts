import { z } from 'zod';
export const editSchema=z.object({id:z.string().regex(/^row-\d+$/),quantity:z.number().finite().min(0).max(1e15),price:z.number().finite().min(0).max(1e9).nullable()}).strict();
export const fxSchema=z.object({fx:z.number().finite().gt(0).max(1000)}).strict();
export const connectionSchema=z.discriminatedUnion('exchange',[
  z.object({exchange:z.literal('variational'),vrToken:z.string().trim().min(5).max(4096).regex(/^[A-Za-z0-9._~-]+$/)}).strict(),
  z.object({exchange:z.literal('okx'),apiKey:z.string().trim().min(5).max(256),apiSecret:z.string().trim().min(5).max(256),passphrase:z.string().trim().min(1).max(256)}).strict(),
  z.object({exchange:z.literal('binance'),apiKey:z.string().trim().min(5).max(256),apiSecret:z.string().trim().min(5).max(256)}).strict(),
  z.object({exchange:z.literal('bybit'),apiKey:z.string().min(5).max(256),apiSecret:z.string().min(5).max(256),region:z.enum(['global','nl','tr','kz','ge','ae','eu']).default('global')}).strict(),
  z.object({exchange:z.literal('aster'),walletAddress:z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/),privateKey:z.string().trim().regex(/^(0x)?[0-9a-fA-F]{64}$/),includeSpot:z.boolean().default(false)}).strict(),
]);
export type Credentials=z.infer<typeof connectionSchema>;
export const asterAccountId=z.union([z.literal('default'),z.string().uuid()]);
export const asterAccountSchema=z.object({
  id:asterAccountId,
  name:z.string().trim().min(1).max(40),
  walletAddress:z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/),
  privateKey:z.string().trim().regex(/^(0x)?[0-9a-fA-F]{64}$/),
  includeSpot:z.boolean().default(false),
}).strict();
export const asterAccountDeleteSchema=z.object({id:asterAccountId,action:z.enum(['disconnect','remove'])}).strict();
export type AsterAccountInput=z.infer<typeof asterAccountSchema>;
export const withdrawalIdSchema=z.object({id:z.string().uuid()}).strict();
export const withdrawalSchema=z.object({
  id:z.string().uuid(),
  date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
    const parsed=new Date(value+'T00:00:00Z');
    return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
  }),
  amount:z.number().finite().positive().max(1e12).refine(value=>Number(value.toFixed(2))===value,'金额最多两位小数'),
  note:z.string().trim().max(200).default(''),
}).strict();
export type WithdrawalInput=z.infer<typeof withdrawalSchema>;
export function editValue(quantity:number,price:number|null){
  if(quantity===0) return 0;
  if(price===null) throw new Error('数量大于零时，请填写单价');
  return quantity*price;
}
