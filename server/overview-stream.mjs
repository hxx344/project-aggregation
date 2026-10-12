// Each connection starts with a full snapshot. Deltas keep unchanged project data off the wire.
export function createOverviewEncoder() {
  let previous = null, sequence = 0;
  return overview => {
    // Use structural hash instead of full JSON.stringify for change detection
    const current = new Map(overview.projects.map(item => {
      const proj = item.project;
      const hash = `${proj.revision}:${item.checkedAt}:${item.state}:${item.trend || ''}:${item.needsApproval || ''}`;
      return [proj.id, hash];
    }));
    if (!previous) {
      previous = current;
      return { type: 'snapshot', sequence, ...overview };
    }
    const projects = overview.projects.filter(item => current.get(item.project.id) !== previous.get(item.project.id));
    const order = [...current.keys()];
    const changedOrder = order.join('\0') !== [...previous.keys()].join('\0');
    previous = current;
    if (!projects.length && !changedOrder) return { type: 'heartbeat', sequence, generatedAt: overview.generatedAt };
    return { type: 'patch', baseSequence: sequence, sequence: ++sequence, generatedAt: overview.generatedAt, projects, order };
  };
}
