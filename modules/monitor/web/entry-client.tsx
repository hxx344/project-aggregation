import { hydrateRoot } from 'react-dom/client';
import Home from '../app/page';
import type { PageProps } from './page-props';
import '../app/globals.css';

const container = document.getElementById('root');
const data = document.getElementById('market-initial-data');
if (!container || !data?.textContent) throw new Error('Missing initial page data');
const props: PageProps = JSON.parse(data.textContent);
hydrateRoot(container, <Home {...props} />);
