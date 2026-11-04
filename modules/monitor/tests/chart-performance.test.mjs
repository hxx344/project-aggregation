import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestTimeIndex } from '../modules/oil/chart-performance.mjs';
import { createOilSummaryReader } from '../lib/monitor-summary.ts';

test('nearest observation matches a linear reference including gaps, endpoints and ties', () => {
  const rows = [0,1,3,4,8,12,20].map(time=>({time:time*900_000}));
  assert.equal(nearestTimeIndex([],0),-1);
  for(let time=-900_000;time<=21*900_000;time+=112_500) {
    let expected=0;
    rows.forEach((row,index)=>{if(Math.abs(row.time-time)<Math.abs(rows[expected].time-time))expected=index;});
    assert.equal(nearestTimeIndex(rows,time),expected);
  }
});

test('large-history picking reads a logarithmic number of observations', () => {
  let reads=0;
  const rows=Array.from({length:100_000},(_,i)=>({get time(){reads++;return i*900_000;}}));
  assert.equal(nearestTimeIndex(rows,55_555*900_000+20),55_555);
  assert.ok(reads<30);
});

test('quote updates reuse the oil trend; history corrections and metadata still become visible', () => {
  const read=createOilSummaryReader(), fetchedAt='2026-09-16T00:00:00Z';
  const history={points:[{time:0,value:3},{time:900_000,value:4}],status:'live',fetchedAt};
  const update={status:'live',spread:2,fundingHourlyRate:0,fundingBasis:'quantity',fetchedAt,history};
  const first=read(update), quote=read({...update,spread:2.1});
  assert.equal(first.trend,quote.trend);
  assert.equal(quote.metrics[0].value,'+2.100%');
  const stale=read({...update,history:{...history,status:'stale'}});
  assert.equal(stale.trend.points,first.trend.points);
  assert.equal(stale.trend.status,'stale');
  const correction=read({...update,history:{...history,points:[history.points[0],{time:900_000,value:4.2}]}});
  assert.notEqual(correction.trend.points,first.trend.points);
  assert.equal(correction.trend.points.at(-1).value,4.2);
  const empty=read({...update,history:undefined,status:'error'});
  assert.equal(empty.trend.status,'error');assert.equal(empty.trend.points.length,0);
  assert.equal(createOilSummaryReader()(update).trend.points.at(-1).value,4,'Another mounted panel owns an independent cache');
});
