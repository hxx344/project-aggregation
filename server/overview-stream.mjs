// Each connection starts with a full snapshot. Deltas keep unchanged project data off the wire.
export function createOverviewEncoder() {
  let previous = null, sequence = 0;
  return overview => {
    const current = new Map(overview.projects.map(item => [item.project.id, JSON.stringify(item)]));
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
