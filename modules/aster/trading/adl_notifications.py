"""ADL reports from recorded evidence; callers own delivery and SQL transactions."""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
import json
import math
import time

from .adl_config import validate_adl

CATEGORY = "adl"
MAX_MESSAGE_CHARS = 3000
PHASE_TITLES = {"detected": "已确认", "blocked": "处理受阻", "completed": "补平完成"}


def _map(value):
    return value if isinstance(value, dict) else {}


def _rows(value):
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def _text(value, fallback="未知"):
    if isinstance(value, str):
        return " ".join(value.split()) or fallback
    return str(value) if type(value) in (int, float) else fallback


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = Decimal(str(value))
        return result if result.is_finite() and result >= 0 and abs(result.adjusted()) <= 100 else None
    except (InvalidOperation, ValueError, TypeError):
        return None


def _amount(value):
    number = _number(value)
    if number is None:
        return "未知"
    text = format(number, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _timestamp(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        return "未知"
    try:
        return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="milliseconds")
    except (OverflowError, OSError, ValueError):
        return "未知"


def _symbols(incident):
    configured = incident.get("symbols")
    symbols = [s for s in configured if isinstance(s, str) and s.strip()] if isinstance(configured, list) else []
    symbols += [event.get("symbol") for event in _rows(incident.get("events"))]
    return list(dict.fromkeys(s for s in symbols if isinstance(s, str) and s.strip()))


def _accounts(incident):
    accounts = {}
    for field in ("before", "after"):
        for aid, member in _map(incident.get(field)).items():
            accounts[aid] = _text(_map(member).get("name"), str(aid))
    for field in ("events", "prior_orders", "batches"):
        for row in _rows(incident.get(field)):
            if row.get("account_id"):
                accounts.setdefault(row["account_id"], _text(row.get("account_name"), str(row["account_id"])))
    return accounts


def _quantities(member, symbol):
    member = _map(member)
    positions = member.get("positions")
    if member.get("error") or not isinstance(positions, list):
        return None
    quantities = {}
    for position in positions:
        if not isinstance(position, dict) or not isinstance(position.get("symbol"), str) or not position["symbol"]:
            return None
        if position.get("symbol") != symbol:
            continue
        direction = position.get("direction") or position.get("position_side")
        value = _number(position.get("quantity"))
        if direction not in ("LONG", "SHORT") or direction in quantities or value is None:
            return None
        quantities[direction] = value
    return quantities.get("LONG", Decimal(0)), quantities.get("SHORT", Decimal(0))


def _holdings(incident, field, symbols, accounts):
    lines = ["处理前现场：" if field == "before" else "处理后现场："]
    snapshots = _map(incident.get(field))
    if not symbols or not accounts:
        return lines + ["两账户持仓未知；残差待核实。"]
    for symbol in symbols:
        values = []
        for aid, name in accounts.items():
            quantities = _quantities(snapshots.get(aid), symbol)
            values.append(quantities)
            long, short = quantities if quantities is not None else (None, None)
            lines.append(f"账户「{name}」({aid}) {symbol}：多仓 {_amount(long)}；空仓 {_amount(short)}")
        label = "最终残差" if field == "after" else "现场残差"
        if len(values) != 2 or any(value is None for value in values):
            lines.append(f"{symbol} {label}：未知（缺少两账户完整持仓）")
            continue
        with localcontext() as context:
            context.prec = 256
            long, short = (sum(value[side] for value in values) for side in (0, 1))
            difference = abs(long - short)
        direction = "多仓多余" if long > short else "空仓多余" if short > long else "多空相等"
        lines.append(f"{symbol} 合计多仓 {_amount(long)}；合计空仓 {_amount(short)}；"
                     f"{label}：{_amount(difference)}（{direction}）")
    return lines


def _event_lines(incident):
    lines = ["ADL 原订单（每个订单的累计减仓，不重复累加）："]
    events = _rows(incident.get("events"))
    if not events:
        return lines + ["原订单证据未知。"]
    for event in events:
        name = _text(event.get("account_name"), _text(event.get("account_id")))
        lines.append(f"账户「{name}」 {_text(event.get('symbol'))} {_text(event.get('position_side'))} "
                     f"{_text(event.get('side'))}；原订单号 {_text(event.get('order_id'))}；"
                     f"状态 {_text(event.get('status'))}")
        lines.append(f"累计减仓：{_amount(event.get('executed_qty'))}；原委托数量："
                     f"{_amount(event.get('original_qty'))}；成交均价：{_amount(event.get('avg_price'))}")
        lines.append(f"来源：{_text(event.get('source'))}；来源时间（UTC）：{_timestamp(event.get('event_at'))}；"
                     f"订单时间（UTC）：{_timestamp(event.get('order_at'))}")
    return lines


def _receipt_lines(item):
    receipt = _map(item.get("receipt"))
    if item.get("resolution") == "positions_verified_unknown":
        lines = ["回报状态：仍未知；累计成交：未知；成交均价：未知",
                 "处置：已按两账户新鲜完整持仓核验后继续处理；原订单最终成交结果仍待确认。",
                 "现场核验时间（UTC）：" + _timestamp(item.get("resolved_at"))]
        known = _number(receipt.get("executedQty"))
        if known is not None and known > 0:
            lines.append(f"最后可核实累计成交（非最终）：{_amount(known)}；"
                         f"当时成交均价：{_amount(receipt.get('avgPrice'))}")
    else:
        lines = [f"回报状态：{_text(receipt.get('status'), '未知，待核对')}；"
                 f"累计成交：{_amount(receipt.get('executedQty'))}；"
                 f"成交均价：{_amount(receipt.get('avgPrice'))}"]
    if item.get("error"):
        lines.append("异常：" + _text(item["error"]))
    return lines


def _prior_order_lines(incident, accounts):
    orders = _rows(incident.get("prior_orders"))
    if not orders:
        return []
    lines = ["原策略未决订单核对记录："]
    for index, item in enumerate(orders, 1):
        order, receipt = _map(item.get("order")), _map(item.get("receipt"))
        aid = item.get("account_id")
        name = _text(item.get("account_name"), accounts.get(aid, _text(aid)))
        lines.append(f"原未决订单 {index}：账户「{name}」({_text(aid)}) {_text(order.get('symbol'))} "
                     f"{_text(order.get('positionSide'))} {_text(order.get('side'))}；"
                     f"委托数量 {_amount(order.get('quantity'))}")
        lines.append(f"发送时间（UTC）：{_timestamp(item.get('sent_at'))}；"
                     f"客户端编号：{_text(order.get('newClientOrderId'))}；"
                     f"交易所订单号：{_text(receipt.get('orderId'))}")
        lines += _receipt_lines(item)
    return lines


def _batch_lines(incident):
    lines = ["自动分批减仓记录："]
    batches = _rows(incident.get("batches"))
    if not batches:
        return lines + ["尚无补平委托记录。"]
    for index, batch in enumerate(batches, 1):
        order, receipt = _map(batch.get("order")), _map(batch.get("receipt"))
        name = _text(batch.get("account_name"), _text(batch.get("account_id")))
        lines.append(f"第 {index} 批：账户「{name}」 {_text(order.get('symbol'))} "
                     f"{_text(order.get('positionSide'))} {_text(order.get('side'))}；"
                     f"委托数量 {_amount(order.get('quantity'))}")
        lines.append(f"发送时间（UTC）：{_timestamp(batch.get('sent_at'))}；"
                     f"客户端编号：{_text(order.get('newClientOrderId'))}；"
                     f"交易所订单号：{_text(receipt.get('orderId'))}")
        lines += _receipt_lines(batch)
    return lines


def _duration(incident, phase):
    start = _number(incident.get("created_at"))
    end = _number(incident.get("completed_at"))
    final = end is not None
    if not final and phase != "completed":
        end = _number(incident.get("reported_at", incident.get("updated_at")))
    if start is None or end is None or end < start:
        return "耗时：未知（缺少有效起止时间）"
    return f"耗时：{end - start:.3f} 秒" + ("" if final else "（截至报告生成）")


def _chunks(lines, budget):
    chunks, current = [], ""
    for line in lines:
        if current and len(current) + len(line) + 1 > budget:
            chunks.append(current)
            current = ""
        while len(line) > budget:
            chunks.append(line[:budget])
            line = line[budget:]
        if line:
            current += ("\n" if current else "") + line
    if current:
        chunks.append(current)
    return chunks


def format_messages(incident, phase, reason=None):
    """Format complete recorded evidence without reading trading or network state."""
    if phase not in PHASE_TITLES:
        raise ValueError("Unsupported ADL notification phase")
    title = "ASTER ADL " + PHASE_TITLES[phase]
    config = validate_adl(incident.get("config"))
    symbols, accounts = _symbols(incident), _accounts(incident)
    lines = [f"事件：{_text(incident.get('id'))}；配对组「{_text(incident.get('pair_name'))}」"
             f"({_text(incident.get('pair_id'))})",
             f"开始时间（UTC）：{_timestamp(incident.get('created_at'))}",
             f"本次自动减仓：{'开启' if config['enabled'] else '关闭'}；"
             f"单批名义金额上限：{config['batch_notional']}（合约计价币，按现场标记价计算）"]
    if incident.get("parent_id"):
        lines.append("关联前次事件：" + _text(incident["parent_id"]))
    if phase == "detected":
        lines.append("已确认交易所 ADL 自动减仓；核对现场后，将按实际多空残差分批减去多余持仓。"
                     if config["enabled"] else
                     "已确认交易所 ADL 自动减仓；本次自动减仓已关闭，策略保持暂停，仅核实持仓并等待手工平衡。")
    elif phase == "blocked":
        lines.append("自动分批减仓受阻；失败或结果未知的批次需核对。" if config["enabled"] else
                     "本次自动减仓已关闭；仅核实持仓和原订单，不自动下单或撤单，等待手工平衡。")
    else:
        lines.append(f"完成时间（UTC）：{_timestamp(incident.get('completed_at'))}")
        orders = _rows(incident.get("prior_orders")) + _rows(incident.get("batches"))
        if any(item.get("resolution") == "positions_verified_unknown"
               or _map(item.get("receipt")).get("status") not in ("FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED")
               for item in orders):
            lines.append("已按当前实际仓位平衡；原单成交结果仍未知。策略保持暂停，并继续观察迟到成交引起的持仓变化。")
    explanation = reason if reason is not None else incident.get("reason")
    if explanation:
        lines.append("说明：" + _text(explanation))
    lines += _event_lines(incident)
    lines += _holdings(incident, "before", symbols, accounts)
    lines += _prior_order_lines(incident, accounts)
    lines += _batch_lines(incident)
    if phase != "detected" or incident.get("after") is not None:
        lines += _holdings(incident, "after", symbols, accounts)
    lines += [_duration(incident, phase), "策略状态：" + _text(incident.get("strategy_status"), "保持暂停"),
              "手续费及已实现盈亏：未提供原始成交明细，未计算。"]
    chunks = _chunks(lines, MAX_MESSAGE_CHARS - len(title) - 40)
    return [f"{title}（第 {index}/{len(chunks)} 段）\n{body}" for index, body in enumerate(chunks, 1)]


def enqueue(db, incident, phase, *, now=None, reason=None):
    """Insert stable report parts in the caller's transaction; never commit/send."""
    identity = incident.get("id")
    if not isinstance(identity, str) or not identity:
        raise ValueError("ADL incident requires a stable ID")
    if phase not in PHASE_TITLES:
        raise ValueError("Unsupported ADL notification phase")
    now = time.time() if now is None else now
    if type(now) not in (int, float) or not math.isfinite(now) or now < 0:
        raise ValueError("Invalid ADL notification time")
    version = ":" + _text(incident.get("notice_version", 0)) if phase == "blocked" else ""
    prefix = f"adl:{identity}:{phase}{version}:"
    existing = [row[0] for row in db.execute("SELECT id FROM outbox WHERE id>=? AND id<? ORDER BY id",
                                            (prefix, prefix + "\uffff"))]
    if existing:
        # A phase is one immutable report, including its original part count.
        # Retrying enqueue must not append different extra parts to that report.
        return existing
    messages = format_messages({**incident, "reported_at": now}, phase, reason)
    symbols = json.dumps(_symbols(incident), ensure_ascii=False, separators=(",", ":"))
    identities = []
    for part, message in enumerate(messages, 1):
        item_id = f"{prefix}{part:04d}"
        db.execute("INSERT OR IGNORE INTO outbox(id,message,due_at,category,symbols) VALUES (?,?,?,?,?)",
                   (item_id, message, now, CATEGORY, symbols))
        identities.append(item_id)
    return identities
