import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { appRoutes } from './app/routes';
import { RpcError } from './api/client';
import './theme.css';
import './app/base.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx will not fix itself; retrying it only delays the error state.
      retry: (count, err) => count < 2 && !(err instanceof RpcError && err.status >= 400 && err.status < 500),
    },
  },
});

const router = createBrowserRouter(appRoutes());

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
