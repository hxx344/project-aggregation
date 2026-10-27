import path from 'node:path';
import { createUpdateCoordinator, unavailableUpdateState } from '../../server/updates.mjs';
import { openHubDatabase } from '../../server/control/schema.mjs';
import { createControlStore } from '../../server/control/store.mjs';
import { updateSettings } from '../../server/control/update-state.mjs';
import { createExecutionJobsReader } from '../../server/control/execution-jobs.mjs';

// Produce the owner through the real admission transaction, including this
// process's actual birth identity. The parent kills this process at the named
// preflight/send boundary; no fabricated PID or owner JSON is accepted here.
const db = openHubDatabase(path.join(process.env.DATA_DIR, 'hub.sqlite'));
const settings = updateSettings(createControlStore(db));
const phase = process.env.SHARING_OWNER_PHASE;
const forever = new Promise(() => {});
const hold = () => {
  process.send({ type: 'owner-held', phase: settings.readAdmissionOwner()?.phase });
  return forever;
};
const coordinator = createUpdateCoordinator({
  client: { status: async () => unavailableUpdateState(), apply: hold },
  execution: createExecutionJobsReader(db), ...settings,
  prepareApply: phase === 'preparing' ? hold : async () => {}, releasePollMs: 0,
});
process.on('message', () => {});
void coordinator.apply(process.env.SHARING_PLAN_ID, () => {}, 'source').catch(error => {
  process.stderr.write(error.stack + '\n'); process.exitCode = 1; process.disconnect();
});
