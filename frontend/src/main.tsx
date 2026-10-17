import 'leaflet/dist/leaflet.css';
import './styles/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { APP_NAME } from './config';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
document.title = APP_NAME;

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
