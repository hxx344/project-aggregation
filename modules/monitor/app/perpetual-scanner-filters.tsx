import type { ScannerRangeId, ScannerRangeInputs, CompiledScannerRanges } from "../lib/perpetual-scanner-filters";

const groups: { title: string; help: string; rows: { id: ScannerRangeId; label: string; accessible: string }[] }[] = [
  { title: "成交额（美元）", help: "两腿各自过去 24 小时的成交金额。非 USD 数据按实时汇率中间价折算，仅用于筛选；表格保留原计价币。", rows: [
    { id: "longVolume", label: "多头", accessible: "多头成交额" }, { id: "shortVolume", label: "空头", accessible: "空头成交额" },
  ] },
  { title: "持仓量（美元）", help: "两腿各自未平仓合约的名义金额，按实时汇率中间价折算为 USD。缺失或过期数据不参与该项筛选。", rows: [
    { id: "longOpenInterest", label: "多头", accessible: "多头持仓量" }, { id: "shortOpenInterest", label: "空头", accessible: "空头持仓量" },
  ] },
  { title: "价差（%）", help: "开仓价差使用当前报价口径的毛价差；资金费率为空腿减多腿，统一折算为 8 小时；资金费年化按当前费差简单外推。均可输入负数。", rows: [
    { id: "spread", label: "开仓价格", accessible: "开仓价差" }, { id: "fundingSpread", label: "资金费率", accessible: "资金费差" }, { id: "annualized", label: "资金费年化", accessible: "资金费年化" },
  ] },
  { title: "已实现资金费（%）", help: "过去 24 小时、7 天、30 天的已结算净资金费，按两腿共同截止时间计算。正值收款、负值付款；历史不足或过期时不参与该项筛选。", rows: [
    { id: "history24h", label: "24小时", accessible: "24小时实际资金费" }, { id: "history7d", label: "7天", accessible: "7天实际资金费" }, { id: "history30d", label: "30天", accessible: "30天实际资金费" },
  ] },
];

export function ScannerRangeFilters({ inputs, compiled, onChange, onClear, onClose }: {
  inputs: ScannerRangeInputs;
  compiled: CompiledScannerRanges;
  onChange: (id: ScannerRangeId, bound: "min" | "max", value: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return <section id="perpetual-filters" className="scanner-range-panel" aria-label="套利组合范围筛选" onKeyDown={event => {
    if (event.key === "Escape") onClose();
  }}>
    <div className="scanner-range-groups">{groups.map(group => <fieldset key={group.title}>
      <legend><span>{group.title}</span><details className="scanner-range-help" name="scanner-range-help">
        <summary aria-label={`${group.title}说明`}>?</summary><p>{group.help}</p>
      </details></legend>
      <div className="scanner-range-rows">{group.rows.map(row => <div key={row.id} className="scanner-range-row" data-range={row.id}>
        <span className="scanner-range-label" aria-hidden="true">{row.label}</span>
        {(["min", "max"] as const).map(bound => <input key={bound} name={`scanner-${row.id}-${bound}`} type="text" inputMode="text" autoComplete="off" spellCheck={false} maxLength={32}
          aria-label={`${row.accessible}${bound === "min" ? "最小值" : "最大值"}`} placeholder={bound === "min" ? "最小" : "最大"}
          aria-invalid={Boolean(compiled.errors[row.id])} aria-describedby={compiled.errors[row.id] ? `scanner-range-error-${row.id}` : undefined}
          value={inputs[row.id][bound]} onChange={event => onChange(row.id, bound, event.target.value)}/>)}
        {compiled.errors[row.id] ? <small id={`scanner-range-error-${row.id}`} className="scanner-range-error">{compiled.errors[row.id]}</small> : null}
      </div>)}</div>
    </fieldset>)}</div>
    <div className="scanner-range-footer"><div className="scanner-range-notes"><p>金额支持 K / M / B · 留空不限 · 筛选全部组合</p>
      {compiled.needsFx ? <small>金额按实时汇率折算 USD；缺失、过期或尚未采集的数据暂不匹配。</small> : null}
    </div><div className="scanner-range-actions"><button type="button" onClick={onClear}>全部清除</button><button type="button" className="scanner-range-close" onClick={onClose}>收起</button></div></div>
  </section>;
}
