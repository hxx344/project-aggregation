import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateIndicators } from "../lib/indicators.ts";
import { FIRST_FULL_HOUR, selectRange } from "../lib/market.ts";

const hour=3_600_000;
const series=(values)=>values.map((value,i)=>({time:FIRST_FULL_HOUR+i*hour,adr:100+value,ordinary:1000,equivalent:100,spread:value*2,premium:value}));
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test("hand-calculated SMA, population Bollinger bands and Z-score",()=>{
  const points=calculateIndicators(series([1,2,3,4,5]),"premium",{sma:3,bands:5});
  assert.equal(points[1].sma,null);
  assert.equal(points[2].sma,2);
  assert.equal(points[3].basis,null);
  const last=points.at(-1);
  assert.equal(last.sma,4);
  assert.equal(last.basis,3);
  close(last.deviation,Math.sqrt(2));
  close(last.upper,3+2*Math.sqrt(2));
  close(last.lower,3-2*Math.sqrt(2));
  close(last.zscore,Math.sqrt(2));
});

test("zero variance produces flat bands and an undefined Z-score",()=>{
  const last=calculateIndicators(series([8,8,8,8,8]),"premium",{sma:3,bands:5}).at(-1);
  assert.equal(last.sma,8);
  assert.deepEqual(last.band,[8,8]);
  assert.equal(last.deviation,0);
  assert.equal(last.zscore,null);
});

test("7 and 20 natural-day windows require exactly 168 and 480 completed hours",()=>{
  const points=calculateIndicators(series(Array(480).fill(10)),"premium");
  assert.equal(points[166].sma,null);
  assert.equal(points[167].sma,10);
  assert.equal(points[478].basis,null);
  assert.equal(points[479].basis,10);
});

test("a missing hour or invalid observation restarts both warmup windows",()=>{
  const raw=series(Array.from({length:12},(_,i)=>i));
  raw.splice(5,1);
  const points=calculateIndicators(raw,"premium",{sma:3,bands:5});
  assert.equal(points[5].sma,null);
  assert.equal(points[6].sma,null);
  assert.equal(points[7].sma,7);
  assert.equal(points[8].basis,null);
  assert.equal(points[9].basis,8);
  raw[5].premium=NaN;
  const invalid=calculateIndicators(raw,"premium",{sma:3,bands:5});
  assert.equal(invalid[5].sma,null);
  assert.equal(invalid[6].sma,null);
  assert.equal(invalid[8].sma,8);
});

test("range selection keeps earlier warmup history and future data cannot change prior indicators",()=>{
  const raw=series(Array.from({length:700},(_,i)=>Math.sin(i/10)));
  const all=calculateIndicators(raw,"premium");
  const week=selectRange(all,7);
  assert.notEqual(week[0].basis,null);
  assert.deepEqual(week[0],all[all.length-week.length]);
  assert.deepEqual(calculateIndicators(raw.slice(0,600),"premium").at(-1),all[599]);
});

test("switching metric recalculates values without mixing USD and percentage units",()=>{
  const raw=series([1,2,3,4,5]);
  const pct=calculateIndicators(raw,"premium",{sma:3,bands:5}).at(-1);
  const usd=calculateIndicators(raw,"spread",{sma:3,bands:5}).at(-1);
  assert.equal(usd.sma,8);
  assert.equal(usd.basis,6);
  close(usd.upper,pct.upper*2);
  close(usd.zscore,pct.zscore);
  const precise=calculateIndicators(series([1e9+1,1e9+2,1e9+3]),"premium",{sma:2,bands:3}).at(-1);
  close(precise.deviation,Math.sqrt(2/3));
});

// Previous slice/shift implementation, kept as the exact reference for the in-place rewrite.
function referenceIndicators(points,metric,periods){
  let window=[],previous;
  const maxPeriod=Math.max(periods.sma,periods.bands);
  return points.map(point=>{
    const result={...point,sma:null,basis:null,upper:null,lower:null,band:null,zscore:null,deviation:null,consecutiveHours:0};
    if(!Number.isFinite(point.time)||!Number.isFinite(point[metric])){window=[];previous=undefined;return result;}
    if(previous!==undefined&&point.time-previous!==hour) window=[];
    previous=point.time;
    window.push(point[metric]);
    if(window.length>maxPeriod) window.shift();
    result.consecutiveHours=window.length;
    const mean=values=>values[0]+values.reduce((sum,x)=>sum+(x-values[0]),0)/values.length;
    if(window.length>=periods.sma) result.sma=mean(window.slice(-periods.sma));
    if(window.length>=periods.bands){
      const values=window.slice(-periods.bands),basis=mean(values);
      const deviation=Math.sqrt(values.reduce((sum,x)=>sum+(x-basis)**2,0)/values.length);
      Object.assign(result,{basis,deviation,lower:basis-2*deviation,upper:basis+2*deviation});
      result.band=[result.lower,result.upper];
      result.zscore=deviation>0?(point[metric]-basis)/deviation:null;
    }
    return result;
  });
}

test("in-place windows match the previous implementation exactly across gaps, invalid values and flat runs",()=>{
  let seed=7;
  const random=()=>(seed=(seed*16807)%2147483647)/2147483647;
  const values=Array.from({length:4_000},(_,i)=>i>=900&&i<1_500?42.125:Math.sin(i/41)*30+random()*1e-3+1e6*(i%997===0));
  const points=series(values).filter((_,i)=>i%1_237!==5).map((point,i)=>i===2_222?{...point,premium:Number.NaN,spread:Infinity}:point);
  for(const metric of ["premium","spread"]) for(const periods of [{sma:168,bands:480},{sma:480,bands:168},{sma:2,bands:2},{sma:3,bands:5}]){
    assert.deepEqual(calculateIndicators(points,metric,periods),referenceIndicators(points,metric,periods));
  }
});
