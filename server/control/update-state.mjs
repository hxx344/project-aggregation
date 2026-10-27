// The update coordinator's durable values in the settings table. Kept outside
// server/api, so two API slots of an API-only update read and write them the
// same way (design doc api-dual-slot 3.5).
import { parseUpdateOwner } from './update-owner.mjs';

export function updateSettings({ getSetting, setSetting }) {
  return {
    readMaintenance: () => getSetting('updates-maintenance') === '1',
    writeMaintenance: active => setSetting('updates-maintenance', active ? '1' : '0'),
    readPendingPlanId: () => getSetting('updates-pending-plan') || null,
    writePendingPlanId: planId => setSetting('updates-pending-plan', planId || ''),
    readPendingDeployMode: () => getSetting('updates-pending-deploy-mode') || 'source',
    writePendingDeployMode: mode => setSetting('updates-pending-deploy-mode', mode),
    readAdmissionToken: () => getSetting('updates-admission-token') || '',
    writeAdmissionToken: value => setSetting('updates-admission-token', value),
    readAdmissionOwner: () => parseUpdateOwner(getSetting('updates-admission-owner')),
    writeAdmissionOwner: value => setSetting('updates-admission-owner', value ? JSON.stringify(value) : ''),
  };
}
