import assert from 'node:assert/strict';
import test from 'node:test';
import { projectWorkspace, workspaceGroups } from '../src/workspace-nav.ts';

const item = (id, category) => ({ project: { id, category } });

test('built-in modules land in their workspace regardless of category', () => {
  assert.equal(projectWorkspace({ id: 'aster', category: 'trading' }), 'strategy');
  assert.equal(projectWorkspace({ id: 'greeks', category: 'trading' }), 'options');
  assert.equal(projectWorkspace({ id: 'crossex', category: 'trading' }), 'trading');
  assert.equal(projectWorkspace({ id: 'monitor', category: 'monitoring' }), 'market');
  assert.equal(projectWorkspace({ id: 'asset', category: 'assets' }), 'overview');
});

test('custom projects fall back to their category, inherited keys are not ids', () => {
  assert.equal(projectWorkspace({ id: 'my-link', category: 'monitoring' }), 'market');
  assert.equal(projectWorkspace({ id: 'notes', category: 'other' }), 'other');
  assert.equal(projectWorkspace({ id: 'toString', category: 'assets' }), 'overview');
});

test('groups follow the plan order, keep project order and hide empty workspaces', () => {
  const groups = workspaceGroups([item('greeks', 'trading'), item('aster', 'trading'), item('crossex', 'trading'), item('x', 'trading'), item('monitor', 'monitoring'), item('asset', 'assets')]);
  assert.deepEqual(groups.map(g => [g.id, g.label, g.views, g.projects.map(p => p.project.id)]), [
    ['overview', '总览与资产', ['overview'], ['asset']],
    ['market', '市场与机会', [], ['monitor']],
    ['trading', '交易中心', ['trading'], ['crossex', 'x']],
    ['strategy', '策略与风险', [], ['aster']],
    ['options', '期权', [], ['greeks']],
    ['onchain', '链上', ['aero'], []],
    ['research', '研究室', ['cost-lab'], []],
  ]);
  assert.deepEqual(workspaceGroups([]).map(g => g.id), ['overview', 'trading', 'onchain', 'research']);
});
