import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ASSETS, DAY } from '../modules/oil/hyperliquid.mjs';
import { HOUR, pairFundingHistory, validateFundingRows, dailyFundingRates, analyzeFundingRange, createFundingSnapshot, fetchFundingHistory, fetchFundingSnapshot } from '../modules/oil/funding-history.mjs';

const start = Date.UTC(2026, 2, 4);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const record = (coin, time, rate) => ({ coin, time, fundingRate: String(rate) });
const saved = JSON.parse(await readFile(new URL('../public/oil/data/hyperliquid-funding-2026.json', import.meta.url), 'utf8'));

test('full archived history includes every settled hour and matches verified API values', () => {
  const snapshot = createFundingSnapshot(saved.data, saved.metadata.fetchedAt);
  assert.ok(snapshot.metadata.pairedObservationRows >= 4561);
  assert.ok(snapshot.metadata.wtiObservationRows >= 4577);
  assert.equal(snapshot.metadata.firstSettlementTime, Date.UTC(2026, 2, 4, 16));
  const paired = snapshot.data.filter(row => row.brent !== null && row.wti !== null && row.time <= Date.UTC(2026, 8, 10, 16));
  paired.slice(1).forEach((row, i) => assert.equal(row.time - paired[i].time, HOUR));
  near((paired[0].brent - paired[0].wti) / 2, 0.0000606017);
  near((paired.at(-1).brent - paired.at(-1).wti) / 2, -0.0000288957);
});

test('pairing groups delayed settlement blocks by UTC hour without mixing adjacent hours', () => {
  const result = pairFundingHistory(
    [record(ASSETS.brent.coin, start + 11, .001), record(ASSETS.brent.coin, start + HOUR + 200, .003)],
    [record(ASSETS.wti.coin, start + 34, .002), record(ASSETS.wti.coin, start + 2 * HOUR + 5, .004)],
    start + 3 * HOUR
  );
  assert.deepEqual(result, [{time:start,brent:.001,wti:.002},{time:start+HOUR,brent:.003,wti:null},{time:start+2*HOUR,brent:null,wti:.004}]);
  const daily = dailyFundingRates(result);
  assert.equal(daily[0].count, 1);
  near(daily[0].shortRate, -.0005);
  near(daily[0].longRate, .0005);
});

test('daily points are means of paired hourly rates, not daily sums or filled 24-hour averages', () => {
  const daily = dailyFundingRates([
    {time:start+23*HOUR,brent:.003,wti:.001},
    {time:start+DAY,brent:.001,wti:.005},
    {time:start+DAY+HOUR,brent:.002,wti:.002},
    {time:start+DAY+2*HOUR,brent:null,wti:.1}
  ]);
  assert.deepEqual(daily.map(row => [row.date,row.count]), [['2026-03-04',1],['2026-03-05',2]]);
  near(daily[0].shortRate, .001);
  near(daily[1].shortRate, -.001);
  near(daily[1].longRate, .001);
  near(daily[1].brentRate, .0015);
  near(daily[1].wtiRate, .0035);
});

test('real partial first and last days retain their actual sample count', () => {
  const daily = dailyFundingRates(validateFundingRows(saved.data));
  assert.ok(daily.length >= 191);
  assert.equal(daily[0].count, 8);
  assert.ok(daily.find(row => row.date === '2026-09-10').count >= 17);
  assert.equal(daily.filter(row => row.date < '2026-09-10' && row.count === 24).length, 189);
  assert.equal(daily.reduce((sum, row) => sum + row.count, 0), saved.metadata.pairedObservationRows);
  for (const row of daily) near(row.longRate, -row.shortRate);
});

test('funding data validation rejects empty rates, conflicting duplicates, wrong coins and future points', () => {
  const b = record(ASSETS.brent.coin, start + 10, .001), w = record(ASSETS.wti.coin, start + 10, .002);
  assert.throws(() => pairFundingHistory([{...b,fundingRate:''}],[w],start+HOUR));
  assert.throws(() => pairFundingHistory([b,{...b,fundingRate:'.004'}],[w],start+HOUR));
  assert.throws(() => pairFundingHistory([{...b,coin:'xyz:WTIOIL'}],[w],start+HOUR));
  assert.deepEqual(pairFundingHistory([b],[w],start), []);
  assert.throws(() => validateFundingRows([{time:start,brent:null,wti:null}]));
  assert.throws(() => validateFundingRows([{time:start,brent:undefined,wti:.001}]));
  assert.throws(() => validateFundingRows([{time:start,brent:.001,wti:.002},{time:start,brent:.001,wti:.002}]));
});

test('pagination reads more than 500 rows and continues through a short page until an empty page', async () => {
  const source = Array.from({length:1105},(_,i) => record(ASSETS.brent.coin,start+i*HOUR+11,.001));
  const requests=[];
  const result=await fetchFundingHistory(ASSETS.brent.coin,start,start+1106*HOUR,{fetcher:async(_url,options)=>{
    const request=JSON.parse(options.body); requests.push(request);
    const limit=requests.length===2?250:500;
    return {ok:true,json:async()=>source.filter(row=>row.time>=request.startTime&&row.time<=request.endTime).slice(0,limit)};
  }});
  assert.equal(result.length,1105);
  assert.equal(requests.length,4);
  assert.equal(requests[1].startTime,source[499].time+1);
  assert.equal(requests[2].startTime,source[749].time+1);
  assert.equal(new Set(result.map(row=>row.time)).size,1105);
});

test('a server repeating the previous page fails rather than looping or claiming complete history', async () => {
  const row=record(ASSETS.brent.coin,start+11,.001);
  let count=0;
  await assert.rejects(()=>fetchFundingHistory(ASSETS.brent.coin,start,start+HOUR,{fetcher:async()=>{count++;return{ok:true,json:async()=>[row]};}}),/did not advance/);
  assert.equal(count,2);
});

test('incremental refresh preserves old valid history and fills a newly available counterpart', async () => {
  const existing=createFundingSnapshot([{time:start,brent:.001,wti:.002},{time:start+HOUR,brent:null,wti:.004}],new Date(start+2*HOUR).toISOString());
  const data={
    [ASSETS.brent.coin]:[record(ASSETS.brent.coin,start+HOUR+11,.003)],
    [ASSETS.wti.coin]:[record(ASSETS.wti.coin,start+2*HOUR+11,.005)]
  };
  const refreshed=await fetchFundingSnapshot(existing,{fetcher:async(_url,options)=>{
    const request=JSON.parse(options.body);
    return{ok:true,json:async()=>data[request.coin].filter(row=>row.time>=request.startTime&&row.time<=request.endTime)};
  }});
  assert.equal(refreshed.data.length,3);
  assert.deepEqual(refreshed.data[0],existing.data[0]);
  assert.deepEqual(refreshed.data[1],{time:start+HOUR,brent:.003,wti:.004});
  assert.equal(refreshed.metadata.pairedObservationRows,2);
  assert.equal(refreshed.data[2].brent,null);
  assert.equal(existing.data[1].brent,null);
});

test('a failed history leg rejects refresh without mutating the retained snapshot', async () => {
  const existing=createFundingSnapshot([{time:start,brent:.001,wti:.002}],new Date(start+HOUR).toISOString());
  const before=JSON.stringify(existing);
  await assert.rejects(()=>fetchFundingSnapshot(existing,{fetcher:async(_url,options)=>{
    const request=JSON.parse(options.body);
    return request.coin===ASSETS.brent.coin?{ok:true,json:async()=>[]}:{ok:false,status:500};
  }}),/HTTP 500/);
  assert.equal(JSON.stringify(existing),before);
});

test('cumulative annualization weights actual hours, resets at range start and mirrors long/short', () => {
  const rows = [{time:start-HOUR,brent:.5,wti:0},{time:start+23*HOUR,brent:.003,wti:.001},{time:start+DAY,brent:.001,wti:.005},{time:start+DAY+HOUR,brent:.002,wti:.002},{time:start+2*DAY,brent:.5,wti:0}];
  const result = analyzeFundingRange(rows, '2026-03-04', '2026-03-05');
  assert.equal(result.count, 3);
  assert.equal(result.expectedHours, 48);
  near(result.shortCumulative, -.001);
  near(result.shortAnnualized, -.001 / 3 * 8760);
  near(result.longAnnualized, -result.shortAnnualized);
  near(result.longCumulative, -result.shortCumulative);
  near(result.points[0].shortAnnualized, .001 * 8760);
  assert.deepEqual(result.points.map(row => row.cumulativeCount), [1,3]);
  const second = analyzeFundingRange(rows, '2026-03-05', '2026-03-05');
  near(second.shortCumulative, -.002);
  near(second.shortAnnualized, -.002 / 2 * 8760);
  assert.equal(second.expectedHours, 24);
});

test('date-interval accumulation includes all funding dates and discloses one-leg and whole-hour gaps', () => {
  const rows = [{time:start,brent:.001,wti:0},{time:start+HOUR,brent:.9,wti:null},{time:start+2*DAY,brent:0,wti:.001}];
  const result = analyzeFundingRange(rows,'2026-03-04','2026-03-06');
  assert.deepEqual(result.points.map(row => row.date), ['2026-03-04','2026-03-06']);
  assert.equal(result.count, 2);
  assert.equal(result.missingHours, 70);
  near(result.shortCumulative, 0);
  near(result.shortAnnualized, 0);
});

test('empty, zero and single-hour intervals stay distinct and invalid calculations fail', () => {
  const empty = analyzeFundingRange([], '2026-03-04','2026-03-04');
  assert.equal(empty.shortAnnualized, null);
  assert.equal(empty.shortCumulative, null);
  assert.equal(empty.count, 0);
  assert.equal(empty.missingHours, 24);
  const single = analyzeFundingRange([{time:start,brent:0,wti:0}], '2026-03-04','2026-03-04');
  assert.equal(single.shortAnnualized, 0);
  assert.equal(single.count, 1);
  assert.throws(() => analyzeFundingRange([], '2026-02-30','2026-03-04'), /Invalid funding date range/);
  assert.throws(() => analyzeFundingRange([], '2026-03-05','2026-03-04'), /Invalid funding date range/);
  assert.throws(() => analyzeFundingRange([{time:start,brent:Number.MAX_VALUE,wti:-Number.MAX_VALUE}], '2026-03-04','2026-03-04'), /overflow/);
});

test('archived interval cumulative returns equal an independent sum of actual hourly settlements', () => {
  const from='2026-08-10',through='2026-09-09';
  const paired=saved.data.filter(row => row.time>=Date.parse(from) && row.time<Date.parse(through)+DAY && row.brent!==null && row.wti!==null);
  const sum=paired.reduce((value,row)=>value+(row.brent-row.wti)/2,0);
  const result=analyzeFundingRange(saved.data,from,through);
  assert.equal(result.count,31*24);
  assert.equal(result.missingHours,0);
  near(result.shortCumulative,sum);
  near(result.shortAnnualized,sum/paired.length*8760);
  near(result.points.at(-1).shortAnnualized,result.shortAnnualized);
});
