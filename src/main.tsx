import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import CapSimulator from './CapSimulator';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CapSimulator />
  </StrictMode>,
);
