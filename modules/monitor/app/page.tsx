import MonitorHub from './monitor-hub';
import type { PageProps } from '../web/page-props';

export default function Home(props: PageProps) {
  return <MonitorHub {...props} />;
}
