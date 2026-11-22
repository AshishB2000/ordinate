import { createRoot } from 'react-dom/client';
import { tokenFromPath } from './api';
import { App } from './App';
import './embedAsk.css';

const token = tokenFromPath(window.location.pathname);
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(token ? <App token={token} /> : <main className="page"><p className="problem" role="alert">This link is not valid.</p></main>);
}
