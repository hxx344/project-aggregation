import { test } from "node:test";
import assert from "node:assert/strict";
import { alignCandles, selectRange, dailyPoints, retainHistoryPoints, FIRST_FULL_HOUR } from "../lib/market.ts";
import { loadMarket } from "../lib/market-service.ts";
import archive from "../data/archive.json" with { type: "json" };

const hour = 3_600_000;
const archivedLast = archive.ordinary.at(-1).t;
const archivedCount = archive.ordinary.filter(c => c.t >= FIRST_FULL_HOUR).length;
const candle = (t,c,s="xyz:SKHX") => ({ t, T:t+hour-1, c:String(c), o:String(c), h:String(c), l:String(c), s, i:"1h", v:"1" });
test("one ordinary share equals ten ADRs; USD conversion is not applied twice", () => {
  const [p] = alignCandles([candle(FIRST_FULL_HOUR,1500)], [candle(FIRST_FULL_HOUR,180)], FIRST_FULL_HOUR+hour);
  assert.equal(p.equivalent,150);
  assert.equal(p.spread,30);
  assert.ok(Math.abs(p.premium-20)<1e-10);
});
test("exclude pre-listing, open, missing-side, zero and invalid candles", () => {
  const t=FIRST_FULL_HOUR;
  const ordinary=[candle(t-hour,100),candle(t,100),candle(t+hour,100),candle(t+2*hour,100),candle(t+3*hour,0),candle(t+4*hour,NaN)];
  const adr=[candle(t-hour,10),candle(t,9),candle(t+2*hour,10),candle(t+3*hour,10),candle(t+4*hour,10)];
  assert.equal(alignCandles(ordinary,adr,t+2*hour).length,1);
  assert.equal(alignCandles(ordinary,adr,t+5*hour).length,2);
  assert.ok(alignCandles(ordinary,adr,t+2*hour)[0].premium < 0);
});
test("overlap updates replace archived values and sort ascending", () => {
  const t=FIRST_FULL_HOUR;
  const points=alignCandles([candle(t+hour,100),candle(t,100),candle(t,200)],[candle(t+hour,11),candle(t,22)],t+2*hour);
  assert.equal(points[0].time,t);
  assert.equal(points[0].ordinary,200);
  assert.equal(points.length,2);
});
test("range filtering and daily summaries use data timestamps", () => {
  const points=Array.from({length:240},(_,i)=>({time:FIRST_FULL_HOUR+i*hour,premium:i}));
  assert.equal(selectRange(points,7).length,169);
  assert.equal(selectRange(points,null).length,240);
  const daily=dailyPoints(points);
  assert.equal(daily.at(-1),points.at(-1));
  assert.equal(daily[0],points[9]);
});

test("unchanged candles retain chart inputs while metadata and recovery status update", () => {
  const previous = { points: [{ time: FIRST_FULL_HOUR, adr: 12, ordinary: 100, equivalent: 10, spread: 2, premium: 20 }], fetchedAt: "2026-07-10T16:00:00Z", status: "snapshot" };
  const next = { ...previous, points: structuredClone(previous.points), fetchedAt: "2026-07-10T17:00:00Z", status: "live" };
  const retained = retainHistoryPoints(previous, next);
  assert.equal(retained.points, previous.points);
  assert.equal(retained.status, "live");
  assert.equal(retained.fetchedAt, next.fetchedAt);
  assert.equal(retainHistoryPoints(null, next), next);
});

test("historical corrections, additions and deletions always reach the chart", () => {
  const points = alignCandles([candle(FIRST_FULL_HOUR,100), candle(FIRST_FULL_HOUR+hour,100)], [candle(FIRST_FULL_HOUR,12), candle(FIRST_FULL_HOUR+hour,12)], FIRST_FULL_HOUR+2*hour);
  const previous = { points };
  for (const field of ["time", "adr", "ordinary", "equivalent", "spread", "premium"]) {
    const next = { points: structuredClone(points) };
    next.points[0][field] += 1;
    assert.equal(retainHistoryPoints(previous, next), next);
    assert.notEqual(next.points, previous.points);
  }
  for (const changed of [points.slice(1), [...points, {...points.at(-1), time:FIRST_FULL_HOUR+2*hour}]]) {
    const next = { points: changed };
    assert.equal(retainHistoryPoints(previous, next), next);
  }
});
test("network failure returns actual, completed, timestamped archive",async()=>{
  const data=await loadMarket(async()=>{throw new Error("offline")},Date.parse(archive.fetchedAt)+1_000);
  assert.equal(data.status,"snapshot");
  assert.equal(data.points[0].time,FIRST_FULL_HOUR);
  assert.equal(data.points.length,archivedCount);
  assert.equal(data.points.at(-1).time,archivedLast);
  assert.equal(data.fetchedAt,archive.fetchedAt);
});
test("live history merges into archive; any partial feed failure falls back as a pair",async()=>{
  const t=archivedLast+hour;
  const fetcher=async(_,init)=>{const {req}=JSON.parse(init.body); return Response.json([candle(t,req.coin==="xyz:SKHX"?1500:180,req.coin)]);};
  const live=await loadMarket(fetcher,t+hour);
  assert.equal(live.status,"live");
  assert.equal(live.points.length,archivedCount+1);
  assert.equal(live.points.at(-1).spread,30);
  const failure=await loadMarket(async(url,init)=>JSON.parse(init.body).req.coin==="xyz:SKHY" ? Response.json({error:"rate limit"},{status:429}) : fetcher(url,init),t+hour);
  assert.equal(failure.status,"snapshot");
  assert.equal(failure.points.length,archivedCount);
});
test("gaps and stale quotes are surfaced instead of filled with invented prices",async()=>{
  const t=archivedLast+4*hour;
  const data=await loadMarket(async(_,init)=>{
    const {req}=JSON.parse(init.body);
    return Response.json([candle(t,req.coin==="xyz:SKHX"?1500:180,req.coin)]);
  },t+5*hour);
  assert.equal(data.points.length,archivedCount+1);
  assert.ok(data.warnings.some(w=>w.includes("缺口")));
  assert.ok(data.warnings.some(w=>w.includes("超过 2 小时")));
});
