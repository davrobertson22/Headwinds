import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Brand switch: the shared game UI reads its palette from CSS variables on
// :root. Marking the document as Headwinds lets styles.css re-accent the whole
// game (teal instead of Tailwinds gold) without touching the shared code.
document.documentElement.dataset.brand = 'headwinds';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
