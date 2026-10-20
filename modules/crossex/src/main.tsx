import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { trustedHubOrigin } from './hub-bridge';
import './styles.css';

// Set before the first render so the duplicated brand header never flashes inside the workbench.
if (trustedHubOrigin(window.location, window.parent !== window)) document.documentElement.classList.add('hub-embedded');

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
