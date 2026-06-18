import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadPersisted, startPersistence } from './core/persistence';
import './index.css';

// Restore the saved track BEFORE the first render so the canvas paints it
// immediately, then start persisting subsequent edits.
loadPersisted();
startPersistence();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
