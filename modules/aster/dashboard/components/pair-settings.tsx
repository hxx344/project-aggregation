'use client';
import { useId } from 'react';
import { ConfigurationField } from '@/components/configuration-fields';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { Account } from '@/lib/desk-types';
import {
  availablePairAccounts,
  selectPairSymbol,
  type Pair,
  type PairDraft,
} from '@/lib/pairs';
import {
  DEFAULT_PAIR_SYMBOL,
  LEGACY_PAIR_SYMBOLS,
  type PairSymbol,
} from '@/lib/pair-symbols';

export function PairSettings({
  draft,
  setDraft,
  accounts,
  pairs,
  editing,
  locked,
  submit,
  cancel,
  symbols = LEGACY_PAIR_SYMBOLS,
}: {
  draft: PairDraft;
  setDraft: (draft: PairDraft) => void;
  accounts: Account[];
  pairs: Pair[];
  editing: boolean;
  locked: boolean;
  submit: () => Promise<void>;
  cancel: () => void;
  symbols?: readonly PairSymbol[];
}) {
  const formId = useId();
  const field = <K extends keyof PairDraft>(key: K, value: PairDraft[K]) =>
    setDraft({ ...draft, [key]: value });
  const textField = (
    key: Exclude<keyof PairDraft, 'margin_enabled' | 'adl_enabled'>,
  ) => ({
    value: draft[key],
    onValueChange: (value: string) => setDraft({ ...draft, [key]: value }),
  });
  const eligible = availablePairAccounts(
    accounts,
    pairs,
    editing ? draft.id : undefined,
  );
  const long = accounts.find((account) => account.id === draft.long_account_id);
  const short = accounts.find(
    (account) => account.id === draft.short_account_id,
  );
  const symbolConfig = symbols.find((item) => item.symbol === draft.symbol);
  const symbolChoices: [string, string][] = symbols.map((item) => [
    item.symbol,
    item.display_name,
  ]);
  if (editing && !symbolConfig)
    symbolChoices.unshift([draft.symbol, draft.symbol]);
  const choices = (side: 'long' | 'short'): [string, string][] =>
    eligible
      .filter((account) => {
        const other = side === 'long' ? short : long;
        return (
          account.id !== other?.id && (!other || other.mode === account.mode)
        );
      })
      .map((account) => [
        account.id,
        `${account.name} · ${account.mode === 'live' ? '实盘' : '模拟'}`,
      ]);
  return (
    <form
      className="pair-settings-form form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!locked) void submit();
      }}
    >
      <fieldset disabled={locked} className="settings-form-grid">
        <ConfigurationField
          id={`${formId}-pair-name`}
          label="配对组名称"
          type="text"
          maxLength={50}
          {...textField('name')}
          disabled={locked}
        />
        <ConfigurationField
          id={`${formId}-pair-id`}
          label="组标识"
          type="text"
          pattern="[a-z0-9_\-]{1,32}"
          {...textField('id')}
          disabled={locked || editing}
        />
        <ConfigurationField
          id={`${formId}-pair-long`}
          label={draft.mode === 'monitor' ? '子账户 A' : 'A · 只持多仓'}
          items={choices('long')}
          {...textField('long_account_id')}
          display={long?.name}
          disabled={locked || editing}
          placeholder="选择子账户 A"
        />
        <ConfigurationField
          id={`${formId}-pair-short`}
          label={draft.mode === 'monitor' ? '子账户 B' : 'B · 只持空仓'}
          items={choices('short')}
          {...textField('short_account_id')}
          display={short?.name}
          disabled={locked || editing}
          placeholder="选择子账户 B"
        />
        <p className="muted">
          {draft.mode === 'monitor'
            ? 'A 与 B 须属于同一主账户。保证金平衡不限制持仓标的、方向或持仓模式。'
            : 'A 与 B 须属于同一主账户，本组管理方向固定。仅核验交易所 Hedge Mode；其他仓位保留，账户风险一并计入。'}
        </p>
        {draft.mode !== 'monitor' ? (
          <ConfigurationField
            id={`${formId}-pair-symbol`}
            label="交易标的"
            items={symbolChoices}
            value={draft.symbol}
            display={symbolConfig?.display_name ?? draft.symbol}
            disabled={locked || !symbols.length}
            onValueChange={(symbol) => {
              const selected = symbols.find((item) => item.symbol === symbol);
              if (selected)
                setDraft(
                  selectPairSymbol(draft, selected, symbols, {
                    applyDefaults: !editing,
                  }),
                );
            }}
          >
            <small>
              {editing
                ? '暂停后可切换标的；已手动持有的新标的仓位会核对并采纳为底仓，无需先平仓。保存后保持暂停，金额及其他设置保留。'
                : '创建后保持暂停；之后可在设置中切换标的，并核对采纳已手动持有的目标标的仓位。'}
            </small>
          </ConfigurationField>
        ) : null}
        <ConfigurationField
          id={`${formId}-pair-mode`}
          label="组执行模式"
          value={draft.mode}
          display={
            {
              monitor: '保证金管理（不开仓）',
              ordinary: '普通市价共同开仓',
            }[draft.mode]
          }
          disabled={locked}
          onValueChange={(value) => field('mode', value as PairDraft['mode'])}
          items={[
            ['monitor', '保证金管理（不开仓）'],
            ['ordinary', '普通市价共同开仓'],
          ]}
        />
      </fieldset>
      <fieldset disabled={locked} className="settings-form-grid pair-adl-settings">
        <legend>ADL 应急处理</legend>
        <div className="settings-toggle">
          <label htmlFor={`${formId}-pair-adl-enabled`}>ADL 后自动减仓</label>
          <Switch
            id={`${formId}-pair-adl-enabled`}
            checked={draft.adl_enabled}
            disabled={locked}
            onCheckedChange={(enabled) => field('adl_enabled', enabled)}
          />
        </div>
        <ConfigurationField
          id={`${formId}-pair-adl-batch`}
          label="ADL 单批名义金额上限"
          unit="各合约计价币种"
          type="text"
          inputMode="decimal"
          min="1"
          max="1000000"
          maxLength={40}
          {...textField('adl_batch_notional')}
          disabled={locked}
        >
          <small>
            每批按现场标记价折算，实际成交金额随市价变化；不足最小合法一手时停止并提示。
          </small>
        </ConfigurationField>
        <p className="muted">
          监测两账户全部原生合约，包含手工仓位。关闭自动减仓后仍监测、暂停策略并告警，等待手工处理；关闭时不下单或撤单。
          设置保存后生效，事件发生时固定本次配置；处理完成后保持暂停。
        </p>
      </fieldset>
      {draft.mode === 'ordinary' ? (
        <fieldset disabled={locked} className="settings-form-grid">
          <legend>普通开仓</legend>
          <ConfigurationField
            id={`${formId}-pair-threshold`}
            label="公开额度门槛"
            unit="USD1"
            max="1000000000"
            {...textField('threshold')}
            disabled={locked}
          >
            <small>
              当前杠杆的市场公开额度须严格大于此值；两侧账户余量和保证金分别核验。
            </small>
          </ConfigurationField>
          <ConfigurationField
            id={`${formId}-pair-order`}
            label="每侧单批名义金额上限"
            unit="USD1"
            min={symbolConfig?.min_notional ?? DEFAULT_PAIR_SYMBOL.min_notional}
            max="1000000"
            {...textField('order_notional')}
            disabled={locked}
          />
          <ConfigurationField
            id={`${formId}-pair-leverage`}
            label="最低开仓杠杆"
            display={`${draft.min_open_leverage}x`}
            items={[
              ['5', '5x'],
              ['10', '10x'],
              ['20', '20x'],
            ]}
            {...textField('min_open_leverage')}
            disabled={locked}
          >
            <small>
              这是普通新增开仓的最低门槛，不会在保存时修改交易所杠杆。组启用后，程序在更高的
              5x / 10x / 20x
              档位公开额度超过门槛、两侧持仓及账户检查通过时尝试共同升杠杆；确认两侧一致后再检查开仓条件。
            </small>
          </ConfigurationField>
          <ConfigurationField
            id={`${formId}-pair-spread`}
            label="最优买卖价差比例上限"
            max="0.0005"
            {...textField('spread_limit')}
            disabled={locked}
          >
            <small>0.0005 = 0.05% = 5 bp</small>
          </ConfigurationField>
        </fieldset>
      ) : null}
      {draft.mode !== 'monitor' ? (
        <ConfigurationField
          id={`${formId}-pair-margin-limit`}
          label="每侧基础保证金占用上限"
          unit="%"
          max="100"
          {...textField('margin_percent')}
          disabled={locked}
        >
          <small>
            普通 5x 使用基础上限；普通 10x / 20x 额外加 5 个百分点，最高
            100%。
          </small>
        </ConfigurationField>
      ) : null}
      <fieldset disabled={locked} className="settings-form-grid">
        <legend>主账户核验与自动保证金平衡</legend>
        <div className="settings-toggle">
          <label htmlFor={`${formId}-pair-margin-enabled`}>
            启用两侧可用余额平衡
          </label>
          <Switch
            id={`${formId}-pair-margin-enabled`}
            checked={draft.margin_enabled}
            disabled={locked}
            onCheckedChange={(enabled) => field('margin_enabled', enabled)}
          />
        </div>
        <ConfigurationField
          id={`${formId}-pair-master-prefix`}
          label="主账户凭据环境变量前缀"
          type="text"
          required={long?.mode === 'live'}
          placeholder="ASTER_MASTER"
          {...textField('master_env_prefix')}
          disabled={locked}
        >
          <small>
            实盘组必填独立主账户前缀，用于只读核验两子账户的共同归属；开启自动平衡后也用于划转。
          </small>
        </ConfigurationField>
        <ConfigurationField
          id={`${formId}-pair-balance-threshold`}
          label="触发可用余额差额"
          unit="USD1"
          max="1000000000"
          {...textField('balance_threshold')}
          disabled={locked}
        />
        <ConfigurationField
          id={`${formId}-pair-min-transfer`}
          label="最小划转金额"
          unit="USD1"
          min="0.00000001"
          max="1000000000"
          {...textField('min_transfer')}
          disabled={locked}
        />
        <ConfigurationField
          id={`${formId}-pair-max-transfer`}
          label="单次最大划转"
          unit="USD1"
          min="0.00000001"
          max="1000000000"
          {...textField('max_transfer')}
          disabled={locked}
        />
        <ConfigurationField
          id={`${formId}-pair-buffer`}
          label="转出侧现金保留比例"
          unit="%"
          max="100"
          {...textField('buffer_percent')}
          disabled={locked}
        >
          <small>
            转出后保留不少于转出侧正权益 × 此比例的可用余额。
            实际可划金额以交易所返回的额度为准。
          </small>
        </ConfigurationField>
        <ConfigurationField
          id={`${formId}-pair-check`}
          label="平衡检查间隔"
          unit="秒"
          step="1"
          min="1"
          max="3600"
          {...textField('check_interval_seconds')}
          disabled={locked}
        />
        <ConfigurationField
          id={`${formId}-pair-cooldown`}
          label="划转冷却时间"
          unit="秒"
          step="1"
          min="1"
          max="86400"
          {...textField('cooldown_seconds')}
          disabled={locked}
        />
        <p className="muted">
          只填写凭据前缀，密钥由服务器读取。组启用且自动平衡开启后，以两侧 USD1
          可用余额差的一半为平衡目标，遵循交易所可划额度、单次限额和现金保留比例。持仓标的、方向及开仓策略不影响保证金平衡。未知结果重新读取余额并保留原记录，不重复发送。
        </p>
      </fieldset>
      <div className="form-actions">
        <Button type="submit" disabled={locked}>
          {editing ? '保存设置，保持暂停' : '创建配对组，保持暂停'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={cancel}
        >
          撤销修改
        </Button>
      </div>
    </form>
  );
}
