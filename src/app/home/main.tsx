import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Home } from './Home';

const container = document.getElementById('home');
if (container) createRoot(container).render(<StrictMode><Home /></StrictMode>);
