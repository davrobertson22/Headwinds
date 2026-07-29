import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ConfirmProvider } from '../../../src/components/ConfirmModal.jsx';
import UpdatePrompt from '../../../src/components/UpdatePrompt.jsx';
import './styles.css';

// Brand switch: the shared game UI reads its palette from CSS variables on
// :root. Marking the document as Headwinds lets styles.css re-accent the whole
// game (teal instead of Tailwinds gold) without touching the shared code.
document.documentElement.dataset.brand = 'headwinds';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfirmProvider>
      {/* "A new version is available" banner. This was mounted only in the
          Tailwinds entry point, so Headwinds players — who keep tabs open for
          days — could never be told a new build had shipped. That is how a
          lease-rules deploy reached the server while players carried on with a
          bundle that had no banner, no order-book meter and no disabled
          buttons, and read the resulting rejections as the game eating their
          orders. */}
      <UpdatePrompt />
      <App />
    </ConfirmProvider>
  </React.StrictMode>
);
