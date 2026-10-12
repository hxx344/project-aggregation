import { join } from "node:path";
import { openStore } from "./alert-store.mjs";
import { createAlertService } from "./alert-service.mjs";
import { FileStore, activateBinanceSource } from "./oil/store.mjs";
import { Monitor } from "./oil/monitor.mjs";
import { openNotificationStore } from "./notification-store.mjs";
import { createNotificationService } from "./notification-service.mjs";
import { openMarketStore } from "./market-store.mjs";
import { createMarketCollector, marketJobs, seedMarketDatabase } from "./market-collector.mjs";
import { comparisonExchanges, exchangeAction, exchangeFromAction, EXCHANGE_REFRESH_MS } from "../lib/exchange-quotes.ts";
import { OIL_CANDLE_ACTION, OIL_CANDLE_REFRESH_MS } from "../modules/oil/intraday.mjs";
import { openPerpetualStore } from './perpetual-store.mjs';
import { createPerpetualService } from './perpetual-service.mjs';
import { createFundamentalsClient } from './perpetual-fundamentals.mjs';
import { openPerpetualAlertStore } from './perpetual-alert-store.mjs';
import { openCrossExSettingsStore } from './perpetual-crossex-store.mjs';
import { openPerpetualPaperStore } from './perpetual-paper-store.mjs';
import { openMonitorControlStore, attachMonitorControl } from './monitor-control.mjs';
import { GOLD_OIL_QUOTE_MS, GOLD_OIL_HISTORY_MS, GOLD_OIL_FUNDING_MS, GOLD_OIL_VARIANTS, GOLD_OIL_EXCHANGES, goldOilVariantKey, goldOilAction, parseGoldOilAction } from '../lib/gold-oil.ts';
import { goldOilAlertDefaults, validateGoldOilAlerts, createGoldOilAlertDefinition, confirmGoldOilTriggers } from './gold-oil/alerts.mjs';
import { exchangeFundingAction, fundingExchangeFromAction } from '../lib/exchange-funding-history.ts';
import { OIL_HEDGE_PRICES_ACTION, HEDGE_PRICES_REFRESH_MS } from '../lib/oil-hedge-prices.ts';
import { createVariationalSession, openVariationalSessionStore } from './variational-session.mjs';
import { fetchVariational } from './variational-transport.mjs';

const exchangeActions = market => Object.fromEntries(comparisonExchanges(market).map(exchange => [exchangeAction(exchange), ["GET"]]));
const exchangeFundingActions = Object.fromEntries(comparisonExchanges('oil').map(exchange => [exchangeFundingAction(exchange), ['GET']]));

/** Runtime adapters own their schedule, storage and API. They share one HTTP server. */
export async function createMonitorServices(directory, { externallyLocked = false, env = process.env, notificationOptions, hynixOptions, oilOptions, goldOilOptions, marketOptions, perpetualOptions, variationalSessionOptions } = {}) {
  const oilStore = new FileStore(join(directory, "oil"), externallyLocked);
  const goldOilStores = Object.fromEntries(GOLD_OIL_VARIANTS.map(({ oilType, exchange }) => [goldOilVariantKey(oilType, exchange), new FileStore(join(directory, 'cl-xau', ...(exchange === 'bybit' ? ['bybit'] : []), ...(oilType === 'bz' ? ['bz'] : [])), externallyLocked, { defaults: goldOilAlertDefaults, validate: input => validateGoldOilAlerts(input, oilType, exchange), marketSource: exchange })]));
  await oilStore.acquire();
  let marketStore, perpetualStore;
  try {
    for (const store of Object.values(goldOilStores)) await store.acquire();
    const controlStore = await openMonitorControlStore(directory);
    const pollSeconds = Number(env.OIL_POLL_INTERVAL_SECONDS || 30);
    if (!Number.isInteger(pollSeconds) || pollSeconds < 10 || pollSeconds > 3600) throw new Error("OIL_POLL_INTERVAL_SECONDS 必须为 10–3600 的整数");
    marketStore = await openMarketStore(join(directory, "market.sqlite"));
    seedMarketDatabase(marketStore);
    const variationalSession = createVariationalSession(await openVariationalSessionStore(directory), { fetcher: fetchVariational, ...variationalSessionOptions });
    let hynixRunning = false, oilRunning = false, goldOilRunning = false;
    const collector = createMarketCollector(marketStore, { jobs: marketJobs({ oilIntervalMs: pollSeconds * 1000, variationalSession, variationalFetcher: fetchVariational }), ...marketOptions,
      onStored(job) {
        if (job.id === 'cl-xau' && goldOilRunning) { const parsed = parseGoldOilAction(job.action); if (parsed?.action === 'quote') return goldOils[goldOilVariantKey(parsed.oilType, parsed.exchange)].tick(); }
        if (job.action === 'quote') { if (job.id === 'hynix' && hynixRunning) return hynix.check(); if (job.id === 'oil' && oilRunning) return oil.tick(); }
      },
    });
    const read = (id, action, fresh = false) => {
      if (fresh && !collector.healthy()) throw new Error("行情数据库写入失败，暂停告警。");
      const goldAction = id === 'cl-xau' ? parseGoldOilAction(action)?.action : null;
      const interval = goldAction ? goldAction === 'quote' ? GOLD_OIL_QUOTE_MS : goldAction === 'funding' ? GOLD_OIL_FUNDING_MS : GOLD_OIL_HISTORY_MS : action === OIL_HEDGE_PRICES_ACTION ? HEDGE_PRICES_REFRESH_MS : action === OIL_CANDLE_ACTION ? OIL_CANDLE_REFRESH_MS : exchangeFromAction(action) ? EXCHANGE_REFRESH_MS : action === "quote" ? id === "oil" ? pollSeconds * 1000 : 10_000 : action === "history" && id === "hynix" ? 60_000 : 300_000;
      const value = marketStore.read(id, action, { fresh, maxAgeMs: interval * 2 + 15_000 });
      return collector.healthy() ? value : { ...value, status: "snapshot", collection: { ...value.collection, stale: true, error: "行情数据库写入失败，保留已保存数据。" } };
    };
    const hynixStore = await openStore(join(directory, "hynix"));
    const notificationStore = await openNotificationStore(directory, () => [
      { id: "hynix", ...hynixStore.get().config },
      { id: "oil", webhookUrl: env.OIL_FEISHU_WEBHOOK_URL || "", signingSecret: env.OIL_FEISHU_WEBHOOK_SECRET || "" },
    ]);
    const notifications = createNotificationService(notificationStore, notificationOptions);
    const hynix = createAlertService(hynixStore, { getQuote: async () => read("hynix", "quote", true), ...hynixOptions, notifications });
    const previousOil = await oilStore.read(), oilData = activateBinanceSource(previousOil);
    if (oilData !== previousOil) await oilStore.write(oilData);
    const oil = new Monitor({ store: oilStore, data: oilData, fetchMarket: async () => read("oil", "quote", true), pollSeconds, ...oilOptions, notify: notifications.send, webhookConfigured: notifications.configured });
    const goldOils = {};
    for (const { oilType, exchange } of GOLD_OIL_VARIANTS) {
      const key = goldOilVariantKey(oilType, exchange), store = goldOilStores[key], quoteAction = goldOilAction('quote', oilType, exchange);
      const monitor = new Monitor({ store, data: await store.read(), fetchMarket: async () => read('cl-xau', quoteAction, true), pollSeconds: GOLD_OIL_QUOTE_MS / 1000, ...goldOilOptions,
        definition: createGoldOilAlertDefinition(oilType, exchange), notify: notifications.send, webhookConfigured: notifications.configured,
        canRun: () => goldOilRunning && controlStore.get().monitors['cl-xau'].enabled,
        beforeSend: (_market, due) => confirmGoldOilTriggers(read('cl-xau', quoteAction, true), due, monitor.clock(), oilType, exchange),
      });
      goldOils[key] = monitor;
    }
    let coinIds = {};
    if (env.PERPETUAL_COIN_IDS) {
      try {
        coinIds = JSON.parse(env.PERPETUAL_COIN_IDS);
        if (!coinIds || typeof coinIds !== 'object' || Array.isArray(coinIds) || Object.keys(coinIds).length > 2000 || Object.entries(coinIds).some(([base, id]) => !/^[A-Z0-9._-]{1,40}$/.test(base) || typeof id !== 'string' || !/^[a-z0-9-]{1,120}$/.test(id))) throw new Error();
      } catch { throw new Error('PERPETUAL_COIN_IDS 必须为币种到 CoinGecko ID 的 JSON 对象'); }
    }
    async function createPerpetual() {
      const store = await openPerpetualStore(join(directory, 'perpetual', 'market.sqlite'));
      try {
        const perpetualAlertStore = await openPerpetualAlertStore(join(directory, 'perpetual'));
        let perpetualPaperStore, paperUnavailableReason = '';
        try { perpetualPaperStore = await openPerpetualPaperStore(join(directory, 'perpetual')); }
        catch { paperUnavailableReason = '持仓记录无法读取，请修复或恢复 paper-positions.json；行情监控继续运行。'; }
        const crossexStore = await openCrossExSettingsStore(join(directory, 'perpetual'));
        const service = createPerpetualService({ store, crossexOptions: { store: crossexStore }, notifications, alertOptions: { store: perpetualAlertStore }, paperOptions: { store: perpetualPaperStore, unavailableReason: paperUnavailableReason }, qualityOptions: { fundamentals: createFundamentalsClient({ coinIds, apiKey: env.COINGECKO_DEMO_API_KEY || '' }) }, ...perpetualOptions });
        perpetualStore = store;
        return service;
      } catch (error) { store.close(); throw error; }
    }
    const perpetual = await createPerpetual();
    const services = new Map([
      ['cl-xau', {
        start() { goldOilRunning = true; for (const monitor of Object.values(goldOils)) monitor.start(); },
        async stop() { goldOilRunning = false; await Promise.all(Object.values(goldOils).map(monitor => monitor.stop())); },
        healthy: () => collector.healthy() && Object.values(goldOils).every(monitor => !monitor.storageError),
        actions: Object.fromEntries(GOLD_OIL_VARIANTS.flatMap(({ oilType, exchange }) => ['quote', 'history', 'funding', 'status', 'config', 'events'].map(action => [goldOilAction(action, oilType, exchange), action === 'config' ? ['GET', 'PUT'] : ['GET']]))),
        async handle(action, method, input) {
          const parsed = parseGoldOilAction(action);
          if (!parsed) throw Object.assign(Error('模块不支持此接口'), { status: 404 });
          const monitor = goldOils[goldOilVariantKey(parsed.oilType, parsed.exchange)], identity = { oilType: parsed.oilType, exchange: parsed.exchange, source: GOLD_OIL_EXCHANGES[parsed.exchange].name };
          if (method === 'GET' && ['quote', 'history', 'funding'].includes(parsed.action)) return read('cl-xau', action);
          if (parsed.action === 'status' && method === 'GET') return { ...monitor.status(), available: true, monitorId: 'cl-xau', ...identity };
          if (parsed.action === 'config' && method === 'GET') return { ...monitor.configuration(), ...identity };
          if (parsed.action === 'events' && method === 'GET') return { ...identity, events: structuredClone(monitor.data.events) };
          if (parsed.action === 'config' && method === 'PUT') {
            if (!Number.isSafeInteger(input?.revision) || input.revision < 0) throw Error('缺少有效配置版本号');
            return { ...await monitor.configure(input.config, input.revision), ...identity };
          }
        },
      }],
      ['perpetual', perpetual],
      ["hynix", {
        start() { hynixRunning = true; hynix.start(); }, stop() { hynixRunning = false; return hynix.stop(); }, healthy: () => hynix.healthy(),
        async handle(action, method, input) {
          if ((["quote", "history", "funding"].includes(action) || exchangeFromAction(action)) && method === "GET") return read("hynix", action);
          if (action === "alerts" && method === "GET") return hynix.view();
          if (action === "alerts" && method === "PUT") return hynix.update(input);
          if (action === "alerts/test" && method === "POST") return hynix.test();
        },
        actions: { quote: ["GET"], history: ["GET"], funding: ["GET"], ...exchangeActions('hynix'), alerts: ["GET", "PUT"], "alerts/test": ["POST"] },
      }],
      ["oil", {
        start() { oilRunning = true; oil.start(); }, healthy: () => !oil.storageError, async stop() { oilRunning = false; await Promise.all([oil.stop(), variationalSession.stop()]); },
        async handle(action, method, input) {
          if (action === 'exchanges/variational/session') return method === 'PUT' ? variationalSession.update(input) : variationalSession.view();
          if (action === "status" && method === "GET") return { ...oil.status(), available: true, monitorId: "oil" };
          if ((action === OIL_CANDLE_ACTION || action === OIL_HEDGE_PRICES_ACTION) && method === "GET") return read("oil", action);
          if ((["quote", "history", "funding"].includes(action) || exchangeFromAction(action) || fundingExchangeFromAction(action)) && method === "GET") return read("oil", action);
          if (action === "config" && method === "GET") return oil.configuration();
          if (action === "events" && method === "GET") return { events: oil.data.events };
          if (action === "config" && method === "PUT") {
            if (!Number.isSafeInteger(input?.revision)) throw new Error("缺少配置版本号");
            return oil.configure(input.config, input.revision);
          }
          if (action === "test-notification" && method === "POST") { await notifications.test(); return { ok: true }; }
        },
        actions: { quote: ["GET"], history: ["GET"], funding: ["GET"], 'exchanges/variational/session': ['GET', 'PUT'], [OIL_CANDLE_ACTION]: ["GET"], [OIL_HEDGE_PRICES_ACTION]: ["GET"], ...exchangeActions('oil'), ...exchangeFundingActions, status: ["GET"], config: ["GET", "PUT"], events: ["GET"], "test-notification": ["POST"] },
      }],
    ]);
    services.notifications = notifications;
    services.market = { start: () => collector.start(), healthy: () => collector.healthy(), status: () => marketStore.status(), async stop() { await collector.stop(); marketStore.close(); for (const store of Object.values(goldOilStores)) await store.release(); await oilStore.release(); } };
    return attachMonitorControl(services, controlStore, { collector, factories: { perpetual: createPerpetual } });
  } catch (error) { perpetualStore?.close(); marketStore?.close(); for (const store of Object.values(goldOilStores)) await store.release(); await oilStore.release(); throw error; }
}
