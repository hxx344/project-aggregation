import { Activity, FolderKanban, Gauge, Wallet } from 'lucide-react';
import type { Category } from '../types';

export default function ProjectIcon({ category, size = 22 }: { category: Category; size?: number }) {
  return category === 'assets' ? <Wallet size={size} />
    : category === 'monitoring' ? <Activity size={size} />
    : category === 'trading' ? <Gauge size={size} />
    : <FolderKanban size={size} />;
}
