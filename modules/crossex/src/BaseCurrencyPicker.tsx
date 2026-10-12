import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { matchingBases } from './base-currency';
import './base-currency-picker.css';

export default function BaseCurrencyPicker({ bases, value, onChange }: { bases: readonly string[]; value: string; onChange: (base: string) => void }) {
  const id = useId(), input = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  const matches = useMemo(() => matchingBases(bases, query), [bases, query]);
  const shown = matches.slice(0, 80), highlighted = Math.min(index, shown.length - 1);
  useEffect(() => { if (open) list.current?.children[highlighted]?.scrollIntoView({ block: 'nearest' }); }, [open, highlighted]);
  const expand = () => { setQuery(''); setIndex(0); setOpen(true); };
  const select = (base: string) => { onChange(base); setOpen(false); setQuery(''); };
  return <div className="base-currency-picker">
    <div className="base-currency-input"><Search size={14} aria-hidden="true"/>
      <input ref={input} aria-label="对冲基础币" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={id}
        aria-activedescendant={open && highlighted >= 0 ? `${id}-${highlighted}` : undefined} autoComplete="off" spellCheck={false}
        value={open ? query : value} placeholder={bases.length ? '搜索基础币' : '暂无可选币种'} disabled={!bases.length}
        onFocus={expand} onClick={() => { if (!open) expand(); }} onBlur={() => setOpen(false)} onChange={event => { setQuery(event.target.value); setIndex(0); setOpen(true); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) expand();
            else setIndex(current => Math.max(0, Math.min(shown.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))));
          } else if (event.key === 'Enter' && open) {
            event.preventDefault(); if (highlighted >= 0) select(shown[highlighted]);
          } else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
        }}/>
      <button type="button" aria-label={open ? '收起基础币列表' : '展开基础币列表'} disabled={!bases.length}
        onMouseDown={event => event.preventDefault()} onClick={() => { if (open) setOpen(false); else { input.current?.focus(); expand(); } }}><ChevronDown size={15}/></button>
    </div>
    {open && <div className="base-currency-dropdown"><ul ref={list} id={id} role="listbox" aria-label="基础币搜索结果">
      {shown.map((base, at) => <li id={`${id}-${at}`} key={base} role="option" aria-selected={base === value}
        className={at === highlighted ? 'highlighted' : ''} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setIndex(at)} onClick={() => select(base)}>
        <span>{base}</span>{base === value && <small>已选择</small>}
      </li>)}
    </ul>{!shown.length && <p role="status">没有匹配币种，请修改搜索词</p>}
      {matches.length > shown.length && <p>显示前 {shown.length} 项，输入币种缩小范围</p>}
    </div>}
  </div>;
}
