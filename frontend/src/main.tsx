import 'leaflet/dist/leaflet.css';
import './styles/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { APP_NAME } from './config';
import { createAppRouter } from './router';
import { routerNavigator } from './routing/navigator';
import { useAppStore } from './store/appStore';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
document.title = APP_NAME;

// One router for the app; the store navigates through it (the URL is the source of navigation truth).
const router = createAppRouter();
useAppStore.getState().setNavigator(routerNavigator(router));

createRoot(root).render(
  <StrictMode>
    {/* Without transitions a route change renders at once, in step with the store the actions update. */}
    <RouterProvider router={router} useTransitions={false} />
  </StrictMode>,
);
