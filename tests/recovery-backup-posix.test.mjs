import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createBackup } from '../server/recovery/backup.mjs';
import { acquireRuntimeLock } from '../server/recovery/lifecycle-lock.mjs';
import { readLockedRegistry, readRegistry } from '../server/recovery/inventory.mjs';
import { runRecoveryCli } from '../server/recovery/cli.mjs';

const eligible = process.platform !== 'win32' && process.getuid() === 0;
const serviceUid = Number(process.env.RECOVERY_TEST_SERVICE_UID || 65534);
function actor(directory, code, { root = false } = {}) {
  const writerUrl = pathToFileURL(path.join(path.dirname(directory),'code/account-writer.mjs')).href;
  return spawnSync(process.execPath, ['--input-type=module','-e',code,directory,writerUrl], { cwd:directory, uid:root?0:serviceUid,gid:root?0:serviceUid,windowsHide:true,timeout:15_000,encoding:'utf8',env:{PATH:process.env.PATH,NODE_OPTIONS:'',NODE_PATH:''} });
}
function successful(result) { assert.equal(result.status,0,result.stderr); }
async function fixture(t) {
  assert.ok(Number.isSafeInteger(serviceUid) && serviceUid>0);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-posix-'));fs.chmodSync(root,0o755);
  // The hosted runner checkout may live below a private /home/runner parent.
  // Copy the unmodified builtin-only core into the traversable fixture instead
  // of granting the service UID access to somebody else's home directory.
  const code=path.join(root,'code');fs.mkdirSync(code,{mode:0o755});
  fs.copyFileSync(new URL('../server/execution/account-writer.mjs',import.meta.url),path.join(code,'account-writer.mjs'));
  fs.chmodSync(path.join(code,'account-writer.mjs'),0o644);
  const source=path.join(root,'source');fs.mkdirSync(source,{mode:0o700});fs.chownSync(source,serviceUid,serviceUid);
  const held=[];t.after(async()=>{for(const lock of held)await lock.close();fs.rmSync(root,{recursive:true,force:true});});
  successful(actor(source,`
    import fs from 'node:fs'; import path from 'node:path'; import {randomUUID,randomBytes} from 'node:crypto'; import {DatabaseSync} from 'node:sqlite';
    const directory=process.argv[1], {createAccountWriter}=await import(process.argv[2]);
    const writer=createAccountWriter({databasePath:path.join(directory,'execution-control.sqlite'),moduleId:'hub',runtimeId:randomUUID()});writer.close();
    const db=new DatabaseSync(path.join(directory,'hub.sqlite'));db.exec("PRAGMA journal_mode=WAL; CREATE TABLE witness(id TEXT PRIMARY KEY); INSERT INTO witness VALUES('before')");db.close();fs.chmodSync(path.join(directory,'hub.sqlite'),0o600);
    fs.writeFileSync(path.join(directory,'credentials.key'),randomBytes(32),{mode:0o600});
    for(const id of ['monitor','asset','crossex','greeks','aster'])fs.mkdirSync(path.join(directory,'modules',id),{recursive:true,mode:0o700});
  `));
  const lock=await acquireRuntimeLock({dataDir:source,expectedOwnerUid:serviceUid});held.push(lock);
  return {root,source,lock};
}

test('POSIX root cold inspect/backup leaves service-owned DBs reopenable by the original UID', {skip:!eligible}, async t=>{
  const f=await fixture(t);const before=readRegistry(f.source);
  const interrupted=actor(f.source,`
    import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(path.join(process.argv[1],'hub.sqlite'));db.exec('PRAGMA journal_mode=WAL');
    db.prepare('SELECT count(*) FROM witness').get();db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    process.kill(process.pid,'SIGKILL');
  `,{root:true});
  assert.equal(interrupted.signal,'SIGKILL');
  assert.equal(fs.statSync(path.join(f.source,'hub.sqlite-wal')).size,0);
  for(const suffix of ['-wal','-shm'])assert.equal(fs.statSync(path.join(f.source,'hub.sqlite'+suffix)).uid,0);
  await createBackup({dataDir:f.source,destination:path.join(f.root,'backup'),lock:f.lock,dataKey:randomBytes(32),secretsKey:randomBytes(32),commit:'a'.repeat(40)});
  assert.equal(readRegistry(f.source).state.authorityId,before.state.authorityId);
  for(const name of ['execution-control.sqlite','hub.sqlite']){
    assert.equal(fs.statSync(path.join(f.source,name)).uid,serviceUid);
    for(const suffix of ['-wal','-shm'])assert.equal(fs.existsSync(path.join(f.source,name+suffix)),false);
  }
  successful(actor(f.source,`
    import path from 'node:path';import {randomUUID} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
    const directory=process.argv[1],{createAccountWriter}=await import(process.argv[2]);
    const writer=createAccountWriter({databasePath:path.join(directory,'execution-control.sqlite'),moduleId:'hub',runtimeId:randomUUID()});writer.close();
    const db=new DatabaseSync(path.join(directory,'hub.sqlite'));db.exec("INSERT INTO witness VALUES('after')");if(db.prepare('SELECT count(*) n FROM witness').get().n!==2)throw new Error('missing WAL data');db.close();
  `));
});

test('POSIX root retirement WAL survives SIGKILL and resumes under the original lock without adopting unknown sidecars', {skip:!eligible}, async t=>{
  const f=await fixture(t), database=path.join(f.source,'execution-control.sqlite');
  const killed=actor(f.source,`
    import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(path.join(process.argv[1],'execution-control.sqlite'));db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    const state=JSON.parse(db.prepare("SELECT value FROM aw_meta WHERE key='recovery_state'").get().value);state.state='retired';
    db.prepare("UPDATE aw_meta SET value=? WHERE key='recovery_state'").run(JSON.stringify(state));process.kill(process.pid,'SIGKILL');
  `,{root:true});
  assert.equal(killed.signal,'SIGKILL');
  for(const suffix of ['-wal','-shm']){const info=fs.statSync(database+suffix);assert.equal(info.uid,0);assert.equal(info.mode&0o777,0o600);}
  assert.ok(fs.statSync(database+'-wal').size>0);
  // An immutable main-file read would incorrectly see the old normal gate.
  assert.equal(readRegistry(f.source).state.state,'retired');
  fs.unlinkSync(database+'-shm');
  assert.throws(()=>readRegistry(f.source),/RECOVERY_DATABASE_CHECKPOINT_REQUIRED/);
  assert.throws(()=>readLockedRegistry(f.source,{assertHeld(){}}),/RUNTIME_LOCK_LOST/);
  assert.equal(readLockedRegistry(f.source,f.lock).state.state,'retired');
  for(const suffix of ['-wal','-shm'])assert.equal(fs.existsSync(database+suffix),false);
  successful(actor(f.source,`
    import path from 'node:path';import {randomUUID} from 'node:crypto';const {createAccountWriter}=await import(process.argv[2]);
    try{createAccountWriter({databasePath:path.join(process.argv[1],'execution-control.sqlite'),moduleId:'hub',runtimeId:randomUUID()});throw new Error('retired authority reopened');}
    catch(error){if(error.code!=='AUTHORITY_RETIRED')throw error;}
  `));
  fs.writeFileSync(database+'-wal','',{mode:0o644});
  assert.throws(()=>readRegistry(f.source),/RECOVERY_DATABASE_SIDECAR_OWNER/);assert.equal(fs.statSync(database+'-wal').mode&0o777,0o644);fs.unlinkSync(database+'-wal');
  fs.writeFileSync(database+'-wal','',{mode:0o600});const foreignUid=serviceUid===1?2:1;fs.chownSync(database+'-wal',foreignUid,foreignUid);
  assert.throws(()=>readRegistry(f.source),/RECOVERY_DATABASE_SIDECAR_OWNER/);assert.equal(fs.statSync(database+'-wal').uid,foreignUid);
});

test('POSIX backup CLI accepts the installed root environment mode while keeping both keys private', {skip:!eligible}, async t=>{
  const f=await fixture(t);await f.lock.close();
  const dataFile=path.join(f.root,'data.key'),secretsFile=path.join(f.root,'secrets.key'),environment=path.join(f.root,'root.env');
  const keys=['--data-key-file',dataFile,'--secrets-key-file',secretsFile];await runRecoveryCli(['keys',...keys]);
  fs.writeFileSync(environment,'DATA_DIR='+f.source+'\n',{mode:0o640});
  const args=['backup','--data-dir',f.source,'--owner-uid',String(serviceUid),'--destination',path.join(f.root,'environment-backup'),'--environment-file',environment,...keys];
  // Source checkouts may have no packaged release marker. That refusal occurs
  // after the actual CLI has accepted and parsed the installer-owned 0640 env.
  try { await runRecoveryCli(args); }
  catch(error) { assert.equal(error.code,'RECOVERY_RELEASE_IDENTITY_REQUIRED'); }
  fs.chmodSync(environment,0o644);await assert.rejects(runRecoveryCli(args),{code:'RECOVERY_UNSAFE_INPUT'});
  fs.chmodSync(environment,0o640);fs.chmodSync(dataFile,0o640);await assert.rejects(runRecoveryCli(args),{code:'RECOVERY_UNSAFE_INPUT'});
});
